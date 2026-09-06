// ============================================================================
// 会话索引扫描器（session_meta 完整索引的维护者）
//
// 背景：会话列表重构 v2 把「会话发现」从请求路径挪到后台——pi-web 自己承担
// 扫描磁盘会话目录的职责，把所有会话全量写入 session_meta（含老会话/外部
// CLI 新建），使列表读取退化为纯单表查询。
//
// 一轮 tick 做的事：
//   1. scanSessionFileMeta()：全量 readdir + stat（不读内容），拿磁盘会话全集
//   2. 与 session_meta 现有行 diff：
//      - 磁盘有、库无 → 读 header（scanOneSessionHead）→ resolveProject 算
//        project_key → INSERT（created/mtime/first_message）
//      - 磁盘有、库有、mtime 变 → 读 header 首行校验 parent_id（重挂收敛）+ 刷 modified
//      - 库有、磁盘无 → 删前磁盘复检后 DELETE（防扫描快照后新建被误删）
//   3. 全程幂等（session_id 主键 upsert 语义），可重复执行。
//
// 明确不做：不读文件尾部（不追外部改名——title 由本应用改名写库）；不存
// last_reply（列表尾读）。外部改动导致 mtime 变化只刷新排序键；header 首行
// 仅用于 parent_id 校验（成本可忽略，父链以磁盘 header 为权威）。
//
// 调度：startSessionIndexScanner() 在 instrumentation.ts 注册（globalThis
// 防热重载重复启动），启动即跑首轮 + 定期续跑；runSessionIndexScan() 提供
// 懒初始化入口（列表读取前确保至少跑过一轮）。
// ============================================================================
import { existsSync } from "fs";
import { getDb } from "./sqlite-db";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { scanOneSessionHead, scanSessionFileMeta } from "./session-scanner";
import { resolveProject } from "./worktree";

/** 一轮扫描的变更摘要（日志/测试断言用）。 */
export interface SessionIndexScanSummary {
  scanned: number;
  inserted: number;
  updated: number;
  deleted: number;
}

/** 默认扫描周期：30s（外部/CLI 新建会话最长等一个周期进列表）。 */
export const SESSION_INDEX_SCAN_INTERVAL_MS = 30_000;

