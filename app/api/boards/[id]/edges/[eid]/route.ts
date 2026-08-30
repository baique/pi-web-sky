import { NextResponse } from "next/server";
import { deleteEdge } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; eid: string }> };

// DELETE /api/boards/[id]/edges/[eid]
export async function DELETE(_request: Request, { params }: Params) {
  const { id, eid } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  const ok = deleteEdge(id, eid);
  if (!ok) return NextResponse.json({ error: "edge not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
