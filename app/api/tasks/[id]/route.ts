import { NextResponse } from "next/server";
import { deleteTask, getTask, listTaskSessionIds, updateTask } from "@/lib/task-store";
import { deleteSessionTrees } from "@/lib/session-delete";
import { destroyBoardYjsDocument, reconcileBoard } from "@/lib/board-reconcile";

// GET /api/tasks/[id] → { task: { id, name, ... } | null }
// 会话输入框 placeholder / 详情面板用：按任务 id 取单个任务（含名称与任务下会话）。
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
    return NextResponse.json({ task }, { headers: { "Cache-Control": "no-store" } });
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
    // 任务会话归属变化 → 任务看板派生 reconcile（补/清会话卡 + 孤儿删，后端权威）
    void reconcileBoard(id).catch((e) =>
      console.warn(`[tasks] reconcile ${id} 异常:`, e?.message ?? e),
    );
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
    // RF 画布 yjs 文档随任务看板一并销毁（业务行已删，防 id 复用旧文档复活）
    await destroyBoardYjsDocument(id).catch((e) =>
      console.warn(`[boards] destroy task board yjs doc ${id}:`, e?.message ?? e),
    );
    return NextResponse.json({ ok: true, deletedSessionIds });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}