import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/task-store";
import { loadTaskSessionsPage } from "@/lib/session-reader";

export const dynamic = "force-dynamic";

// GET /api/tasks?projectKey=<key>[&offset=0&limit=5]
//   每任务附会话详情（置顶全量 + 非置顶 offset/limit + rootTotal + sessionTotal）——
//   服务端分流，前端零归属判断（不再用 /api/sessions join task.sessionIds 反查）。
export async function GET(req: Request) {
  try {
    const search = new URL(req.url).searchParams;
    const projectKey = search.get("projectKey") ?? "";
    const rawOffset = Number(search.get("offset"));
    const rawLimit = Number(search.get("limit"));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 5;
    const tasks = listTasks(projectKey);
    const tasksWithSessions = await Promise.all(
      tasks.map(async (task) => ({
        ...task,
        ...(await loadTaskSessionsPage(task.id, offset, limit)),
      })),
    );
    return NextResponse.json(
      { tasks: tasksWithSessions },
      { headers: { "Cache-Control": "no-store" } },
    );
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