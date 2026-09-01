import { NextResponse } from "next/server";
import {
  deleteCard,
  getCard,
  listInboundLinks,
  listLinks,
  replaceLinks,
  updateCard,
} from "@/lib/task-card-store";
import { getBoard } from "@/lib/board-store";

export const dynamic = "force-dynamic";

const READY_STATUSES = new Set(["draft", "todo"]);
const EXEC_STATUSES = new Set([
  "not_started",
  "running",
  "review",
  "done",
  "failed",
  "abandoned",
  "waiting_reply",
]);

// GET /api/task-cards/[id] → { card, links, inbound }
// 画布节点在 sync.db（shape 自带 cardId prop），nodeId 概念废弃。
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const card = getCard(id);
    if (!card) {
      return NextResponse.json({ error: "Task card not found" }, { status: 404 });
    }
    return NextResponse.json({
      card,
      links: listLinks(id),
      inbound: listInboundLinks(id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return null;
  return value as string[];
}

// PATCH /api/task-cards/[id]  body: { name?, description?, readyStatus?, execStatus?,
//   priority?, due?, attachments?, cwd?, useWorktree?, maxRetries?, prerequisites?, related? }
// 依赖变更 → replaceLinks（目标先做同看板校验，避免半更新）。依赖线由前端 reconcile 渲染。
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      description?: unknown;
      readyStatus?: unknown;
      execStatus?: unknown;
      priority?: unknown;
      due?: unknown;
      attachments?: unknown;
      cwd?: unknown;
      useWorktree?: unknown;
      maxRetries?: unknown;
      prerequisites?: unknown;
      related?: unknown;
    };

    const card = getCard(id);
    if (!card) {
      return NextResponse.json({ error: "Task card not found" }, { status: 404 });
    }
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (body.readyStatus !== undefined && (typeof body.readyStatus !== "string" || !READY_STATUSES.has(body.readyStatus))) {
      return NextResponse.json({ error: "invalid readyStatus" }, { status: 400 });
    }
    if (body.execStatus !== undefined && (typeof body.execStatus !== "string" || !EXEC_STATUSES.has(body.execStatus))) {
      return NextResponse.json({ error: "invalid execStatus" }, { status: 400 });
    }
    if (body.priority !== undefined && (typeof body.priority !== "number" || !Number.isFinite(body.priority))) {
      return NextResponse.json({ error: "priority must be a finite number" }, { status: 400 });
    }
    if (body.due !== undefined && body.due !== null && (typeof body.due !== "number" || !Number.isFinite(body.due))) {
      return NextResponse.json({ error: "due must be a number or null" }, { status: 400 });
    }
    if (body.description !== undefined && typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }
    if (body.cwd !== undefined && body.cwd !== null && typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd must be a string or null" }, { status: 400 });
    }
    if (body.useWorktree !== undefined && typeof body.useWorktree !== "boolean") {
      return NextResponse.json({ error: "useWorktree must be a boolean" }, { status: 400 });
    }
    if (body.maxRetries !== undefined && (typeof body.maxRetries !== "number" || !Number.isFinite(body.maxRetries))) {
      return NextResponse.json({ error: "maxRetries must be a finite number" }, { status: 400 });
    }
    const prerequisites = body.prerequisites === undefined ? undefined : parseStringArray(body.prerequisites);
    const related = body.related === undefined ? undefined : parseStringArray(body.related);
    if (prerequisites === null || related === null) {
      return NextResponse.json({ error: "prerequisites/related must be string arrays" }, { status: 400 });
    }
    const depsProvided = prerequisites !== undefined || related !== undefined;
    if (depsProvided) {
      // 先校验依赖目标同看板 + 非自环，避免 replaceLinks 抛错造成字段已更新但依赖未变的半更新
      for (const targetId of [...(prerequisites ?? []), ...(related ?? [])]) {
        if (targetId === id) {
          return NextResponse.json({ error: "依赖不能指向自身" }, { status: 400 });
        }
        const target = getCard(targetId);
        if (!target) {
          return NextResponse.json({ error: `dependency target not found: ${targetId}` }, { status: 400 });
        }
        if (target.boardId !== card.boardId) {
          return NextResponse.json({ error: "依赖不允许跨看板" }, { status: 400 });
        }
      }
    }

    const patch: Parameters<typeof updateCard>[1] = {};
    if (body.name !== undefined) patch.name = body.name as string;
    if (body.description !== undefined) patch.description = body.description as string;
    if (body.readyStatus !== undefined) patch.readyStatus = body.readyStatus as never;
    if (body.execStatus !== undefined) patch.execStatus = body.execStatus as never;
    if (body.priority !== undefined) patch.priority = body.priority as number;
    if (body.due !== undefined) patch.due = body.due as number | null;
    if (body.attachments !== undefined) {
      const arr = parseStringArray(body.attachments);
      if (arr === null) return NextResponse.json({ error: "attachments must be a string array" }, { status: 400 });
      patch.attachments = arr;
    }
    if (body.cwd !== undefined) patch.cwd = body.cwd as string | null;
    if (body.useWorktree !== undefined) patch.useWorktree = body.useWorktree;
    if (body.maxRetries !== undefined) patch.maxRetries = body.maxRetries;

    if (Object.keys(patch).length > 0) {
      updateCard(id, patch);
    }
    if (depsProvided) {
      replaceLinks(id, prerequisites ?? [], related ?? []);
    }
    // 依赖线由前端 reconcile 渲染（确定性 id 幂等），不再 syncCardEdges 写 board_edges。
    return NextResponse.json({ card: getCard(id), updated: getBoard(card.boardId)?.updated ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/task-cards/[id] —— 级联删依赖/问答 + taskcard 节点/边。
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const card = getCard(id);
    const boardId = card?.boardId ?? null;
    deleteCard(id);
    // 删卡会 bump boards.updated（删 node/边）——响应带最新 updated，
    // 客户端刷新乐观锁基线，避免后续防抖全量保存携带过期基线被 409 拒绝。
    return NextResponse.json({ ok: true, updated: boardId ? (getBoard(boardId)?.updated ?? null) : null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
