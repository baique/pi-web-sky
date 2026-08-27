import { NextResponse } from "next/server";
import { deleteTask, updateTask } from "@/lib/task-store";

// PATCH /api/tasks/[id]  body: { name?: string, sessionIds?: string[] }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      sessionIds?: unknown;
    };
    const patch: { name?: string; sessionIds?: string[] } = {};
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
    if (patch.name === undefined && patch.sessionIds === undefined) {
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

// DELETE /api/tasks/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    deleteTask(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}