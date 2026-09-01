import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { getBoard } from "./board-store";
import { startRpcSession, getRunningRpcSessionIds } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { assignSessionToTask } from "./task-store";
import { PRESET_FULL } from "./tool-presets";
import {
  countRunningDispatched,
  listDispatchableCards,
  listRunningDispatched,
  listCardsByExecStatus,
  listAnswerableQuestions,
  createQuestion,
  getCard,
  updateCard,
  type TaskCard,
  type TaskCardQuestion,
} from "./task-card-store";
import {
  readSessionAuditSnapshot,
  runAuditVerdict,
  runBlockCheck,
} from "./audit-session";

// ============================================================================
// 任务卡调度器（S2 happy path）
// 定时从看板捞「就绪=待办 & 未开始/失败且未超重试 & 无未完成前置」的卡，
// 派发专属执行会话（FULL 工具），发任务描述 → execStatus=running。
// 本轮只做正常流程：失败重试 / 巡检 / 审核 / 待回答队列（S3）后续再接。
// 并发闸门只约束调度器自动派发（默认 1）；手动 run 走前台，不占闸门。
// ============================================================================

export const TASK_SCHEDULER_INTERVAL_MS = 10_000;
export const TASK_SCHEDULER_MAX_CONCURRENCY = 1;

// ============================================================================
// S3 巡检/审核参数
// ============================================================================

/** 阻塞检测阈值：最后一条消息超过该时长无进展 → 触发 AI 判定 */
export const BLOCK_IDLE_MS = 5 * 60 * 1000;
/** 每卡阻塞判定冷却：冷却期内不重复判同一卡 */
export const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

/** 阻塞判定冷却表（模块级即可：仅节流，热重载重置无害） */
const blockCheckAt = new Map<string, number>();

/** 审核冷却：review 卡 AI 判定未决（other/失败）时，冷却期内不重复审核（防每 10s 烧一次模型） */
export const AUDIT_COOLDOWN_MS = 5 * 60 * 1000;
const reviewAuditAt = new Map<string, number>();

/** 会话静默期兜底：running 卡会话不在跑但最后活动距今不足该值时，视为刚结束未及事件订阅（防派发启动竞态） */
export const SESSION_SETTLE_MS = 5_000;

