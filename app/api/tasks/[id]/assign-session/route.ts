import { NextResponse } from "next/server";
import { assignSessionSubtreeToTask, getTask, hasForeignTaskAncestor } from "@/lib/task-store";

// POST /api/tasks/[id]/assign-session — { sessionId } 原子归属会话到任务。
// 消除前端「GET 读 sessionIds → PATCH full-replace」的读-改-写竞态（多端并发拖入
// 不同会话时后提交者会踢掉先提交者）。服务端 ON CONFLICT upsert，天然幂等，
// 会话原本在其他任务下则移动。任务不存在返回 404。
//
// 归属失败必须可见（不再静默 200）：
//   · 祖先属于其它任务 → 409（跨任务父子会被成员规范化/收敛反向拉回，写进去也不收敛）；
//   · 会话解析不出（库无行 + 找不到文件）→ 404。
const MEMBERSHIP_CONFLICT = {
  error: "membership conflict: the session's ancestor belongs to another task",
};

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
    if (hasForeignTaskAncestor(body.sessionId, id)) {
      return NextResponse.json(MEMBERSHIP_CONFLICT, { status: 409 });
    }
    if (!(await assignSessionSubtreeToTask(body.sessionId, id))) {
      // 库里原本没行的会话：祖先冲突只有补行（读磁盘 header → parent_id）后才可见，
      // 上面的预检看不到——此时再判一次，给 409 而不是误导性的 404。
      if (hasForeignTaskAncestor(body.sessionId, id)) {
        return NextResponse.json(MEMBERSHIP_CONFLICT, { status: 409 });
      }
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
