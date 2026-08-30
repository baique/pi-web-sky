import { NextResponse } from "next/server";
import { addNode } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/boards/[id]/nodes — { kind?, refId?, x, y, w?, h?, expanded?, props? }
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { kind?: string; refId?: string | null; x?: number; y?: number; w?: number; h?: number; expanded?: boolean; props?: Record<string, unknown> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (typeof body.x !== "number" || typeof body.y !== "number") {
    return NextResponse.json({ error: "x and y are required" }, { status: 400 });
  }
  const node = addNode(id, {
    kind: body.kind === "session" ? "session" : "session",
    refId: body.refId ?? null,
    x: body.x,
    y: body.y,
    w: body.w,
    h: body.h,
    expanded: body.expanded,
    props: body.props,
  });
  if (!node) return NextResponse.json({ error: "board not found" }, { status: 404 });
  return NextResponse.json({ node }, { status: 201 });
}
