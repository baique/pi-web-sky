import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board-store";
import { addSessionCardToBoard } from "@/lib/board-reconcile";
import { assignSessionSubtreeToTask, getTask, hasForeignTaskAncestor } from "@/lib/task-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/boards/[id]/add-session — { sessionId, title? }
// 侧栏把会话拖到「看板」行 → 在目标看板落一张会话卡。目标看板无需被打开：
// 服务端直接写该看板的 yjs 文档（前端只负责看板行的拖放视觉）。
// 落点由后端 findFreeSpot 定（侧栏行没有画布坐标，不重叠即可）。
const MEMBERSHIP_CONFLICT = {
  error: "membership conflict: the session's ancestor belongs to another task",
};

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const board = getBoard(id);
  if (!board) return NextResponse.json({ error: "board not found" }, { status: 404 });
  // 系统「运行中」看板是虚拟视图（不落库、内容由运行态派生）→ 不接受拖入
  if (board.isSystem) return NextResponse.json({ error: "system board is read-only" }, { status: 403 });

  let body: { sessionId?: unknown; title?: unknown };
  try {
    body = (await request.json()) as { sessionId?: unknown; title?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId) return NextResponse.json({ error: "sessionId must be a string" }, { status: 400 });
  const title = typeof body.title === "string" && body.title ? body.title : undefined;

  // 任务看板（侧栏看板列不展示，但 URL 直达/其他入口可能命中）：先写任务归属，
  // 否则 reconcile 把这张卡当孤儿卡删掉（与画布拖入同一规则：先归属、成功才落卡）。
  // 归属失败必须可见（不再静默落卡）：祖先在别的任务 → 409；会话解析不出 → 404。
  if (board.taskId) {
    if (!getTask(board.taskId)) return NextResponse.json({ error: "task not found" }, { status: 404 });
    if (hasForeignTaskAncestor(sessionId, board.taskId)) {
      return NextResponse.json(MEMBERSHIP_CONFLICT, { status: 409 });
    }
    if (!(await assignSessionSubtreeToTask(sessionId, board.taskId))) {
      // 库里原本没行的会话：祖先冲突只有补行（读磁盘 header → parent_id）后才可见，
      // 上面的预检看不到——此时再判一次，给 409 而不是误导性的 404。
      if (hasForeignTaskAncestor(sessionId, board.taskId)) {
        return NextResponse.json(MEMBERSHIP_CONFLICT, { status: 409 });
      }
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
  }

  const added = await addSessionCardToBoard(id, sessionId, title);
  return NextResponse.json({ ok: true, added });
}
