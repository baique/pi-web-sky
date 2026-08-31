import { NextResponse } from "next/server";
import { createCard, deleteCard, listCards, replaceLinks } from "@/lib/task-card-store";
import { addNode, getBoard, getNodeByRefId, syncCardEdges } from "@/lib/board-store";

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

// POST /api/task-cards  body: { boardId, name, description?, readyStatus?, priority?,
//   due?, attachments?, cwd?, useWorktree?, maxRetries?, prerequisites?, related?, x?, y? }
// 建卡 + 建画布 taskcard 节点 + 依赖 + 依赖边 reconcile（原子失败回滚）。
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
    };

    if (typeof body.boardId !== "string" || !body.boardId) {
      return NextResponse.json({ error: "boardId is required" }, { status: 400 });
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
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

    const board = getBoard(body.boardId);
    if (!board) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }

    const card = createCard({
      boardId: board.id,
      projectKey: board.projectKey,
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      readyStatus: body.readyStatus as "draft" | "todo" | undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      due: typeof body.due === "number" ? body.due : body.due === null ? null : undefined,
      attachments: Array.isArray(body.attachments) ? body.attachments.filter((x): x is string => typeof x === "string") : undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      useWorktree: typeof body.useWorktree === "boolean" ? body.useWorktree : undefined,
      maxRetries: typeof body.maxRetries === "number" ? body.maxRetries : undefined,
    });

    let node;
    try {
      node = addNode(board.id, {
        kind: "taskcard",
        refId: card.id,
        x: typeof body.x === "number" ? body.x : 60,
        y: typeof body.y === "number" ? body.y : 60,
        w: 220,
        h: 120,
      });
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
