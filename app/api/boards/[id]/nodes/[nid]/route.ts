import { NextResponse } from "next/server";
import { getBoard, patchNode, deleteNode } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; nid: string }> };

// PATCH /api/boards/[id]/nodes/[nid] — { refId?, x?, y?, w?, h?, expanded?, props? }
export async function PATCH(request: Request, { params }: Params) {
  const { id, nid } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { refId?: string | null; x?: number; y?: number; w?: number; h?: number; expanded?: boolean; props?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const node = patchNode(id, nid, {
    refId: body.refId,
    x: body.x,
    y: body.y,
    w: body.w,
    h: body.h,
    expanded: body.expanded,
    props: body.props,
  });
  if (!node) return NextResponse.json({ error: "board or node not found" }, { status: 404 });
  // 返回 boards.updated：客户端据此刻新乐观锁基线，避免下一次全量保存误报 409。
  const board = getBoard(id);
  return NextResponse.json({ node, updated: board?.updated ?? Date.now() });
}

// DELETE /api/boards/[id]/nodes/[nid]
export async function DELETE(_request: Request, { params }: Params) {
  const { id, nid } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  const ok = deleteNode(id, nid);
  if (!ok) return NextResponse.json({ error: "board or node not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
