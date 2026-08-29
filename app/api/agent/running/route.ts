import { NextResponse } from "next/server";
import { getRunningRpcSessionIds, getRunningSessionStates } from "@/lib/rpc-manager";
import type { RunningSnapshot } from "@/lib/board-types";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// Extended with per-session细分状态（看板状态系统：思考中/执行工具/等待输入/空闲/刚结束）。
export async function GET() {
  const runningSessionIds = getRunningRpcSessionIds();
  const snapshot: RunningSnapshot = {
    runningSessionIds,
    states: getRunningSessionStates(),
  };
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
