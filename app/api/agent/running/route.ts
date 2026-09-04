import { NextResponse } from "next/server";
import { getRunningRpcSessionIds, getRunningSessionStates } from "@/lib/rpc-manager";
import { listCardsByExecStatus, listCardsByIds } from "@/lib/task-card-store";
import type { RunningSnapshot, TaskCardRunningState } from "@/lib/board-types";

export const dynamic = "force-dynamic";

function toTaskCardState(c: {
  id: string;
  boardId: string;
  number: number;
  name: string;
  execStatus: string;
  readyStatus: string;
}): TaskCardRunningState {
  return {
    cardId: c.id,
    boardId: c.boardId,
    number: c.number,
    name: c.name,
    execStatus: c.execStatus,
    readyStatus: c.readyStatus,
  };
}

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// Extended with per-session细分状态（看板状态系统：思考中/执行工具/等待输入/空闲/刚结束）。
//
// 任务卡状态（DB 唯一真相的展示镜像，画布徽章消费）：
//   - 无参：调度器活跃态卡（running/review/waiting_reply，向后兼容左侧栏 running 数）
//   - ?boardId=<id>&cardIds=a,b,c：可见任务卡**全量**状态（含 failed/done/not_started）
//     返回前端画布正在展示、需刷新徽章的卡。cardIds 上限保护，防恶意大查询。
const MAX_CARD_IDS = 500;

// 临时诊断：/api/agent/running 各阶段耗时（排查 6~8s 慢响应，定位后移除）
function diag(label: string, t0: number): number {
  const now = performance.now();
  console.log(`[running-diag] ${label} +${(now - t0).toFixed(1)}ms`);
  return now;
}

export async function GET(req: Request) {
  let t = performance.now();
  t = diag("entry", t);
  const { searchParams } = new URL(req.url);
  const boardId = searchParams.get("boardId");
  const cardIdsParam = searchParams.get("cardIds");
  t = diag("parse-params", t);

  let taskCards: TaskCardRunningState[];
  if (boardId && cardIdsParam) {
    const cardIds = cardIdsParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_CARD_IDS);
    taskCards = listCardsByIds(cardIds)
      .filter((c) => c.boardId === boardId) // 防越板：只认本板卡
      .map(toTaskCardState);
    t = diag(`listCardsByIds(n=${cardIds.length})`, t);
  } else {
    // 无参：活跃态卡（原语义）
    taskCards = listCardsByExecStatus(["running", "review", "waiting_reply"]).map(toTaskCardState);
    t = diag("listCardsByExecStatus", t);
  }

  const runningIds = getRunningRpcSessionIds();
  t = diag(`getRunningRpcSessionIds(n=${runningIds.length})`, t);
  const states = getRunningSessionStates();
  t = diag(`getRunningSessionStates(n=${Object.keys(states).length})`, t);

  const snapshot: RunningSnapshot = {
    runningSessionIds: runningIds,
    states,
    taskCards,
  };
  t = diag("json-assemble", t);
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
