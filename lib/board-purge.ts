// 孤儿看板卡片清理：左栏删除会话后，看板上对应卡片（refId 指向已删会话的
// board_nodes 节点）与指向它的连线成为孤儿数据。进入看板时懒加载清理一次。
//
// 孤儿判定（防误删"创建中"会话）：
// - refId 非空（draft 卡 refId=null 不动）
// - 会话文件不存在（resolveSessionPath === null；listAllSessions 已填充路径缓存）
// - session_meta 无该会话记录（任务会话创建即写 meta，文件延迟落盘也安全）
// 运行中会话文件存在，天然不被删。

import { getDb } from "./sqlite-db";
import { listAllSessions, resolveSessionPath } from "./session-reader";
import { deleteNodesByIds } from "./board-store";
import { SYSTEM_RUNNING_BOARD_ID } from "./board-types";

export interface PurgeResult {
  /** 实际删除的卡片数 */
  deletedNodes: number;
  /** 级联删除的连线数 */
  deletedEdges: number;
  /** 受影响的看板 id 列表 */
  boards: string[];
}

/** 清理全部看板上的孤儿卡片（级联删连线）。无孤儿时返回全 0。 */
export async function purgeOrphanBoardCards(): Promise<PurgeResult> {
  // 1. 收集全部绑定节点（refId 非空），跳过系统看板（running 只读）
  const nodes = getDb()
    .prepare("SELECT id, board_id AS boardId, ref_id AS refId FROM board_nodes WHERE ref_id IS NOT NULL AND board_id != ?")
    .all(SYSTEM_RUNNING_BOARD_ID) as Array<{ id: string; boardId: string; refId: string }>;
  if (nodes.length === 0) return { deletedNodes: 0, deletedEdges: 0, boards: [] };

  // 2. 权威会话集合：listAllSessions（填路径缓存）+ session_meta（任务会话即写）
  const sessions = await listAllSessions();
  const aliveIds = new Set(sessions.map((s) => s.id));
  const metaRows = getDb().prepare("SELECT session_id FROM session_meta").all() as Array<{ session_id: string }>;
  const metaIds = new Set(metaRows.map((r) => r.session_id));

  // 3. 逐个判定孤儿（resolveSessionPath 走路径缓存，接近内存查询）
  const orphanIds: string[] = [];
  for (const n of nodes) {
    if (aliveIds.has(n.refId) || metaIds.has(n.refId)) continue;
    const p = await resolveSessionPath(n.refId);
    if (p === null) orphanIds.push(n.id);
  }
  if (orphanIds.length === 0) return { deletedNodes: 0, deletedEdges: 0, boards: [] };

  // 4. 批量删除（级联删边 + bump 看板 updated，单事务）
  const result = deleteNodesByIds(orphanIds);
  return {
    deletedNodes: result.deletedNodes,
    deletedEdges: result.deletedEdges,
    boards: result.boards,
  };
}
