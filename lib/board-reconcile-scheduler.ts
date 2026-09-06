// ============================================================================
// 看板派生 reconcile 定时兜底调度器
//
// 目的：需求「看板实时变更，外部或本页新建的会话自动加入看板（窗口期不宜太久）」与
// 任务卡执行会话入板兜底。事件驱动（调度器派发 / assignSessionToTask / 建卡删卡）之外，
// 周期扫描任务看板，兜底处理事件链路遗漏的场景：
//   - 外部进程（CLI/其他实例）直接写 session_meta 归属任务
//   - 任务卡直接改 sessionId（绕过调度器）
//   - 任务卡依赖变化
// 周期：与旧前端 reconcile 的 10s 轮询一致（窗口期不变）。
// 单调度者：只有 leader 实例跑周期扫描（多实例不重复 reconcile 同一批板）。
// ============================================================================
import { getDb } from "./sqlite-db";
import { isLeader } from "./scheduler-leader";
import { reconcileBoard } from "./board-reconcile";

export const BOARD_RECONCILE_INTERVAL_MS = 10_000;

/** 列出全部需 reconcile 的看板：任务看板（task_id 非空）+ 含任务卡的普通看板。
 *  普通看板上的任务卡同样派发执行，执行会话卡/exec 线需要定时兜底补齐。 */
export function listTaskBoardIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT id FROM boards WHERE task_id IS NOT NULL
       UNION
       SELECT DISTINCT board_id FROM task_cards`,
    )
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

declare global {
  var __piBoardReconcileScheduler: { timer: ReturnType<typeof setInterval>; startedAt: number } | undefined;
}

/** 单轮：reconcile 所有需派生的看板。防重叠（上一轮未跑完则跳过）。
 *  仅 leader 实例执行（单调度者；多实例不重复写同一批 Y.Doc）。 */
export async function runBoardReconcileTick(): Promise<void> {
  if (!isLeader()) return;
  const ids = listTaskBoardIds();
  // 并行 reconcile（各自独立 Y.Doc，互不阻塞）
  await Promise.all(
    ids.map((boardId) =>
      reconcileBoard(boardId).catch((e) => {
        console.warn(`[board-reconcile] ${boardId} 异常:`, e?.message ?? e);
      }),
    ),
  );
}

/** 启动定时兜底（instrumentation 注册；globalThis 防热重载重复启动）。 */
export function startBoardReconcileScheduler(): void {
  if (globalThis.__piBoardReconcileScheduler) return;
  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runBoardReconcileTick()
      .catch((e) => console.error("[board-reconcile] tick error:", e?.message ?? e))
      .finally(() => { tickInFlight = false; });
  }, BOARD_RECONCILE_INTERVAL_MS);
  timer.unref?.();
  globalThis.__piBoardReconcileScheduler = { timer, startedAt: Date.now() };
  console.log(`[pi-web] board reconcile scheduler started (interval ${BOARD_RECONCILE_INTERVAL_MS}ms)`);
}
