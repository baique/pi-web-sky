// ============================================================================
// 会话索引扫描器（session_meta 完整索引的维护者）
//
// 背景：会话列表重构 v2 把「会话发现」从请求路径挪到后台——pi-web 自己承担
// 扫描磁盘会话目录的职责，把所有会话全量写入 session_meta（含老会话/外部
// CLI 新建），使列表读取退化为纯单表查询。
//
// 一轮 tick 做的事：
//   1. scanSessionFileMeta()：全量 readdir + stat（不读内容，递归到子目录），拿磁盘会话全集
//   2. 与 session_meta 现有行 diff（path 是会话与文件的唯一绑定，行匹配 path 优先）：
//      - 磁盘有、库无 → 读 header（scanOneSessionHead）→ 用 **header 的 id** 建行
//        （子目录里的 `session.jsonl` 没有文件名 id 可猜）→ resolveProject 算
//        project_key → INSERT（created/mtime/first_message）
//      - 磁盘有、库有、mtime 变 → 读 header 首行校验 parent_id（重挂收敛）+ 刷 modified
//      - 库有、磁盘无 → 删前磁盘复检 + 年轻行保护后 DELETE
//   3. last_reply 回填：`last_reply IS NULL` 的行读一次文件尾（无回复写 ''）→ 存量会话的
//      「最后一条消息」入库存档，读取路径从此不再读文件
//   4. 归属收敛：子会话继承父会话 task_id（多层脏链一轮收敛）
//   5. 全程幂等（session_id 主键 upsert 语义），可重复执行。
//
// 明确不做：不读文件尾部追外部改名/标题（title 由本应用改名写库）；存量 `last_reply`
// 仅一次性回填（见下）。外部改动导致 mtime 变化只刷新排序键（且单调，不回退）；
// header 首行仅用于 parent_id 校验（成本可忽略，父链以磁盘 header 为权威）。
//
// last_reply 三态：NULL = 未回填（读一次文件尾）、'' = 回填过但无回复、文本 = 真实回复。
// 事件链路（agent_settled）写真实回复，列表/看板卡只读库。
//
// 调度：startSessionIndexScanner() 在 instrumentation.ts 注册（globalThis
// 防热重载重复启动），启动即跑首轮 + 定期续跑；runSessionIndexScan() 提供
// 懒初始化入口（列表读取前确保至少跑过一轮）。
// ============================================================================
import { existsSync } from "fs";
import { getDb } from "./sqlite-db";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { scanOneSessionHead, scanSessionFileMeta, readSessionTail, type SessionFileMeta } from "./session-scanner";
import { markSessionListChanged } from "./session-list-signal";
import { resolveProject } from "./worktree";

/** 一轮扫描的变更摘要（日志/测试断言用）。 */
export interface SessionIndexScanSummary {
  /** 本轮在磁盘上解析出的会话数（非会话 jsonl 不计；同 id 多副本只算一个）。 */
  scanned: number;
  inserted: number;
  updated: number;
  deleted: number;
}

/** 默认扫描周期：30s（外部/CLI 新建会话最长等一个周期进列表）。 */
export const SESSION_INDEX_SCAN_INTERVAL_MS = 30_000;

/** 归属收敛单轮扫描最多继承几层（单条 UPDATE 一次只能修一层，见 runSessionIndexScan；
 *  正常链路最多 2–3 层，8 是防病态深链/环的上限）。 */
const INHERIT_MAX_PASSES = 8;

/** 删除分支的「年轻行保护」窗口：行 `updated` 在最近 60s 内则不删（见 runSessionIndexScan）。 */
const YOUNG_ROW_PROTECT_MS = 60_000;

/**
 * 单文件立即索引：新会话文件已落盘但等不及后台扫描时调用（如 fork_branch 创建
 * 的引用分支，需立刻出现在会话列表）。幂等 upsert，parent 由调用方显式指定
 * （磁盘 header 的父路径反查需要全量 path 映射，单文件场景不划算）。
 * `taskId` 为会话归属（调用方传入源会话的 task_id）：归属继承必须在建行时完成，
 * 否则会话会先以临时会话现身聊天区（V1 两区重复）。ON CONFLICT 不覆盖已有归属。
 */
