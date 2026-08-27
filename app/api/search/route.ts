import { NextResponse } from "next/server";
import { searchSessions } from "@/lib/session-search";

export const dynamic = "force-dynamic";

// GET /api/search?q=<term>&limit=<n>
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const q = params.get("q") ?? "";
    const rawLimit = Number(params.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : 30;
    const { indexing, results } = await searchSessions(q, limit);
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