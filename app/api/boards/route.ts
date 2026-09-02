import { NextResponse } from "next/server";
import { listBoards, listAllBoards, createBoard, getSystemRunningBoard } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// GET /api/boards[?projectKey=] — 看板列表。缺省返回全部（全局共享视图）；
// 传 projectKey 仅返回该项目（向后兼容）。系统「运行中」看板始终前置返回。
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectKey = searchParams.get("projectKey") ?? "";
  const boards = projectKey
    ? [getSystemRunningBoard(), ...listBoards(projectKey)]
    : [getSystemRunningBoard(), ...listAllBoards()];
  return NextResponse.json({ boards }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/boards — { name, projectKey? }。projectKey 可选：缺省为空串（全局共享看板）。
export async function POST(request: Request) {
  let body: { projectKey?: string; name?: string };
  try {
    body = (await request.json()) as { projectKey?: string; name?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const projectKey = (body.projectKey ?? "").trim();
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name must not be empty" }, { status: 400 });
  const board = createBoard(projectKey, name);
  return NextResponse.json({ board }, { status: 201 });
}
