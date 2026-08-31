import { existsSync } from "fs";
import { getBoard } from "./board-store";
import { startRpcSession } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { assignSessionToTask } from "./task-store";
import { PRESET_FULL } from "./tool-presets";
import {
  countRunningDispatched,
  listDispatchableCards,
  listRunningDispatched,
  updateCard,
  type TaskCard,
} from "./task-card-store";

// ============================================================================
// 任务卡调度器（S2 happy path）
// 定时从看板捞「就绪=待办 & 未开始/失败且未超重试 & 无未完成前置」的卡，
// 派发专属执行会话（FULL 工具），发任务描述 → execStatus=running。
// 本轮只做正常流程：失败重试 / 巡检 / 审核 / 待回答队列（S3）后续再接。
// 并发闸门只约束调度器自动派发（默认 1）；手动 run 走前台，不占闸门。
// ============================================================================

export const TASK_SCHEDULER_INTERVAL_MS = 10_000;
export const TASK_SCHEDULER_MAX_CONCURRENCY = 1;

declare global {
  var __piTaskScheduler: { timer: ReturnType<typeof setInterval>; startedAt: number } | undefined;
}

/** 派发 cwd：card.cwd 优先；否则看板所属项目根（project_key 若是存在的目录）。 */
export function resolveDispatchCwd(card: TaskCard): string | null {
  if (card.cwd) return card.cwd;
  const board = getBoard(card.boardId);
  if (board && existsSync(board.projectKey)) return board.projectKey;
  return null;
}

/** 拼任务 prompt：任务编号+名称 + 描述（markdown）+ 附件引用。 */
export function buildTaskPrompt(card: TaskCard): string {
  const lines = [`【任务卡 #${card.number}】${card.name}`];
  if (card.description.trim()) {
    lines.push("", card.description.trim());
  }
  if (card.attachments.length > 0) {
    lines.push("", "附件：");
    for (const a of card.attachments) lines.push(`- ${a}`);
  }
  return lines.join("\n");
}

/**
 * 确保拿到执行会话：卡已有 sessionId → 复用（重试场景）；否则新建。
 * 新建时 cwd 解析失败返回 null（无法派发）。
 */
async function ensureExecutionSession(
  card: TaskCard,
): Promise<{ session: Awaited<ReturnType<typeof startRpcSession>>["session"]; realSessionId: string } | null> {
  if (card.sessionId) {
    try {
      const filePath = await resolveSessionPath(card.sessionId);
      if (filePath) {
        return await startRpcSession(card.sessionId, filePath, undefined);
      }
    } catch {
      // 会话文件失效 → 走新建
    }
  }
  const cwd = resolveDispatchCwd(card);
  if (!cwd) return null;
  return await startRpcSession("", "", cwd, { toolNames: PRESET_FULL });
}

/** 派发单卡：建/复执行会话 → 命名 #N 标题 → 任务看板归属 → node 绑 session → 发 prompt → running。 */
export async function dispatchCard(card: TaskCard): Promise<boolean> {
  try {
    const session = await ensureExecutionSession(card);
    if (!session) {
      console.warn(`[task-scheduler] #${card.number} ${card.name} 无可用 cwd，跳过派发`);
      return false;
    }

    await session.session.send({ type: "set_session_name", name: `#${card.number} ${card.name}` });

    const board = getBoard(card.boardId);
    if (board?.taskId) {
      assignSessionToTask(session.realSessionId, board.taskId);
    }
    // 注意：不 bind 执行会话到 taskcard node —— bindNodeToSession 会覆盖 node.ref_id（=cardId），
    // 导致 getNodeByRefId/水合拿不到卡、刷新后卡从画布消失。会话绑定已在卡上行存（sessionId）。

    await session.session.send({ type: "prompt", message: buildTaskPrompt(card) });

    updateCard(card.id, { sessionId: session.realSessionId, execStatus: "running" });
    console.log(
      `[task-scheduler] 派发 #${card.number} ${card.name} → session ${session.realSessionId.slice(0, 8)}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[task-scheduler] 派发 #${card.number} ${card.name} 失败:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** 单轮调度：并发闸门未满才派发；最多补满到全局上限。返回本轮派发数。 */
export async function runSchedulerTick(): Promise<number> {
  let dispatched = 0;
  const running = countRunningDispatched();
  const slots = Math.max(0, TASK_SCHEDULER_MAX_CONCURRENCY - running);
  if (slots <= 0) {
    lastAction = { type: "skipped_gate", at: Date.now() };
    return 0;
  }

  const cards = listDispatchableCards().slice(0, slots);
  for (const card of cards) {
    // 并发闸门按 running 数实时判断（上一张派发后 running 可能已满）
    if (countRunningDispatched() >= TASK_SCHEDULER_MAX_CONCURRENCY) break;
    const ok = await dispatchCard(card);
    if (ok) {
      dispatched += 1;
      lastAction = { type: "dispatch", cardNumber: card.number, cardName: card.name, at: Date.now() };
    }
  }
  return dispatched;
}

/** 启动调度器（instrumentation 注册；globalThis 防热重载重复启动）。 */
export function startTaskScheduler(): void {
  if (globalThis.__piTaskScheduler) return;
  const timer = setInterval(() => {
    void runSchedulerTick().catch((error) => {
      console.error("[task-scheduler] tick error:", error instanceof Error ? error.message : error);
    });
  }, TASK_SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  globalThis.__piTaskScheduler = { timer, startedAt: Date.now() };
  console.log(`[pi-web] task scheduler started (interval ${TASK_SCHEDULER_INTERVAL_MS}ms, max ${TASK_SCHEDULER_MAX_CONCURRENCY})`);
}

// 测试用：手工触发一轮

// ============================================================================
// 调度状态（看板展示：调度器在执行什么）
// ============================================================================

export interface TaskSchedulerLastAction {
  /** dispatch=派发了任务；skipped_gate=本轮并发闸门满，跳过；none=尚未动作 */
  type: "dispatch" | "skipped_gate" | "none";
  cardNumber?: number;
  cardName?: string;
  at: number;
}

export interface TaskSchedulerStatus {
  /** 调度器是否已启动（in-process interval 活着） */
  started: boolean;
  /** 调度器派发且正在运行的卡（列表可能为空=当前无调度执行） */
  running: TaskCard[];
  /** 最近一次调度动作 */
  lastAction: TaskSchedulerLastAction;
}

let lastAction: TaskSchedulerLastAction = { type: "none", at: 0 };

/** 当前调度器状态：运行中的卡 + 最近动作。UI 轮询展示「正在运行 xxx任务」。 */
export function getSchedulerStatus(): TaskSchedulerStatus {
  return {
    started: Boolean(globalThis.__piTaskScheduler),
    running: listRunningDispatched(),
    lastAction,
  };
}
