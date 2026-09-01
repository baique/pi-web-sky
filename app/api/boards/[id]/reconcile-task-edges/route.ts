import { NextResponse } from "next/server";
import { getBoard, reconcileBoardTaskEdges } from "@/lib/board-store";

export const dynamic = "force-dynamic";

// POST /api/boards/[id]/reconcile-task-edges
// 画布加载后兜底：对该看板所有任务卡 reconcile 派生边（依赖线 + exec 线）。
// 幂等（只补缺失边）；历史任务卡（syncExecEdge 引入前）由此补上 exec 线。
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    if (!getBoard(id)) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    reconcileBoardTaskEdges(id);
    // reconcile 建边会 bump boards.updated：返回最新基线，前端刷新乐观锁，防后续保存 409
    return NextResponse.json({ ok: true, updated: getBoard(id)?.updated ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