/** 一轮全量扫描。`sessionsDir` 仅在测试注入（默认走 agentDir）。 */
export async function runSessionIndexScan(
  sessionsDir?: string,
): Promise<SessionIndexScanSummary> {
  // 磁盘同 id 可能有多个历史文件（pi 整文件重写留旧副本）——索引只认每个
  // id 的「最新 mtime 文件」，旧副本忽略（path 指向最新，排序用最新 mtime）。
  const allDiskFiles = await scanSessionFileMeta(sessionsDir);
  const newestByFile = new Map<string, { path: string; id: string; modified: Date }>();
  for (const f of allDiskFiles) {
    const cur = newestByFile.get(f.id);
    if (!cur || f.modified.getTime() > cur.modified.getTime()) newestByFile.set(f.id, f);
  }
  const diskFiles = [...newestByFile.values()];
  const summary: SessionIndexScanSummary = { scanned: diskFiles.length, inserted: 0, updated: 0, deleted: 0 };

  const db = getDb();
  const selectAll = db.prepare("SELECT session_id, modified, path, parent_id FROM session_meta").all() as Array<{
    session_id: string;
    modified: number | null;
    path: string | null;
    parent_id: string | null;
  }>;
  const dbRows = new Map(selectAll.map((r) => [r.session_id, { modified: r.modified, path: r.path, parent_id: r.parent_id }]));

  const seenOnDisk = new Set<string>();

  // 磁盘全量 path→id 映射（parent 路径反查父会话 id；同目录多文件共用）。
  const pathToId = new Map<string, string>();
  for (const f of diskFiles) pathToId.set(sessionPathKey(f.path), f.id);

  // 同 cwd 目录的 project_key 共享一次 resolve（缓存 promise，防重复 git 调用）。
  const cwdToProjectKey = new Map<string, Promise<string>>();

  const insertStmt = db.prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified)
     VALUES (?, NULL, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       path = excluded.path,
       cwd = excluded.cwd,
       project_key = excluded.project_key,
       first_message = excluded.first_message,
       parent_id = excluded.parent_id,
       created = excluded.created,
       modified = excluded.modified`,
  );
  const updateModifiedStmt = db.prepare("UPDATE session_meta SET modified = ? WHERE session_id = ?");
  const updateParentStmt = db.prepare("UPDATE session_meta SET parent_id = ? WHERE session_id = ?");
  const deleteStmt = db.prepare("DELETE FROM session_meta WHERE session_id = ?");

  // 读 header + resolve project + upsert（新文件或老行补全索引列共用）。
  const upsertFromDisk = async (file: { path: string; id: string; modified: Date }): Promise<void> => {
    const head = scanOneSessionHead(file.path);
    if (!head) return;
    let projectPromise = cwdToProjectKey.get(head.cwd);
    if (!projectPromise) {
      projectPromise = resolveProject(head.cwd).then((p) => projectIdentityKey(p?.projectRoot ?? head.cwd));
      cwdToProjectKey.set(head.cwd, projectPromise);
    }
    const projectKey = await projectPromise;
    const parentId = head.parentSessionPath
      ? (pathToId.get(sessionPathKey(head.parentSessionPath)) ?? null)
      : null;
    insertStmt.run(
      file.id,
      Date.now(),
      file.path,
      head.cwd,
      projectKey,
      head.firstMessage || null,
      parentId,
      head.created.getTime(),
      file.modified.getTime(),
    );
  };

  for (const file of diskFiles) {
    seenOnDisk.add(file.id);
    const dbRow = dbRows.get(file.id);
    if (dbRow === undefined || !dbRow.path || dbRow.path !== file.path) {
      // 磁盘有、库无 → 建行；库行 path 空（T1 前遗留归属行）或指向旧副本 →
      // 用磁盘最新文件 upsert 修正（path 指向最新，不保留旧副本 path）。
      await upsertFromDisk(file);
      summary.inserted += 1;
    } else if (dbRow.modified === null || dbRow.modified !== file.modified.getTime()) {
      // mtime 变化：刷新排序键；同时校验 parent 链——删除会话级联重挂/外部
      // 重挂会改 header.parentSession 但行内 parent_id 不会自己变。读 header
      // 首行（与 buildTaskSessionIndex 同成本）比对，不一致则更新：磁盘
      // header 是父链唯一权威，任何来源的重挂都在这里收敛。
      const head = scanOneSessionHead(file.path);
      if (head) {
        const parentId = head.parentSessionPath
          ? (pathToId.get(sessionPathKey(head.parentSessionPath)) ?? null)
          : null;
        if (parentId !== dbRow.parent_id) {
          updateParentStmt.run(parentId, file.id);
        }
      }
      updateModifiedStmt.run(file.modified.getTime(), file.id);
      summary.updated += 1;
    }
  }

  // 库有、磁盘无 → 删除（会话被外部/本应用删除）。
  for (const sessionId of dbRows.keys()) {
    if (!seenOnDisk.has(sessionId)) {
      // 删前以磁盘复检：扫描快照后新建/移动的会话（persist 建行 + 文件落盘）
      // 可能不在本轮快照里，直接删会把刚建的行误删成“列表消失”。path 指向
      // 存在的文件 → 跳过（下一轮扫描会正常 diff）。
      const row = dbRows.get(sessionId);
      if (row?.path && existsSync(row.path)) continue;
      deleteStmt.run(sessionId);
      summary.deleted += 1;
    }
  }

  return summary;
}

/** 首轮是否完成（懒初始化检查用）。 */
declare global {
  var __piSessionIndexScanner: {
    timer?: ReturnType<typeof setInterval>;
    firstScanDone: boolean;
    firstScanPromise?: Promise<void>;
  } | undefined;
}

/** 首轮是否完成（懒初始化检查用）。 */
export function isSessionIndexReady(): boolean {
  return Boolean(globalThis.__piSessionIndexScanner?.firstScanDone);
}

/** 确保索引至少跑过一轮（列表读取前调用）。
 *  已有扫描器（含首轮在途）→ 复用其首轮 promise，不重复扫；无扫描器
 *  （单测/纯读取进程）→ 自己跑一轮并标记 ready。 */
export async function ensureSessionIndexReady(sessionsDir?: string): Promise<void> {
  const scanner = globalThis.__piSessionIndexScanner;
  if (scanner?.firstScanDone) return;
  if (scanner?.firstScanPromise) {
    await scanner.firstScanPromise;
    // 首轮失败时 firstScanPromise 已 resolve 但 firstScanDone 仍 false → 补扫一轮重试。
    // 补扫失败保持 not-ready（下次 ensure 再试），不向上抛：列表读取降级为空表可接受。
    if (!globalThis.__piSessionIndexScanner?.firstScanDone) {
      try {
        await runSessionIndexScan(sessionsDir);
        if (globalThis.__piSessionIndexScanner) {
          globalThis.__piSessionIndexScanner.firstScanDone = true;
        }
      } catch (e) {
        console.error("[pi-web] session index ensure retry error:", e instanceof Error ? e.message : String(e));
      }
    }
    return;
  }
  await runSessionIndexScan(sessionsDir);
  globalThis.__piSessionIndexScanner = {
    firstScanDone: true,
  };
}

/** 启动定时扫描（instrumentation 注册；globalThis 防热重载重复启动）。 */
export function startSessionIndexScanner(): void {
  if (globalThis.__piSessionIndexScanner?.timer) return;
  let tickInFlight = false;
  const firstScanResult = runSessionIndexScan()
    .then((summary) => {
      console.log(`[pi-web] session index scan: +${summary.inserted} ~${summary.updated} -${summary.deleted} (${summary.scanned} files)`);
      return { ok: true as const };
    })
    .catch((e) => {
      console.error("[pi-web] session index first scan error:", e?.message ?? e);
      return { ok: false as const };
    });

  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runSessionIndexScan()
      .catch((e) => console.error("[pi-web] session index tick error:", e?.message ?? e))
      .finally(() => { tickInFlight = false; });
  }, SESSION_INDEX_SCAN_INTERVAL_MS);
  timer.unref?.();

  const scanner: NonNullable<typeof globalThis.__piSessionIndexScanner> = {
    timer,
    firstScanDone: false,
    firstScanPromise: firstScanResult.then((res) => {
      // 首轮成功才置 ready；失败保持 false，ensureSessionIndexReady 会重扫一轮重试。
      if (res.ok) scanner.firstScanDone = true;
    }),
  };
  globalThis.__piSessionIndexScanner = scanner;
  console.log(`[pi-web] session index scanner started (interval ${SESSION_INDEX_SCAN_INTERVAL_MS}ms)`);
}

/** 测试辅助：清空扫描器状态与 projectKey 缓存。 */
export function resetSessionIndexScannerForTests(): void {
  if (globalThis.__piSessionIndexScanner?.timer) {
    clearInterval(globalThis.__piSessionIndexScanner.timer);
  }
  globalThis.__piSessionIndexScanner = undefined;
}
