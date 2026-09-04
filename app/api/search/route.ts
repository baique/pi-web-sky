import { NextResponse } from "next/server";
import { searchTaskCardsAndSessions } from "@/lib/search";

export const dynamic = "force-dynamic";

// GET /api/search?q=<term>&limit=<n>[&sessionIds=<id1,id2,...>]
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const q = params.get("q") ?? "";
    const rawLimit = Number(params.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : 30;
    const sessionIds = (params.get("sessionIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const { indexing, results } = await searchTaskCardsAndSessions(q, limit, sessionIds.length ? sessionIds : undefined);

    return NextResponse.json(
      { indexing, results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}