import { NextResponse } from "next/server";
import { getTask } from "@/lib/task-store";
import { getOrCreateTaskBoard } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id]/board → { board: BoardInfo }
// 任务即看板：懒创建任务型看板（看板 id = 任务 id，名随任务）。任务不存在 404。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = getTask(id);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    const board = getOrCreateTaskBoard(task.id, task.projectKey, task.name);
    return NextResponse.json({ board }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
