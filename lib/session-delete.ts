// 会话文件树删除 —— 供「删除任务 = 删除任务下所有会话（含 fork 子树）」使用。
//
// 与单个会话删除（app/api/sessions/[id] DELETE）不同：那里删一个节点并把
// 子树级联重挂到父级；这里整棵树全部删除，不做重挂。

import { readdirSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { sessionPathKey } from "./session-path";
import { getRpcSession } from "./rpc-manager";
import { unassignSession } from "./task-store";
import { removeSessionFromBoards } from "./board-store";
import { removeSessionsFromYjsBoards } from "./board-reconcile";

/** 递归收集一个会话的全部 fork 后代 id（含自身）。 */
export async function collectSessionDescendants(rootId: string): Promise<string[]> {
  const rootPath = await resolveSessionPath(rootId);
  if (!rootPath) return [rootId];
  const dir = dirname(rootPath);
  const keySet = new Set<string>([sessionPathKey(rootPath)]);
  const ids = [rootId];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [rootId];
  }
  // 迭代扫描：parentSession 指向已收集集合的 .jsonl 全部纳入（支持多级分叉）。
  let added = true;
  while (added) {
    added = false;
    for (const file of files) {
      const p = join(dir, file);
      const pk = sessionPathKey(p);
      if (keySet.has(pk)) continue;
      const header = readSessionHeader(p);
      if (header?.parentSession && keySet.has(sessionPathKey(header.parentSession))) {
        keySet.add(pk);
        ids.push(header.id);
        added = true;
      }
    }
  }
  return ids;
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