declare global {
  var __piTaskScheduler: {
    timer: ReturnType<typeof setInterval>;
    startedAt: number;
    /** 最近一次调度动作（挂 globalThis 防 instrumentation 与 API 路由加载两份模块实例不互通） */
    lastAction: TaskSchedulerLastAction;
  } | undefined;
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
 * 新建时 cwd 解析失败返回 null（无法派发）。created 标记是否真正新建
 * （仅新建会话失败时需清理，复用会话归调用方/他处管理，不可销毁）。
 */
async function ensureExecutionSession(
  card: TaskCard,
): Promise<{ session: Awaited<ReturnType<typeof startRpcSession>>["session"]; realSessionId: string; created: boolean } | null> {
  if (card.sessionId) {
    try {
      const filePath = await resolveSessionPath(card.sessionId);
      if (filePath) {
        const reused = await startRpcSession(card.sessionId, filePath, undefined);
        return { ...reused, created: false };
      }
    } catch {
      // 会话文件失效 → 走新建
    }
  }
  const cwd = resolveDispatchCwd(card);
  if (!cwd) return null;
  // 指定会话 ID：调度器创建的执行会话 ID 在发起时即确定，绑定无需等待 realSessionId。
  const fresh = await startRpcSession(randomUUID(), "", cwd, { toolNames: PRESET_FULL });
  return { ...fresh, created: true };
}

/** 派发单卡：建/复执行会话 → 命名 #N 标题 → 任务看板归属 → node 绑 session → 发 prompt → running。 */
export async function dispatchCard(card: TaskCard): Promise<boolean> {
  let ensured: { session: Awaited<ReturnType<typeof startRpcSession>>["session"]; realSessionId: string; created: boolean } | null = null;
  try {
    ensured = await ensureExecutionSession(card);
    if (!ensured) {
      console.warn(`[task-scheduler] #${card.number} ${card.name} 无可用 cwd，跳过派发`);
      return false;
    }
    const session = ensured;

    await session.session.send({ type: "set_session_name", name: `#${card.number} ${card.name}` });

    const board = getBoard(card.boardId);
    if (board?.taskId) {
      assignSessionToTask(session.realSessionId, board.taskId);
    }

    // 会话正忙（已在流式/处理中）：说明上一轮已发过 prompt，直接标 running，不重复发
    if (session.session.isRunning()) {
      updateCard(card.id, { sessionId: session.realSessionId, execStatus: "running" });
      watchForAgentEnd(card, session.session);
      console.log(`[task-scheduler] #${card.number} ${card.name} 会话忙（复用中），标 running 不重发`);
      return true;
    }

    await session.session.send({ type: "prompt", message: buildTaskPrompt(card) });

    updateCard(card.id, { sessionId: session.realSessionId, execStatus: "running" });
    watchForAgentEnd(card, session.session);
    console.log(
      `[task-scheduler] 派发 #${card.number} ${card.name} → session ${session.realSessionId.slice(0, 8)}`,
    );
    return true;
  } catch (error) {
    // 派发失败（命名/prompt 抛错等）：仅销毁本轮新建的会话，防反复失败泄漏；复用会话保留。
    if (ensured?.created) {
      try {
        ensured.session.destroy();
      } catch {
        // 销毁失败不影响派发结果上报
      }
    }
    console.error(
      `[task-scheduler] 派发 #${card.number} ${card.name} 失败:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * 订阅执行会话 agent_end：会话跑完立即把卡转 review（待审核），不等下一轮 reconcile。
 * 事件驱动实现「会话执行完立即进入待审核」。回调只处理卡仍为 running 的情况，避免覆盖后续流转。
 */
function watchForAgentEnd(card: TaskCard, session: Awaited<ReturnType<typeof startRpcSession>>["session"]): void {
  if (typeof session.onEvent !== "function") return;
  const unsub = session.onEvent((event) => {
    if (event.type !== "agent_end") return;
    unsub();
    const fresh = getCard(card.id);
    if (!fresh || fresh.execStatus !== "running") return;
    updateCard(card.id, { execStatus: "review" });
    console.log(`[task-scheduler] #${card.number} ${card.name} 执行会话结束(agent_end) → review（待审核）`);
  });
}

/**
 * 巡检：running 卡若执行会话已不在真实运行（AI 会话结束/销毁）→ 转 review（会话结束待审核）。
 * 以真实 pi 会话执行状态为准，防止卡状态 stale 锁死并发闸门。
 * 兜底：事件订阅（agent_end）之外的场景（进程重启/订阅丢失）靠本巡检，静默期防派发启动竞态。
 * 返回本次流转数。
 */
export async function reconcileEndedRunningCards(): Promise<number> {
  const runningIds = new Set(getRunningRpcSessionIds());
  const now = Date.now();
  let flipped = 0;
  for (const card of listRunningDispatched()) {
    if (!card.sessionId) continue;
    // 会话真实在跑 → 保持 running
    if (runningIds.has(card.sessionId)) continue;
    // 会话不在跑：确认已静默一段时间（防回合间隙误判），才转 review
    const snapshot = await readSessionAuditSnapshot(card.sessionId);
    if (!snapshot || snapshot.lastActivityMs === 0) continue;
    if (now - snapshot.lastActivityMs < SESSION_SETTLE_MS) continue;
    updateCard(card.id, { execStatus: "review" });
    console.log(`[task-scheduler] #${card.number} ${card.name} 执行会话已结束 → review（待审核）`);
    flipped += 1;
  }
  return flipped;
}

/** 单轮调度：并发闸门未满才派发；最多补满到全局上限。返回本轮派发数。 */
export async function runSchedulerTick(): Promise<number> {
  // 先巡检：会话已结束的 running 卡流转走（review），释放闸门（以真实会话状态为准）
  await reconcileEndedRunningCards();
  // S3：回复队列优先 → 审核 review 卡 → 巡检阻塞
  await processReplyQueue();
  await processReviewCards();
  await checkRunningCardsBlocked();

  let dispatched = 0;
  const running = countRunningDispatched();
  const slots = Math.max(0, TASK_SCHEDULER_MAX_CONCURRENCY - running);
  if (slots <= 0) {
    setLastAction({ type: "skipped_gate", at: Date.now() });
    return 0;
  }

  const cards = listDispatchableCards().slice(0, slots);
  for (const card of cards) {
    // 并发闸门按 running 数实时判断（上一张派发后 running 可能已满）
    if (countRunningDispatched() >= TASK_SCHEDULER_MAX_CONCURRENCY) break;
    const ok = await dispatchCard(card);
    if (ok) {
      dispatched += 1;
      setLastAction({ type: "dispatch", cardNumber: card.number, cardName: card.name, at: Date.now() });
    }
  }
  return dispatched;
}

// ============================================================================
// S3：回复队列 + 审核（review 卡）+ 阻塞巡检（running 卡）
// ============================================================================

/** 回复队列：answered 且卡仍在 waiting_reply → 发回复续会话 → running。 */
export async function processReplyQueue(): Promise<number> {
  let resumed = 0;
  for (const q of listAnswerableQuestions()) {
    const card = getCard(q.cardId);
    if (!card || card.execStatus !== "waiting_reply" || !card.sessionId) continue;
    if (countRunningDispatched() >= TASK_SCHEDULER_MAX_CONCURRENCY) break;
    const ok = await resumeWithAnswer(card, q);
    if (ok) {
      resumed += 1;
      setLastAction({ type: "resume", cardNumber: card.number, cardName: card.name, at: Date.now() });
    }
  }
  return resumed;
}

async function resumeWithAnswer(card: TaskCard, q: TaskCardQuestion): Promise<boolean> {
  try {
    const filePath = await resolveSessionPath(card.sessionId!);
    if (!filePath) return false;
    const { session } = await startRpcSession(card.sessionId!, filePath, undefined);
    await session.send({
      type: "prompt",
      message: `【用户回答了你的提问】\n${q.answer}\n\n请据此继续完成任务。`,
    });
    updateCard(card.id, { execStatus: "running" });
    console.log(`[task-scheduler] 回复续会话 #${card.number} ${card.name}`);
    return true;
  } catch (error) {
    console.error(
      `[task-scheduler] 回复续会话失败 #${card.number}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** 失败记次：retry+1；未超上限 → not_started（等下轮调度重试），否则 failed。 */
function markFailedOrRetry(card: TaskCard): void {
  const next = card.retryCount + 1;
  if (next < card.maxRetries) {
    updateCard(card.id, { execStatus: "not_started", retryCount: next });
    console.log(`[task-scheduler] #${card.number} 失败（${next}/${card.maxRetries}）→ 待重试`);
  } else {
    updateCard(card.id, { execStatus: "failed", retryCount: next });
    console.log(`[task-scheduler] #${card.number} 失败（${next}/${card.maxRetries}）→ failed`);
  }
}

/** 进入等回复：卡 → waiting_reply + 提问入待回答队列。 */
function enterWaitingReply(card: TaskCard, questionHint: string): void {
  updateCard(card.id, { execStatus: "waiting_reply" });
  if (card.sessionId) {
    createQuestion(card.id, card.sessionId, `AI 需要你回答后继续任务。\n${questionHint.slice(0, 500)}`);
  }
  console.log(`[task-scheduler] #${card.number} → waiting_reply（提问入队）`);
}

/** 审核 review 卡：程序检测失败→failed；否则 AI 审核 → done/failed/waiting_reply/other。 */
export async function processReviewCards(): Promise<number> {
  const now = Date.now();
  let processed = 0;
  for (const card of listCardsByExecStatus(["review"])) {
    const snapshot = card.sessionId ? await readSessionAuditSnapshot(card.sessionId) : null;

    // 1. 程序检测：最后消息有失败迹象 → 直接 failed（计次重试）
    if (snapshot?.failure) {
      markFailedOrRetry(card);
      processed += 1;
      continue;
    }
    // 2. 无会话 → 视为完成（空执行）
    if (!card.sessionId || !snapshot) {
      updateCard(card.id, { execStatus: "done" });
      console.log(`[task-scheduler] #${card.number} 无执行内容 → done`);
      processed += 1;
      continue;
    }
    // 3. AI 独立审核（冷却：未决时冷却期内不重复烧模型）
    const lastAudit = reviewAuditAt.get(card.id) ?? 0;
    if (now - lastAudit < AUDIT_COOLDOWN_MS) continue;
    reviewAuditAt.set(card.id, now);
    const cwd = resolveDispatchCwd(card);
    if (!cwd) continue;
    const result = await runAuditVerdict({
      cwd,
      cardNumber: card.number,
      cardName: card.name,
      taskDescription: card.description,
      recentMessages: snapshot.recentText,
    });
    if (result?.verdict === "done") {
      updateCard(card.id, { execStatus: "done" });
      console.log(`[task-scheduler] #${card.number} 审核通过 → done（${result.reason}）`);
      processed += 1;
    } else if (result?.verdict === "failed") {
      markFailedOrRetry(card);
      processed += 1;
    } else if (result?.verdict === "waiting_reply") {
      enterWaitingReply(card, snapshot.recentText);
      processed += 1;
    } else {
      console.log(
        `[task-scheduler] #${card.number} 审核未决：${result ? result.reason : "AI 判定失败"}（保持 review）`,
      );
    }
  }
  return processed;
}

/** running 卡阻塞巡检：最后消息 > BLOCK_IDLE_MS 无进展 → AI 判定阻塞类型 → 处置。 */
export async function checkRunningCardsBlocked(): Promise<number> {
  const now = Date.now();
  let handled = 0;
  for (const card of listCardsByExecStatus(["running"])) {
    if (!card.sessionId) continue;
    // 冷却：同一卡冷却期内不重复判定
    const last = blockCheckAt.get(card.id) ?? 0;
    if (now - last < BLOCK_COOLDOWN_MS) continue;
    const snapshot = await readSessionAuditSnapshot(card.sessionId);
    if (!snapshot || snapshot.lastActivityMs === 0) continue;
    // 5min 内还有进展 → 继续观察
    if (now - snapshot.lastActivityMs < BLOCK_IDLE_MS) continue;
    blockCheckAt.set(card.id, now);
    const cwd = resolveDispatchCwd(card);
    if (!cwd) continue;
    const result = await runBlockCheck({
      cwd,
      cardNumber: card.number,
      cardName: card.name,
      taskDescription: card.description,
      recentMessages: snapshot.recentText,
    });
    if (!result) continue;
    switch (result.kind) {
      case "sync_server":
      case "infinite_loop":
        await abortAndReguide(card);
        handled += 1;
        break;
      case "rate_limit":
        console.log(`[task-scheduler] #${card.number} 限流退避，继续观察`);
        break;
      case "asking":
        enterWaitingReply(card, snapshot.recentText);
        handled += 1;
        break;
      case "error":
        // 转 review 由审核路径判定失败/重试
        updateCard(card.id, { execStatus: "review" });
        handled += 1;
        break;
      case "normal":
        // 长任务，继续观察
        break;
    }
  }
  return handled;
}

/** 阻塞处置：abort 会话 + 重发 tmux 引导 → 保持 running。 */
async function abortAndReguide(card: TaskCard): Promise<void> {
  try {
    if (card.sessionId) {
      const filePath = await resolveSessionPath(card.sessionId);
      if (filePath) {
        const { session } = await startRpcSession(card.sessionId, filePath, undefined);
        await session.send({ type: "abort" });
        await session.send({
          type: "prompt",
          message:
            "检测到任务卡执行异常（可能是同步开启服务或死循环）。\n" +
            "请改用 tmux 后台启动服务：tmux new-session -d '命令'，不要在前台阻塞等待日志；" +
            "如为死循环请重新规划步骤后继续。",
        });
        watchForAgentEnd(card, session);
      }
    }
    updateCard(card.id, { execStatus: "running" });
    console.log(`[task-scheduler] #${card.number} 阻塞处置：abort+tmux 引导，继续运行`);
  } catch (error) {
    console.error(
      `[task-scheduler] 阻塞处置失败 #${card.number}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/** 启动调度器（instrumentation 注册；globalThis 防热重载重复启动）。 */
export function startTaskScheduler(): void {
  if (globalThis.__piTaskScheduler) return;
  let tickInFlight = false;
  const timer = setInterval(() => {
    // 防 tick 重叠：上一轮未跑完（AI 审核耗时可能超过周期）则跳过本轮
    if (tickInFlight) return;
    tickInFlight = true;
    void runSchedulerTick()
      .catch((error) => {
        console.error("[task-scheduler] tick error:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, TASK_SCHEDULER_INTERVAL_MS);
  timer.unref?.();
  const sched = { timer, startedAt: Date.now(), lastAction: { type: "none" as const, at: 0 } };
  globalThis.__piTaskScheduler = sched;
  console.log(`[pi-web] task scheduler started (interval ${TASK_SCHEDULER_INTERVAL_MS}ms, max ${TASK_SCHEDULER_MAX_CONCURRENCY})`);
}

// ============================================================================
// 调度状态（看板展示：调度器在执行什么）
// ============================================================================

export interface TaskSchedulerLastAction {
  /** dispatch=派发了任务；resume=回复续会话；skipped_gate=并发闸门满跳过；none=尚未动作 */
  type: "dispatch" | "resume" | "skipped_gate" | "none";
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

function getLastAction(): TaskSchedulerLastAction {
  return globalThis.__piTaskScheduler?.lastAction ?? { type: "none", at: 0 };
}
function setLastAction(action: TaskSchedulerLastAction): void {
  if (globalThis.__piTaskScheduler) globalThis.__piTaskScheduler.lastAction = action;
}

/** 当前调度器状态：真实运行中的卡 + 最近动作。UI 轮询展示「正在运行 xxx任务」。
 *  running 只列执行会话真实在跑的卡（以 getRunningRpcSessionIds 为准，不读过期卡状态）。 */
export function getSchedulerStatus(): TaskSchedulerStatus {
  const runningIds = new Set(getRunningRpcSessionIds());
  return {
    started: Boolean(globalThis.__piTaskScheduler),
    running: listRunningDispatched().filter((c) => c.sessionId && runningIds.has(c.sessionId)),
    lastAction: getLastAction(),
  };
}
