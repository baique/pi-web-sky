import { NextResponse } from "next/server";
import { deleteTask, getTask, listTaskSessionIds, updateTask } from "@/lib/task-store";
import { deleteSessionTrees } from "@/lib/session-delete";
import { listCards } from "@/lib/task-card-store";

// GET /api/tasks/[id] → { task: { id, name, ... } | null, occupiedSessionIds?: string[] }
// 会话输入框 placeholder / 详情面板用：按任务 id 取单个任务（含名称）。
// occupiedSessionIds：该任务看板任务卡占用的执行会话（前端补卡时排除，避免同一会话既在任务卡里又单独成卡）。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = getTask(id);
    if (!task) {
      return NextResponse.json({ task: null }, { status: 404 });
    }
    // 任务看板 boardId = 任务 id；卡占用会话 = task_cards.session_id 非空集合
    const occupiedSessionIds = listCards(id)
      .map((c) => c.sessionId)
      .filter((sid): sid is string => Boolean(sid));
    return NextResponse.json({ task, occupiedSessionIds }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/tasks/[id]  body: { name?, sessionIds?, pinned?, sortOrder? }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      sessionIds?: unknown;
      pinned?: unknown;
      sortOrder?: unknown;
    };
    const patch: { name?: string; sessionIds?: string[]; pinned?: boolean; sortOrder?: number } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return NextResponse.json({ error: "name must be a string" }, { status: 400 });
      }
      patch.name = body.name;
    }
    if (body.sessionIds !== undefined) {
      if (
        !Array.isArray(body.sessionIds)
        || body.sessionIds.some((x) => typeof x !== "string")
      ) {
        return NextResponse.json({ error: "sessionIds must be a string array" }, { status: 400 });
      }
      patch.sessionIds = body.sessionIds;
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") {
        return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
      }
      patch.pinned = body.pinned;
    }
    if (body.sortOrder !== undefined) {
      if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) {
        return NextResponse.json({ error: "sortOrder must be a finite number" }, { status: 400 });
      }
      patch.sortOrder = body.sortOrder;
    }
    if (patch.name === undefined && patch.sessionIds === undefined && patch.pinned === undefined && patch.sortOrder === undefined) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const task = updateTask(id, patch);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ task });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/tasks/[id] —— 删除任务及其下全部会话（含 fork 子树）。
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const deletedSessionIds = await deleteSessionTrees(listTaskSessionIds(id));
    deleteTask(id);
    return NextResponse.json({ ok: true, deletedSessionIds });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}