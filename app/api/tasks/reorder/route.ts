import { NextResponse } from "next/server";
import { reorderTasks } from "@/lib/task-store";

export const dynamic = "force-dynamic";

/**
 * PUT /api/tasks/reorder
 * body: { projectKey: string, orderedIds: string[] }
 *
 * 批量重排任务（一个置顶/非置顶区内的完整有序 id 列表）。sort_order 按数组
 * 下标写入（0 起）。跨区（置顶↔非置顶）不在本接口职责内——调用方按区分别调用。
 */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      projectKey?: unknown;
      orderedIds?: unknown;
    };
    if (typeof body.projectKey !== "string" || !body.projectKey.trim()) {
      return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
    }
    if (
      !Array.isArray(body.orderedIds)
      || body.orderedIds.some((x) => typeof x !== "string")
    ) {
      return NextResponse.json({ error: "orderedIds must be a string array" }, { status: 400 });
    }
    const tasks = reorderTasks(body.projectKey, body.orderedIds);
    return NextResponse.json({ tasks }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
