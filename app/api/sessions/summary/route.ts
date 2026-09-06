import { NextResponse } from "next/server";
import { loadSessionSummariesByIds } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// POST /api/sessions/summary  body: { ids: string[] }
// 看板卡片摘要点查：画布上有哪些会话卡就查哪些，替代全量 /api/sessions 轮询自筛。
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string")
      : [];
    // 防御：异常大的 ids 直接拒绝（画布卡片数有界，正常 <100）
    if (ids.length > 500) {
      return NextResponse.json({ error: "too many ids" }, { status: 400 });
    }
    const sessions = await loadSessionSummariesByIds(ids);
    return NextResponse.json({ sessions });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
