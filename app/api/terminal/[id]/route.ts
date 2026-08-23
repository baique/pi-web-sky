import { getTerminal, killTerminal, removeTerminal, resizeTerminal, writeTerminal } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// GET /api/terminal/[id] - session metadata
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const terminal = getTerminal(id);
  if (!terminal) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ terminal });
}

// POST /api/terminal/[id] - { type: "input", data } | { type: "resize", cols, rows }
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json().catch(() => null) as
    | { type?: string; data?: string; cols?: number; rows?: number }
    | null;
  if (!body) return Response.json({ error: "invalid body" }, { status: 400 });

  if (body.type === "input" && typeof body.data === "string") {
    return writeTerminal(id, body.data)
      ? Response.json({ ok: true })
      : Response.json({ error: "not found or exited" }, { status: 404 });
  }
  if (body.type === "resize" && typeof body.cols === "number" && typeof body.rows === "number") {
    return resizeTerminal(id, Math.max(2, Math.floor(body.cols)), Math.max(2, Math.floor(body.rows)))
      ? Response.json({ ok: true })
      : Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}

// DELETE /api/terminal/[id] - kill process and drop the session
export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  killTerminal(id);
  removeTerminal(id);
  return Response.json({ ok: true });
}
