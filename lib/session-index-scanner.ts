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
//      - 磁盘有、库有、mtime 变 → UPDATE modified（不读内容）
//      - 库有、磁盘无 → DELETE
//   3. 全程幂等（session_id 主键 upsert 语义），可重复执行。
//
// 明确不做：不读文件尾部（不追外部改名——title 由本应用改名写库）；不存
// last_reply（列表尾读）。外部改动导致 mtime 变化只刷新排序键。
//
// 调度：startSessionIndexScanner() 在 instrumentation.ts 注册（globalThis
// 防热重载重复启动），启动即跑首轮 + 定期续跑；runSessionIndexScan() 提供
// 懒初始化入口（列表读取前确保至少跑过一轮）。
// ============================================================================
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
  const diskFiles = await scanSessionFileMeta(sessionsDir);
  const summary: SessionIndexScanSummary = { scanned: diskFiles.length, inserted: 0, updated: 0, deleted: 0 };

  const db = getDb();
  const selectAll = db.prepare("SELECT session_id, modified FROM session_meta").all() as Array<{
    session_id: string;
    modified: number | null;
  }>;
  const dbRows = new Map(selectAll.map((r) => [r.session_id, r.modified]));

  const seenOnDisk = new Set<string>();

  // 磁盘全量 path→id 映射（parent 路径反查父会话 id；同目录多文件共用）。
  const pathToId = new Map<string, string>();
  for (const f of diskFiles) pathToId.set(sessionPathKey(f.path), f.id);

  // 按目录分组，每目录一次 project 解析（首次惰性；目录数远小于会话数）。
  const cwdToProjectKey = new Map<string, Promise<string>>();

  const insertStmt = db.prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified)
     VALUES (?, NULL, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  const updateModifiedStmt = db.prepare("UPDATE session_meta SET modified = ? WHERE session_id = ?");
  const deleteStmt = db.prepare("DELETE FROM session_meta WHERE session_id = ?");

  for (const file of diskFiles) {
    seenOnDisk.add(file.id);
    const dbModified = dbRows.get(file.id);
    if (dbModified === undefined) {
      // 新文件：读 header 建行（不读尾部）。读失败/非会话文件 → 跳过。
      const head = scanOneSessionHead(file.path);
      if (!head) continue;
      // 同 cwd 目录的 project_key 共享一次 resolve（缓存 promise，防重复 git 调用）。
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
      summary.inserted += 1;
    } else if (dbModified === null || dbModified !== file.modified.getTime()) {
      // mtime 变化：只刷新排序键，不读内容。
      updateModifiedStmt.run(file.modified.getTime(), file.id);
      summary.updated += 1;
    }
  }

  // 库有、磁盘无 → 删除（会话被外部/本应用删除）。
  for (const sessionId of dbRows.keys()) {
    if (!seenOnDisk.has(sessionId)) {
      // 运行中/未落盘的 registry 会话可能尚未落盘，不该删。但磁盘扫描只见落盘
      // 文件——落盘前不在磁盘、也不在 dbRows（persist 时才建行），所以不会误删。
      deleteStmt.run(sessionId);
      summary.deleted += 1;
    }
  }

  return summary;
}

declare global {
  var __piSessionIndexScanner: { timer: ReturnType<typeof setInterval>; firstScanDone: boolean } | undefined;
}

/** 首轮是否完成（懒初始化检查用）。 */
export function isSessionIndexReady(): boolean {
  return Boolean(globalThis.__piSessionIndexScanner?.firstScanDone);
}

/** 确保索引至少跑过一轮（列表读取前调用）。 */
export async function ensureSessionIndexReady(sessionsDir?: string): Promise<void> {
  if (isSessionIndexReady()) return;
  await runSessionIndexScan(sessionsDir);
  if (globalThis.__piSessionIndexScanner) {
    globalThis.__piSessionIndexScanner.firstScanDone = true;
  } else {
    // 未启动调度器（如单测直接调 run）——标记一个瞬时 ready。
    globalThis.__piSessionIndexScanner = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      firstScanDone: true,
    };
  }
}

/** 启动定时扫描（instrumentation 注册；globalThis 防热重载重复启动）。 */
export function startSessionIndexScanner(): void {
  if (globalThis.__piSessionIndexScanner) return;
  let tickInFlight = false;
  const firstScan = runSessionIndexScan()
    .then((summary) => {
      console.log(`[pi-web] session index scan: +${summary.inserted} ~${summary.updated} -${summary.deleted} (${summary.scanned} files)`);
    })
    .catch((e) => console.error("[pi-web] session index first scan error:", e?.message ?? e));

  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void runSessionIndexScan()
      .catch((e) => console.error("[pi-web] session index tick error:", e?.message ?? e))
      .finally(() => { tickInFlight = false; });
  }, SESSION_INDEX_SCAN_INTERVAL_MS);
  timer.unref?.();

  globalThis.__piSessionIndexScanner = { timer, firstScanDone: false };
  // 首轮完成即置 ready（懒初始化 await 的是 ensureSessionIndexReady 自己跑的轮次，
  // 这里异步置位，避免竞态：ensure 在启动瞬间调用时 firstScanDone 仍 false 会自跑一次，
  // 幂等无害）。
  void firstScan.then(() => {
    if (globalThis.__piSessionIndexScanner) {
      globalThis.__piSessionIndexScanner.firstScanDone = true;
    }
  });
  console.log(`[pi-web] session index scanner started (interval ${SESSION_INDEX_SCAN_INTERVAL_MS}ms)`);
}

/** 测试辅助：清空扫描器状态与 projectKey 缓存。 */
export function resetSessionIndexScannerForTests(): void {
  if (globalThis.__piSessionIndexScanner?.timer) {
    clearInterval(globalThis.__piSessionIndexScanner.timer);
  }
  globalThis.__piSessionIndexScanner = undefined;
}
