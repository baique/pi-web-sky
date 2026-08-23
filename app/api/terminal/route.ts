import { createTerminal, listTerminals } from "@/lib/terminal-manager";
import { resolveProject } from "@/lib/worktree";

export const dynamic = "force-dynamic";

// GET /api/terminal - list all terminal sessions
export async function GET() {
  return Response.json({ terminals: listTerminals() });
}

// POST /api/terminal - create a terminal session { cwd, cols?, rows? }
export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { cwd?: string; cols?: number; rows?: number } | null;
  const cwd = body?.cwd;
  if (!cwd || typeof cwd !== "string") {
    return Response.json({ error: "cwd is required" }, { status: 400 });
  }

  let projectRoot: string | null = null;
  let projectLabel = "~";
  try {
    const info = await resolveProject(cwd);
    projectRoot = info.projectRoot;
    const base = info.projectRoot.split("/").pop() || info.projectRoot;
    projectLabel = info.isWorktree && info.branch ? `${base}·${info.branch}` : base;
  } catch {
    // non-git dir — fall back to home label
  }

  try {
    const terminal = await createTerminal({ cwd, projectRoot, projectLabel, cols: body?.cols, rows: body?.rows });
    return Response.json({ terminal });
  } catch (e) {
    return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status: 500 });
  }
}
