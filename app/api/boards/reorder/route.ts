import { NextResponse } from "next/server";
import { reorderBoards, reorderAllBoards } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// PUT /api/boards/reorder — { orderedIds, projectKey? }。projectKey 可选：
// 缺省按全局手动看板范围排序，传了则仅排序该项目（向后兼容）。
export async function PUT(request: Request) {
  let body: { projectKey?: string; orderedIds?: string[] };
  try {
    body = (await request.json()) as { projectKey?: string; orderedIds?: string[] };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const projectKey = (body.projectKey ?? "").trim();
  const orderedIds = Array.isArray(body.orderedIds) ? body.orderedIds : [];
  if (orderedIds.length === 0) return NextResponse.json({ boards: [] });
  try {
    const boards = projectKey ? reorderBoards(projectKey, orderedIds) : reorderAllBoards(orderedIds);
    return NextResponse.json({ boards });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
