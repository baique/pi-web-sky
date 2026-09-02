import { NextResponse } from "next/server";
import { getTask } from "@/lib/task-store";
import { getOrCreateTaskBoard } from "@/lib/board-store";
import { reconcileBoard } from "@/lib/board-reconcile";

export const dynamic = "force-dynamic";

// GET /api/tasks/[id]/board → { board: BoardInfo }
// 任务即看板：懒创建任务型看板（看板 id = 任务 id，名随任务）。任务不存在 404。
// 建看板后立即跑后端派生 reconcile（纯后台动作）：补已有会话卡，不依赖前端加载时机。
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
    // 任务初始化：立即补已有会话卡 + 派生边（后端权威，无窗口期依赖）
    void reconcileBoard(board.id).catch((e) =>
      console.warn(`[task-board] reconcile ${board.id} 异常:`, e?.message ?? e),
    );
    return NextResponse.json({ board }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
