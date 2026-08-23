import { addListener, fullBuffer, getTerminal, outputSince, removeListener } from "@/lib/terminal-manager";

export const dynamic = "force-dynamic";

// GET /api/terminal/[id]/events?since=<byteOffset> - SSE output stream.
// Replays buffered output from `since` (full buffer when absent/fallen-out),
// then streams live chunks. Each output event carries its end offset so the
// client can resume after a reconnect.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTerminal(id)) return new Response("Terminal not found", { status: 404 });
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const sinceRaw = new URL(req.url).searchParams.get("since");
  const since = sinceRaw === null ? null : Number(sinceRaw);

  // Synchronous snapshot → no chunk can slip between replay and live attach.
  const fb = fullBuffer(id);
  if (!fb) return new Response("Terminal not found", { status: 404 });
  let replay = "";
  if (since !== null && Number.isFinite(since) && since >= fb.startOffset) {
    replay = outputSince(id, since) ?? ""; // null = offset fell out (can't happen here, guarded above)
  } else {
    replay = fb.data; // no/invalid/too-old offset — full replay
  }
  let offset = fb.startOffset + replay.length;

  const encoder = new TextEncoder();
  let listener: ((chunk: string) => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream already closed
        }
      };

      send("output", { d: replay, o: offset });

      listener = (chunk) => {
        if (!chunk) {
          // released (session removed) — tell the client and close
          send("gone", {});
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch { /* already closed */ }
          return;
        }
        offset += chunk.length;
        send("output", { d: chunk, o: offset });
      };
      addListener(id, listener);
      heartbeat = setInterval(() => send("ping", {}), 30_000);

      req.signal.addEventListener("abort", () => {
        if (listener) removeListener(id, listener);
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
    cancel() {
      if (listener) removeListener(id, listener);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
