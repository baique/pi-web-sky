import { NextResponse } from "next/server";
import { addEdge } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/boards/[id]/edges — { fromId, toId, label?, color?, dashed? }
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { fromId?: string; toId?: string; label?: string | null; color?: string | null; dashed?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.fromId || !body.toId) {
    return NextResponse.json({ error: "fromId and toId are required" }, { status: 400 });
  }
  const edge = addEdge(id, {
    fromId: body.fromId,
    toId: body.toId,
    label: body.label ?? null,
    color: body.color ?? null,
    dashed: body.dashed ?? false,
  });
  if (!edge) return NextResponse.json({ error: "board or nodes not found" }, { status: 404 });
  return NextResponse.json({ edge }, { status: 201 });
}