export async function indexSessionFileNow(
  filePath: string,
  parentSessionId: string | null,
  taskId: string | null = null,
): Promise<void> {
  const head = scanOneSessionHead(filePath);
  if (!head) return;
  const projectKey = await resolveProject(head.cwd).then((p) => projectIdentityKey(p?.projectRoot ?? head.cwd));
  getDb()
    .prepare(
      `INSERT INTO session_meta
         (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified)
       VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         path = excluded.path,
         cwd = excluded.cwd,
         project_key = excluded.project_key,
         -- first_message 只补空：调用方不传（NULL）时不再把已有的首条消息擦掉。
         first_message = COALESCE(session_meta.first_message, excluded.first_message),
         parent_id = excluded.parent_id,
         created = excluded.created,
         modified = excluded.modified`,
    )
    .run(
      head.id,
      taskId,
      Date.now(),
      filePath,
      head.cwd,
      projectKey,
      head.firstMessage || null,
      parentSessionId,
      head.created.getTime(),
      Date.now(),
    );
  // 行已落库 → 列表可能变了（会话当场出现在列表/派生列被补上）。
  markSessionListChanged();
}

/** 一轮全量扫描。`sessionsDir` 仅在测试注入（默认走 agentDir）。 */
export async function runSessionIndexScan(
  sessionsDir?: string,
): Promise<SessionIndexScanSummary> {
  // 磁盘 → 会话 id：path 优先（path 是会话与文件的唯一绑定），header 是 id 的权威。
  // 同 id 多文件（pi 整文件重写留旧副本、子目录里同名副本）只认最新 mtime 文件——
  // 与「path 指向最新」一致。注意不能按文件名提示归组：子目录里的
  // `session.jsonl`、`*_scout_0_transcript.jsonl` 末段提示会撞名（都叫
  // session/transcript），按提示去重会把不同会话当成同一个丢掉。
  const allDiskFiles = await scanSessionFileMeta(sessionsDir);

  const db = getDb();
  const selectAll = db.prepare("SELECT session_id, modified, updated, path, parent_id, first_message FROM session_meta").all() as Array<{
    session_id: string;
    modified: number | null;
    updated: number;
    path: string | null;
    parent_id: string | null;
    first_message: string | null;
  }>;
  const rowById = new Map(selectAll.map((r) => [r.session_id, r]));
  const rowByPath = new Map(
    selectAll.filter((r) => r.path).map((r) => [sessionPathKey(r.path as string), r.session_id]),
  );

  type SessionHead = NonNullable<ReturnType<typeof scanOneSessionHead>>;
  const resolved = new Map<string, { file: SessionFileMeta; head?: SessionHead }>();
  // 本轮在磁盘上见到过的会话 id——删除分支的反面。
  const seenOnDisk = new Set<string>();
  const keepNewest = (sessionId: string, file: SessionFileMeta, head?: SessionHead): void => {
    const cur = resolved.get(sessionId);
    if (cur && cur.file.modified.getTime() >= file.modified.getTime()) return;
    resolved.set(sessionId, { file, head });
  };

  for (const file of allDiskFiles) {
    // 1) path 已绑库行 → 直接用库行 id，不读文件（header 不再参与：行已经指向本文件）。
    const boundRowId = rowByPath.get(sessionPathKey(file.path));
    if (boundRowId !== undefined) {
      keepNewest(boundRowId, file);
      continue;
    }
    // 2) path 未绑库行（新文件 / 被移动的文件 / 同 id 旧副本）→ 读 header，id 以 header 为准。
    const head = scanOneSessionHead(file.path);
    if (head) {
      keepNewest(head.id, file, head);
      continue;
    }
    // 3) header 读不出会话（非会话 jsonl、写到一半的坏行）→ 不建行也不刷列；
    //    只有文件名提示能对上库行时才算「该会话的文件还在磁盘」，免得读不出内容就删行。
    if (file.id && rowById.has(file.id)) seenOnDisk.add(file.id);
  }

  const summary: SessionIndexScanSummary = { scanned: resolved.size, inserted: 0, updated: 0, deleted: 0 };

  // 磁盘全量 path→id 映射（parent 路径反查父会话 id；含子目录里的文件）。
  const pathToId = new Map<string, string>();
  for (const [sessionId, entry] of resolved) pathToId.set(sessionPathKey(entry.file.path), sessionId);

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
       -- first_message 只补空（COALESCE）：库内已有首条消息时不被这次 upsert 的 NULL/旧值擦掉。
       -- 内容派生列的「变化收敛」由 reconcileFromHead 单独负责（走 mtime 前移/欠账分支）。
       first_message = COALESCE(session_meta.first_message, excluded.first_message),
       parent_id = excluded.parent_id,
       created = excluded.created,
       -- modified 也单调：path 迁移（文件被移动/重写）时不能用更旧的 mtime 把事件
       -- 链路刚写的「现在就活跃」拉回去（与 updateModifiedStmt 同一约定）。
       modified = CASE
         WHEN session_meta.modified IS NULL OR excluded.modified > session_meta.modified
         THEN excluded.modified ELSE session_meta.modified END`,
  );
  // modified 单调：事件链路刚写的「现在就活跃」不能被下一轮扫描用更旧的 mtime
  // 拉回去（列表读取会触发懒初始化扫描 → 这是可达路径）。
  const updateModifiedStmt = db.prepare(
    "UPDATE session_meta SET modified = ? WHERE session_id = ? AND (modified IS NULL OR modified < ?)",
  );
  const updateParentStmt = db.prepare("UPDATE session_meta SET parent_id = ? WHERE session_id = ?");
  const updateFirstMessageStmt = db.prepare("UPDATE session_meta SET first_message = ? WHERE session_id = ?");
  const deleteStmt = db.prepare("DELETE FROM session_meta WHERE session_id = ?");

  // resolve project + upsert（新文件或老行补全索引列共用）。header 由调用方传入：
  // 已读过的不重复读（子目录里的文件每轮都要靠 header 认 id）。
  const upsertFromDisk = async (file: SessionFileMeta, head: SessionHead, sessionId: string): Promise<void> => {
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
      sessionId,
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

  // 从磁盘读 head 并收敛派生列（parent_id 重挂 + first_message 回填）。
  // first_message 是内容派生列：文件写入了首条消息，索引必须跟随——
  // 否则 persist 建行的会话（first_message 恒 NULL）标题永远冻结。
  // 返回是否更新了 first_message（供 NULL 欠账补跑计数）。
  const reconcileFromHead = (file: SessionFileMeta, dbRow: { parent_id: string | null; first_message: string | null }, sessionId: string): boolean => {
    const head = scanOneSessionHead(file.path);
    if (!head) return false;
    const parentId = head.parentSessionPath
      ? (pathToId.get(sessionPathKey(head.parentSessionPath)) ?? null)
      : null;
    if (parentId !== dbRow.parent_id) {
      updateParentStmt.run(parentId, sessionId);
    }
    if (head.firstMessage && head.firstMessage !== dbRow.first_message) {
      updateFirstMessageStmt.run(head.firstMessage, sessionId);
      return true;
    }
    return false;
  };

  for (const [sessionId, entry] of resolved) {
    const { file } = entry;
    seenOnDisk.add(sessionId);
    const dbRow = rowById.get(sessionId);
    if (dbRow === undefined || !dbRow.path || dbRow.path !== file.path) {
      // 磁盘有、库无 → 建行；库行 path 空（pin/rename 建的行）/ 指向旧副本 / 文件被移动
      // → 用磁盘最新文件 upsert 修正（path 指向最新，不保留旧 path）。
      const head = entry.head ?? scanOneSessionHead(file.path);
      if (!head) continue; // header 读不出 → 不写半行，下一轮再看
      await upsertFromDisk(file, head, sessionId);
      summary.inserted += 1;
    } else if (dbRow.modified === null || file.modified.getTime() > dbRow.modified) {
      // mtime 前移（真的又活跃了）：刷新排序键；同时收敛派生列——parent 链（删除会话
      // 级联重挂/外部重挂会改 header.parentSession）与 first_message（内容写入
      // 后标题必须跟随）。磁盘 header 是父链唯一权威，文件头是标题事实源。
      // 只认「前移」：modified 已被事件链路写成 now() 时，库里值 >= mtime（文件头/尾巴
      // 还没落盘），若用 !== 判等，每轮扫描都会多读一次 header 并记一次幻影 updated，
      // 「幂等扫描」不再成立（mtime 真变新的场景由下面的 > 覆盖，不受影响）。
      reconcileFromHead(file, dbRow, sessionId);
      updateModifiedStmt.run(file.modified.getTime(), sessionId, file.modified.getTime());
      summary.updated += 1;
    } else if (!dbRow.first_message) {
      // first_message 欠账补跑：persist 建行的老会话（first_message 恒 NULL）
      // 在 mtime 已同步后仍需回填一次；文件已有首条消息则写入，否则保持 NULL。
      if (reconcileFromHead(file, dbRow, sessionId)) {
        summary.updated += 1;
      }
    }
  }

  // 库有、磁盘无 → 删除（会话被外部/本应用删除）。
  const deleteCheckedAt = Date.now();
  for (const row of selectAll) {
    if (seenOnDisk.has(row.session_id)) continue;
    // 删前以磁盘复检：扫描快照后新建/移动的会话（persist 建行 + 文件落盘）
    // 可能不在本轮快照里，直接删会把刚建的行误删成“列表消失”。path 指向
    // 存在的文件 → 跳过（下一轮扫描会正常 diff）。
    if (row.path && existsSync(row.path)) continue;
    // 年轻行保护：内置 subagent 等会话是「先建行、SDK 惰性 flush 才落盘」，行刚建
    // 完时磁盘上还没有对应文件。这种行删了会在下一轮重新建行 → 列表闪断 + 归属丢失。
    // 只跳过、下一轮再判（外部删除的新会话最多晚 60s 从列表消失）。
    // 前提：扫描器的 upsert 只在**新建行**时写 updated；ON CONFLICT 分支不写 updated
    // （顶上的 INSERT 列了 updated，但 DO UPDATE SET 列表里没有它）—— 若把
    // updated = excluded.updated 加进冲突分支，每轮扫描都会把自己的行重新变
    // 「年轻」，外部删除就永不收敛。
    if (deleteCheckedAt - row.updated < YOUNG_ROW_PROTECT_MS) continue;
    deleteStmt.run(row.session_id);
    summary.deleted += 1;
  }

  // 归属收敛：子会话 task_id 为空而父会话有归属 → 继承父（自愈旧数据与写库失败的窗口；
  // 「归属按子树存」是本应用的约定，用户单独把子会话移出任务的状态不会出现）。
  // 单条 UPDATE 每轮只能修一层（SQLite 用语句开始时的快照求值，实测 A(T)←B←C 只修 B），
  // 故循环到无变化为止，使多层脏链在一轮扫描内整体收敛。
  const inheritTaskStmt = db.prepare(
    `UPDATE session_meta AS c
        SET task_id = (SELECT p.task_id FROM session_meta AS p WHERE p.session_id = c.parent_id)
      WHERE c.task_id IS NULL
        AND c.parent_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM session_meta AS p WHERE p.session_id = c.parent_id AND p.task_id IS NOT NULL)`,
  );
  for (let pass = 0; pass < INHERIT_MAX_PASSES; pass += 1) {
    const changes = Number(inheritTaskStmt.run().changes); // changes 类型为 number|bigint
    if (changes === 0) break;
    summary.updated += changes;
  }

  // last_reply 一次性回填（存量会话）：三态里只有 NULL 才读文件尾——读一次拿到
  // 「最后一条 assistant 回复」（无回复写 ''），之后读取路径（列表/看板卡）再也不摸盘。
  // 文件不可读/不存在 → 保持 NULL，下一轮再试（与删除分支的磁盘复检同思路）。
  const pendingReplyRows = db
    .prepare("SELECT session_id, path FROM session_meta WHERE last_reply IS NULL AND path IS NOT NULL")
    .all() as Array<{ session_id: string; path: string }>;
  if (pendingReplyRows.length > 0) {
    const backfillReplyStmt = db.prepare(
      "UPDATE session_meta SET last_reply = ? WHERE session_id = ? AND last_reply IS NULL",
    );
    for (const row of pendingReplyRows) {
      const tail = readSessionTail(row.path);
      if (!tail) continue;
      backfillReplyStmt.run(tail.lastReply || "", row.session_id);
      summary.updated += 1;
    }
  }

  // 本轮真改了什么 → 通知列表读者（外部/CLI 新建的会话、首条消息/最后回复回填、
  // 删除都走这里；无变更不 mark，避免每 30s 空推一次前端重拉）。
  if (summary.inserted > 0 || summary.updated > 0 || summary.deleted > 0) {
    markSessionListChanged();
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
      console.log(`[pi-web] session index scan: +${summary.inserted} ~${summary.updated} -${summary.deleted} (${summary.scanned} sessions)`);
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
