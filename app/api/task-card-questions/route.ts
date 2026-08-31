import { NextResponse } from "next/server";
import {
  countPendingQuestions,
  listQuestions,
  type QuestionStatus,
} from "@/lib/task-card-store";

export const dynamic = "force-dynamic";

// GET /api/task-card-questions?status=pending|answered|all → { questions, pendingCount }
export async function GET(req: Request) {
  try {
    const status = (new URL(req.url).searchParams.get("status") ?? "pending") as QuestionStatus | "all";
    const questions = listQuestions(status);
    return NextResponse.json(
      { questions, pendingCount: countPendingQuestions() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
