import { NextResponse } from "next/server";
import { getBoard } from "@/lib/board-store";
import { reconcileBoard } from "@/lib/board-reconcile";

export const dynamic = "force-dynamic";

// POST /api/boards/[id]/reconcile
// 触发看板派生 reconcile（后端权威）：补会话卡/任务卡、exec 线/依赖线、孤儿清理。
// 前端"刷新画布"按钮调用；已连接的 provider 通过 yjs 广播自动收到 reconcile 写的内容并重渲染。
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const board = getBoard(id);
    if (!board) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    await reconcileBoard(id);
    return NextResponse.json({ ok: true, updated: board.updated ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
