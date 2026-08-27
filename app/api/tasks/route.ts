import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/task-store";

export const dynamic = "force-dynamic";

// GET /api/tasks?projectKey=<key>
export async function GET(req: Request) {
  try {
    const projectKey = new URL(req.url).searchParams.get("projectKey") ?? "";
    const tasks = listTasks(projectKey);
    return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// POST /api/tasks  body: { projectKey: string, name: string }
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { projectKey?: string; name?: string };
    if (typeof body.projectKey !== "string" || !body.projectKey.trim()) {
      return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const task = createTask(body.projectKey, body.name);
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}