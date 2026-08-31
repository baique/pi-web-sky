import { NextResponse } from "next/server";
import { getRunningRpcSessionIds, getRunningSessionStates } from "@/lib/rpc-manager";
import { listCardsByExecStatus } from "@/lib/task-card-store";
import type { RunningSnapshot, TaskCardRunningState } from "@/lib/board-types";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// Extended with per-session细分状态（看板状态系统：思考中/执行工具/等待输入/空闲/刚结束）。
// 任务卡状态：调度器活跃态卡（running/review/waiting_reply）随快照透出，前端看板按 boardId 过滤后更新卡徽章。
export async function GET() {
  const runningSessionIds = getRunningRpcSessionIds();
  const taskCards: TaskCardRunningState[] = listCardsByExecStatus(["running", "review", "waiting_reply"])
    .map((c) => ({
      cardId: c.id,
      boardId: c.boardId,
      number: c.number,
      name: c.name,
      execStatus: c.execStatus,
    }));
  const snapshot: RunningSnapshot = {
    runningSessionIds,
    states: getRunningSessionStates(),
    taskCards,
  };
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
