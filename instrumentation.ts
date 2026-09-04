export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  const { startTaskScheduler } = await import("@/lib/task-scheduler");
  startTaskScheduler();

  // 二分定位：board-reconcile 每 10s reconcile 所有看板（写 yjs + sync.db），
  // 是空壳 tick 下仍每 10s 卡 8s 的最后嫌疑。临时停用验证，定位后恢复。
  // const { startBoardReconcileScheduler } = await import("@/lib/board-reconcile-scheduler");
  // startBoardReconcileScheduler();
}
