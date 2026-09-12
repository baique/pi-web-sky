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
    // 只读**活动分支**（getBranch = leaf→root 路径），与 buildSessionContext 同源：
    // 读全量 getEntries 会把别的分支（fork / 旧分支）的 todo 当成当前会话的，
    // 顶栏按钮与面板两个数据源就会打架。
    const branch = sm.getBranch() as unknown as SessionEntry[];
    return NextResponse.json({ todos: extractTodosFromEntries(branch) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}