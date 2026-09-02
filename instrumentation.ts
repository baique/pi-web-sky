export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  const { startTaskScheduler } = await import("@/lib/task-scheduler");
  startTaskScheduler();

  const { startBoardReconcileScheduler } = await import("@/lib/board-reconcile-scheduler");
  startBoardReconcileScheduler();
}
