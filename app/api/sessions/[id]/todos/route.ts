import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, extractTodosFromEntries } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import type { SessionEntry } from "@/lib/types";

// Lightweight todo refresh endpoint — returns only the latest pi-todo.state
// snapshot from the active session (live in-memory entries when the agent is
// running, otherwise the session file). Used by the top-right Tasks panel for
// polling and open-time refresh without reloading the full chat context.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!);
    const entries = sm.getEntries() as unknown as SessionEntry[];
    return NextResponse.json({ todos: extractTodosFromEntries(entries) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}