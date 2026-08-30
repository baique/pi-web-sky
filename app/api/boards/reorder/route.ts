import { NextResponse } from "next/server";
import { reorderBoards } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// PUT /api/boards/reorder — { projectKey, orderedIds }
export async function PUT(request: Request) {
  let body: { projectKey?: string; orderedIds?: string[] };
  try {
    body = (await request.json()) as { projectKey?: string; orderedIds?: string[] };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const projectKey = (body.projectKey ?? "").trim();
  const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];
  if (!projectKey) return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
  if (orderedIds.length === 0) return NextResponse.json({ boards: [] });
  try {
    const boards = reorderBoards(projectKey, orderedIds);
    return NextResponse.json({ boards });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
