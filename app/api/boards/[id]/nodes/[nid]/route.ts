import { NextResponse } from "next/server";
import { patchNode, deleteNode } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; nid: string }> };

// PATCH /api/boards/[id]/nodes/[nid] — { x?, y?, w?, h?, expanded?, props? }
export async function PATCH(request: Request, { params }: Params) {
  const { id, nid } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { x?: number; y?: number; w?: number; h?: number; expanded?: boolean; props?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const node = patchNode(id, nid, {
    x: body.x,
    y: body.y,
    w: body.w,
    h: body.h,
    expanded: body.expanded,
    props: body.props,
  });
  if (!node) return NextResponse.json({ error: "board or node not found" }, { status: 404 });
  return NextResponse.json({ node });
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
