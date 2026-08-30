import { NextResponse } from "next/server";
import { cleanupInvalidNodes } from "@/lib/board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "@/lib/board-types";
import { listAllSessions } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/boards/[id]/nodes/cleanup — 清理失效节点（会话 .jsonl 已消失）
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  if (id === SYSTEM_RUNNING_BOARD_ID) {
    return NextResponse.json({ error: "system board is read-only" }, { status: 403 });
  }
  const sessions = await listAllSessions();
  const valid = new Set(sessions.map((s) => s.id));
  const removed = cleanupInvalidNodes(id, () => valid);
  return NextResponse.json({ removed });
}
