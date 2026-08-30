import { NextResponse } from "next/server";
import { listBoards, createBoard, getSystemRunningBoard } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";

export const dynamic = "force-dynamic";

// GET /api/boards?projectKey= — 项目看板列表（系统「运行中」看板始终前置返回）
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectKey = searchParams.get("projectKey") ?? "";
  const boards = [getSystemRunningBoard(), ...listBoards(projectKey)];
  return NextResponse.json({ boards }, { headers: { "Cache-Control": "no-store" } });
}

// POST /api/boards — { projectKey, name }
export async function POST(request: Request) {
  let body: { projectKey?: string; name?: string };
  try {
    body = (await request.json()) as { projectKey?: string; name?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const projectKey = (body.projectKey ?? "").trim();
  const name = (body.name ?? "").trim();
  if (!projectKey) return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "name must not be empty" }, { status: 400 });
  const board = createBoard(projectKey, name);
  return NextResponse.json({ board }, { status: 201 });
}

export { SYSTEM_RUNNING_BOARD_ID };
