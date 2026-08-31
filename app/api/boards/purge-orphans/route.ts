import { NextResponse } from "next/server";
import { purgeOrphanBoardCards } from "@/lib/board-purge";

export const dynamic = "force-dynamic";

// POST /api/boards/purge-orphans — 懒加载清理：删除指向已删会话的孤儿卡片（级联删连线）。
// 进入看板时调用一次；返回删除统计。无孤儿时全 0，幂等。
export async function POST() {
  const result = await purgeOrphanBoardCards();
  return NextResponse.json({ ...result });
}
