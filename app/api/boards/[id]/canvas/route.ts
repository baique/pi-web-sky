import { NextResponse } from "next/server";
import { getBoardCanvas, putBoardCanvas } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// GET /api/boards/[id]/canvas — 整张画布（nodes + edges + view）
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const canvas = getBoardCanvas(id);
  if (!canvas) return NextResponse.json({ error: "board not found" }, { status: 404 });
  return NextResponse.json(canvas, { headers: { "Cache-Control": "no-store" } });
}

// PUT /api/boards/[id]/canvas — 全量保存（防抖合并写，单飞）
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { nodes?: unknown; edges?: unknown; view?: unknown };
  try {
    body = (await request.json()) as { nodes?: unknown; edges?: unknown; view?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const ok = putBoardCanvas(id, {
    nodes: Array.isArray(body.nodes) ? (body.nodes as never[]) : undefined,
    edges: Array.isArray(body.edges) ? (body.edges as never[]) : undefined,
    view: body.view !== undefined && body.view !== null ? (body.view as never) : (body.view === null ? null : undefined),
  });
  if (ok === "empty-overwrite") {
    return NextResponse.json({ error: "refusing to overwrite a populated board with an empty canvas (client state incomplete)" }, { status: 409 });
  }
  if (!ok) return NextResponse.json({ error: "board not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
