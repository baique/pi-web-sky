// 会话文件树删除 —— 供「删除任务 = 删除任务下所有会话（含 fork 子树）」使用。
//
// 与单个会话删除（app/api/sessions/[id] DELETE）不同：那里删一个节点并把
// 子树级联重挂到父级；这里整棵树全部删除，不做重挂。

import { unlinkSync } from "fs";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  resolveSessionPath,
} from "./session-reader";
import { getRpcSession } from "./rpc-manager";
import { listDescendantIds, unassignSession } from "./task-store";
import { removeSessionFromBoards } from "./board-store";
import { removeSessionsFromYjsBoards } from "./board-reconcile";

/** 递归收集一个会话的全部 fork 后代 id（含自身）。
 *
 *  父子链以 session_meta.parent_id 为唯一事实源：旧实现 readdirSync 平铺会话目录
 *  + 读每个文件 header 推父链，既漏掉子目录里的 fork（`<session>/forks/…`），
 *  也在每次删任务时把整个项目目录读一遍。库里的 parent_id 已含全部副本。 */
export async function collectSessionDescendants(rootId: string): Promise<string[]> {
  return [rootId, ...listDescendantIds(rootId)];
}

/** 删除单个会话文件（含 RPC/路径缓存/列表缓存/任务元数据/画布引用），不重挂子树。 */
export async function deleteSessionFile(id: string): Promise<void> {
  // 画布引用清理（断 exec 线/清任务卡/删节点）：无文件也执行，幂等；
  // 任务整树删除时任务看板已由 deleteBoardCascade 清，此处对手动看板残留兜底。
  removeSessionFromBoards(id);
  const filePath = await resolveSessionPath(id);
  if (!filePath) return;
  await getRpcSession(id)?.shutdown();
  try {
    unlinkSync(filePath); // 文件已被并发删除/缓存残留时忽略（健壮删除）
  } catch { /* ignore */ }
  invalidateSessionPathCache(id);
  invalidateSessionListCache();
  unassignSession(id);
}

/**
 * 删除一组会话（每个根会话连同其 fork 子树），返回实际删除的全部会话 id。
 * 单个文件失败不中断其余删除。
 */
export async function deleteSessionTrees(rootIds: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const deleted: string[] = [];
  for (const rootId of rootIds) {
    const ids = await collectSessionDescendants(rootId);
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        await deleteSessionFile(id);
        deleted.push(id);
      } catch { /* keep deleting the rest */ }
    }
  }
  // RF 画布（yjs）清理：从所有普通看板移除这些会话的卡（含占位卡）。
  // 任务看板由删除方（deleteTask）整体销毁文档，这里一并处理也无害；
  // 无 __yjsBoard（测试/独立构建）时为空操作。
  await removeSessionsFromYjsBoards(deleted);
  return deleted;
}
