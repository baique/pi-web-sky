import { NextResponse } from "next/server";
import { getBoard, renameBoard, deleteBoard } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { destroyBoardYjsDocument } from "@/lib/board-reconcile";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// GET /api/boards/[id] — 单看板
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const board = getBoard(id);
  if (!board) return NextResponse.json({ error: "board not found" }, { status: 404 });
  return NextResponse.json({ board }, { headers: { "Cache-Control": "no-store" } });
}

// PATCH /api/boards/[id] — { name }
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { name?: string };
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name must not be empty" }, { status: 400 });
  const board = renameBoard(id, name);
  if (!board) return NextResponse.json({ error: "board not found" }, { status: 404 });
  return NextResponse.json({ board });
}

// DELETE /api/boards/[id]
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  const ok = deleteBoard(id);
  if (!ok) return NextResponse.json({ error: "board not found" }, { status: 404 });
  // RF 画布 yjs 文档一并销毁（业务行已删，防看板 id 复用旧文档复活）
  await destroyBoardYjsDocument(id).catch((e) =>
    console.warn(`[boards] destroy yjs doc ${id}:`, e?.message ?? e),
  );
  return NextResponse.json({ ok: true });
}
