import { NextResponse } from "next/server";
import { answerQuestion } from "@/lib/task-card-store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// POST /api/task-card-questions/[id]/answer  body: { answer: string }
// 用户作答 → status=answered（调度器回复队列拾取后续会话）。
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { answer?: unknown };
    if (typeof body.answer !== "string" || !body.answer.trim()) {
      return NextResponse.json({ error: "answer is required" }, { status: 400 });
    }
    const q = answerQuestion(id, body.answer.trim());
    if (!q) {
      return NextResponse.json({ error: "Question not found" }, { status: 404 });
    }
    return NextResponse.json({ question: q });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 },
    );
  }
}
