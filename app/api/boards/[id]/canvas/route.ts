import { NextResponse } from "next/server";
import { getBoard, getBoardCanvas, putBoardCanvas } from "@/lib/board-store";
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

// PUT /api/boards/[id]/canvas — 全量保存（防抖合并写，单飞 + 乐观锁）
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  let body: { nodes?: unknown; edges?: unknown; view?: unknown; baseUpdated?: unknown; allowEmpty?: unknown };
  try {
    body = (await request.json()) as { nodes?: unknown; edges?: unknown; view?: unknown; baseUpdated?: unknown; allowEmpty?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const ok = putBoardCanvas(id, {
    nodes: Array.isArray(body.nodes) ? (body.nodes as never[]) : undefined,
    edges: Array.isArray(body.edges) ? (body.edges as never[]) : undefined,
    view: body.view !== undefined && body.view !== null ? (body.view as never) : (body.view === null ? null : undefined),
  }, {
    // 乐观锁：客户端必须带它读取快照时的 boards.updated。期间有他人保存过
    // （updated 变化）则拒绝本次写入，避免后写覆盖先写（数据静默丢失）。
    baseUpdated: typeof body.baseUpdated === "number" ? body.baseUpdated : undefined,
    // 用户主动「清空画布」显式放行空覆盖（默认拒绝，防客户端未加载完成覆盖看板）。
    allowEmpty: body.allowEmpty === true,
  });
  if (ok === "empty-overwrite") {
    return NextResponse.json({ error: "refusing to overwrite a populated board with an empty canvas (client state incomplete)" }, { status: 409 });
  }
  if (ok === "conflict") {
    return NextResponse.json({ error: "canvas changed by another client — reload and merge before saving again" }, { status: 409 });
  }
  if (!ok) return NextResponse.json({ error: "board not found" }, { status: 404 });
  // 返回更新后的 boards.updated，客户端据此刻新乐观锁基线。
  const board = getBoard(id);
  return NextResponse.json({ ok: true, updated: board?.updated ?? Date.now() });
}
