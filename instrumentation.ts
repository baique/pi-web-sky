export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  const { startTaskScheduler } = await import("@/lib/task-scheduler");
  startTaskScheduler();

  // 10s 定时兜底：补事件链路之外的派生（外部直写 session_meta / 任务卡改 sessionId 等）。
  // 曾因每 10s 卡 8s 临时停用验证；compact 治理生效后恢复。
  const { startBoardReconcileScheduler } = await import("@/lib/board-reconcile-scheduler");
  startBoardReconcileScheduler();

  // 会话索引扫描器：启动即跑首轮 + 每 30s 续扫，全量建/刷 session_meta 索引。
  const { startSessionIndexScanner } = await import("@/lib/session-index-scanner");
  startSessionIndexScanner();
}
