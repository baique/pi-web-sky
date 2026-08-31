import { NextResponse } from "next/server";
import { getSchedulerStatus } from "@/lib/task-scheduler";

export const dynamic = "force-dynamic";

// GET /api/task-scheduler/status → { status: TaskSchedulerStatus }
// 看板调度状态展示用：当前运行中的调度任务 + 最近一次调度动作。
export async function GET() {
  try {
    const status = getSchedulerStatus();
    return NextResponse.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
