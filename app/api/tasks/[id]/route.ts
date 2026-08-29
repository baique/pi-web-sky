import { NextResponse } from "next/server";
import { deleteTask, listTaskSessionIds, updateTask } from "@/lib/task-store";
import { deleteSessionTrees } from "@/lib/session-delete";

// PATCH /api/tasks/[id]  body: { name?, sessionIds?, pinned? }
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
    };
    const patch: { name?: string; sessionIds?: string[]; pinned?: boolean } = {};
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
    if (patch.name === undefined && patch.sessionIds === undefined && patch.pinned === undefined) {
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