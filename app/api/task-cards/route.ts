import { NextResponse } from "next/server";
import { createCard, deleteCard, getCard, listCards, replaceLinks } from "@/lib/task-card-store";
import { addNode, getBoard, getNodeByGlobalId, getNodeByRefId, syncCardEdges, upsertTaskCardNode } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// GET /api/task-cards?boardId=xxx → { cards }（每卡附 nodeId）
export async function GET(req: Request) {
  try {
    const boardId = new URL(req.url).searchParams.get("boardId") ?? "";
    const cards = listCards(boardId).map((card) => ({
      ...card,
      nodeId: getNodeByRefId(boardId, card.id, "taskcard")?.id ?? null,
    }));
    return NextResponse.json({ cards }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

const READY_STATUSES = new Set(["draft", "todo"]);

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return null;
  return value as string[];
}

// POST /api/task-cards  body: { boardId?, name, description?, readyStatus?, priority?,
//   due?, attachments?, cwd?, useWorktree?, maxRetries?, prerequisites?, related?, x?, y?, nodeId? }
// 建卡 + 画布节点。nodeId 提供时复用该空卡 node（绑定 refId=cardId，不新建），
// 否则新建 taskcard node。失败回滚。
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      boardId?: unknown;
      name?: unknown;
      description?: unknown;
      readyStatus?: unknown;
      priority?: unknown;
      due?: unknown;
      attachments?: unknown;
      cwd?: unknown;
      useWorktree?: unknown;
      maxRetries?: unknown;
      prerequisites?: unknown;
      related?: unknown;
      x?: unknown;
      y?: unknown;
      nodeId?: unknown;
    };

    if (typeof body.boardId !== "string" || !body.boardId) {
      return NextResponse.json({ error: "boardId is required" }, { status: 400 });
    }    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (body.readyStatus !== undefined && (typeof body.readyStatus !== "string" || !READY_STATUSES.has(body.readyStatus))) {
      return NextResponse.json({ error: "invalid readyStatus" }, { status: 400 });
    }
    if (body.priority !== undefined && (typeof body.priority !== "number" || !Number.isFinite(body.priority))) {
      return NextResponse.json({ error: "priority must be a finite number" }, { status: 400 });
    }
    if (body.due !== undefined && body.due !== null && (typeof body.due !== "number" || !Number.isFinite(body.due))) {
      return NextResponse.json({ error: "due must be a number or null" }, { status: 400 });
    }
    if (body.useWorktree !== undefined && typeof body.useWorktree !== "boolean") {
      return NextResponse.json({ error: "useWorktree must be a boolean" }, { status: 400 });
    }
    if (body.maxRetries !== undefined && (typeof body.maxRetries !== "number" || !Number.isFinite(body.maxRetries))) {
      return NextResponse.json({ error: "maxRetries must be a finite number" }, { status: 400 });
    }
    const prerequisites = body.prerequisites === undefined ? [] : parseStringArray(body.prerequisites);
    const related = body.related === undefined ? [] : parseStringArray(body.related);
    if (prerequisites === null || related === null) {
      return NextResponse.json({ error: "prerequisites/related must be string arrays" }, { status: 400 });
    }
    const attachments = body.attachments === undefined ? undefined : parseStringArray(body.attachments);
    if (attachments === null) {
      return NextResponse.json({ error: "attachments must be a string array" }, { status: 400 });
    }

    const board = getBoard(body.boardId);
    if (!board) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    if (board.isSystem) {
      return NextResponse.json({ error: "任务卡不能建在系统看板" }, { status: 400 });
    }

    // 可选：复用已存在的空卡画布节点（nodeId 优先，绑定 refId=cardId，不新建）
    let boundNodeId: string | null = null;
    if (typeof body.nodeId === "string" && body.nodeId) {
      const node = getNodeByGlobalId(body.nodeId);
      if (!node || node.boardId !== board.id) {
        return NextResponse.json({ error: "画布节点不存在或不属于该看板" }, { status: 400 });
      }
      boundNodeId = body.nodeId;
    }

    // 依赖预校验（目标存在 + 同看板），避免 replaceLinks 抛错导致 500
    for (const targetId of [...prerequisites, ...related]) {
      const target = getCard(targetId);
      if (!target) {
        return NextResponse.json({ error: `dependency target not found: ${targetId}` }, { status: 400 });
      }
      if (target.boardId !== board.id) {
        return NextResponse.json({ error: "依赖不允许跨看板" }, { status: 400 });
      }
    }

    const card = createCard({
      boardId: board.id,
      projectKey: board.projectKey,
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      readyStatus: body.readyStatus as "draft" | "todo" | undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      due: typeof body.due === "number" ? body.due : body.due === null ? null : undefined,
      attachments,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      useWorktree: typeof body.useWorktree === "boolean" ? body.useWorktree : undefined,
      maxRetries: typeof body.maxRetries === "number" ? body.maxRetries : undefined,
    });

    let node;
    try {
      if (boundNodeId) {
        // 复用空卡 node：存在则绑定 refId + 写全 shapeProps，不存在则按 nodeId 新建（upsert）
        node = upsertTaskCardNode(boundNodeId, board.id, {
          id: card.id,
          number: card.number,
          name: card.name,
          readyStatus: card.readyStatus,
          execStatus: card.execStatus,
          priority: card.priority,
          due: card.due,
        }, typeof body.x === "number" ? body.x : 60, typeof body.y === "number" ? body.y : 60);
      } else {
        node = addNode(board.id, {
          kind: "taskcard",
          refId: card.id,
          x: typeof body.x === "number" ? body.x : 60,
          y: typeof body.y === "number" ? body.y : 60,
          w: 220,
          h: 120,
          props: {
            parentId: null,
            shapeProps: {
              cardId: card.id,
              number: card.number,
              name: card.name,
              readyStatus: card.readyStatus,
              execStatus: card.execStatus,
              priority: card.priority,
              due: card.due ?? undefined,
              expanded: false,
              w: 220,
              h: 120,
            },
          },
        });
      }
      if (prerequisites.length > 0 || related.length > 0) {
        replaceLinks(card.id, prerequisites, related);
      }
      syncCardEdges(card.id);
    } catch (error) {
      // 依赖校验/建节点失败 → 回滚已建卡与节点，避免残留
      deleteCard(card.id);
      throw error;
    }

    return NextResponse.json({ card, nodeId: node?.id ?? null }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
