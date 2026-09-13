import { NextResponse } from "next/server";
import { unbindCardSession } from "@/lib/task-card-store";

export const dynamic = "force-dynamic";

// POST /api/task-cards/unbind — 解除任务卡与执行会话的绑定（body: { sessionId }）。
//
// 普通看板移除执行会话卡时调用：卡片是引用（会话保留在会话列表），但业务侧的
// task_cards.session_id 必须一起清掉，否则后端 reconcile 会把这张派生卡补回来；
// 非终态的卡同时结算为「放弃」，免得卡停在执行中/等回答/待审核。
export async function POST(request: Request) {
  let body: { sessionId?: string };
  try {
    body = (await request.json()) as { sessionId?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const sessionId = body.sessionId?.trim();
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  unbindCardSession(sessionId);
  return NextResponse.json({ ok: true });
}
