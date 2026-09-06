import { NextResponse } from "next/server";
import { assignSessionToTask, getTask } from "@/lib/task-store";

// POST /api/tasks/[id]/assign-session — { sessionId } 原子归属会话到任务。
// 消除前端「GET 读 sessionIds → PATCH full-replace」的读-改-写竞态（多端并发拖入
// 不同会话时后提交者会踢掉先提交者）。服务端 ON CONFLICT upsert，天然幂等，
// 会话原本在其他任务下则移动。任务不存在返回 404。
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await _req.json().catch(() => ({}))) as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId) {
      return NextResponse.json({ error: "sessionId must be a string" }, { status: 400 });
    }
    if (!getTask(id)) {
      return NextResponse.json({ error: "task not found" }, { status: 404 });
    }
    assignSessionToTask(body.sessionId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
