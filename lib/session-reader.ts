import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, openSync, readSync } from "fs";
import { readdir } from "fs/promises";
import { join as joinPath, basename as basenamePath, normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import { parseTodoSnapshot, TODO_STATE_CUSTOM_TYPE, type Todo } from "./todo-store";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { getDb } from "./sqlite-db";
import { normalizeToolCalls } from "./normalize";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";
import { scanOneSessionFile } from "./session-scanner";
import { ensureSessionIndexReady } from "./session-index-scanner";
import type { TurnIndexItem } from "./api-types";

export { getAgentDir };

type SessionMetaRow = Record<string, unknown>;

/** session_meta 行的读取列（列表 / 任务区 / 看板摘要共用一套映射）。 */
const META_SELECT_COLUMNS =
  "session_id, path, cwd, title, first_message, parent_id, created, modified, pinned, last_reply";

/** 单个 session_meta 行 → SessionInfo（聊天列表与任务列表共用的唯一映射）。
 *  lastReply 直接取库（v12 列：事件链路写真实回复、扫描器一次性回填存量）；
 *  NULL（未回填）与 ''（回填过但无回复）在 UI 上都表现为空串。 */
function mapSessionMetaRow(r: SessionMetaRow): SessionInfo {
  return {
    path: (r.path as string) ?? "",
    id: r.session_id as string,
    cwd: (r.cwd as string) ?? "",
    name: (r.title as string | null) ?? undefined,
    created: new Date((r.created as number) ?? 0).toISOString(),
    modified: new Date((r.modified as number) ?? 0).toISOString(),
    messageCount: 0,
    firstMessage: (r.first_message as string | null) ?? "(no messages)",
    lastReply: (r.last_reply as string | null) ?? "",
    parentSessionId: (r.parent_id as string | null) ?? undefined,
    pinned: Boolean((r.pinned as number) ?? 0),
  };
}

/** 按 id 集合查 session_meta 映射 SessionInfo（返回顺序与入参一致，无行 id 跳过）。
 *  任务列表详情与聊天列表 loadProjectSessions 完全同源——标题/首条消息/最后回复
 *  全部由 session_meta 供给，读取路径不读任何文件。 */
export async function loadSessionDetailsFromMeta(ids: string[]): Promise<SessionInfo[]> {
  if (ids.length === 0) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    rows = getDb()
      .prepare(
        `SELECT ${META_SELECT_COLUMNS}
         FROM session_meta WHERE session_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  const byId = new Map(rows.map((r) => [r.session_id as string, r]));
  const sessions: SessionInfo[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) sessions.push(mapSessionMetaRow(row));
  }
  return sessions;
}

/**
 * 当前项目聊天区会话（列表重构 v2 主读取路径）。
 *
 * 纯查 session_meta：按 project_key 过滤 + 排除任务会话（task_id 非空交任务区管），
 * 置顶优先 + modified 降序。**不读任何文件**（用户决策 4）：title 用 meta.title
 * （本应用改名写库），无自定义名回退 first_message，最后一条消息用 last_reply
 * （事件链路写入 + 扫描器一次性回填）。运行时/未落盘会话由调用方 union getRpcSessionInfos。
 */
export async function loadProjectSessions(projectKey: string): Promise<SessionInfo[]> {
  if (!projectKey) return [];
  await ensureSessionIndexReady();
  let rows: Array<Record<string, unknown>>;
  try {
    rows = getDb()
      .prepare(
        `SELECT ${META_SELECT_COLUMNS}
         FROM session_meta
         WHERE project_key = ? AND task_id IS NULL
         ORDER BY pinned DESC, modified DESC`,
      )
      .all(projectKey) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }

  return attachSessionProjectInfo(rows.map(mapSessionMetaRow));
}

/** 全项目会话索引读取（无参 /api/sessions：跨项目统计/项目下拉/hydrate/红点清理用）。
 *  纯查 session_meta 全表（含任务会话、含各项目），不整盘扫文件、也不读文件尾。 */
export async function loadAllSessionIndex(): Promise<SessionInfo[]> {
  await ensureSessionIndexReady();
  let rows: Array<Record<string, unknown>>;
  try {
    rows = getDb()
      .prepare(
        `SELECT ${META_SELECT_COLUMNS}
         FROM session_meta
         ORDER BY modified DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  } catch {
    return [];
  }

  return attachSessionProjectInfo(rows.map(mapSessionMetaRow));
}

export async function attachSessionProjectInfo(sessions: SessionInfo[]): Promise<SessionInfo[]> {
  const uniqueCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  // Pinned set from the task store (region-relative ordering lives client-side).
  let pinnedIds = new Set<string>();
  try {
    const rows = getDb()
      .prepare("SELECT session_id FROM session_meta WHERE pinned = 1")
      .all() as { session_id: string }[];
    pinnedIds = new Set(rows.map((r) => r.session_id));
  } catch {
    // db not available — fall back to nothing pinned
  }

  return sessions.map((session) => {
    const project = session.cwd ? projectByCwd.get(session.cwd) : undefined;
    const projectRoot = project?.projectRoot ?? session.cwd;
    return {
      ...session,
      projectRoot,
      projectKey: projectIdentityKey(projectRoot),
      ...(project?.branch ? { branch: project.branch } : {}),
      ...(project?.isWorktree ? { isWorktree: true } : {}),
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
      ...(pinnedIds.has(session.id) ? { pinned: true } : {}),
    };
  });
}

export function mergeSessionLists(
  persistedSessions: SessionInfo[],
  supplementalSessions: SessionInfo[],
): SessionInfo[] {
  const byId = new Map(supplementalSessions.map((session) => [session.id, session]));
  // A disk scan is authoritative once the JSONL exists. In particular, this
  // replaces a transient registry snapshot without briefly rendering two rows.
  for (const session of persistedSessions) byId.set(session.id, session);
  return [...byId.values()].sort((a, b) => b.modified.localeCompare(a.modified));
}

/** 任务会话详情按需分页（侧栏任务区）。
 *
 *  成员与父子链全部来自 session_meta（库是唯一事实源）：任务成员 = `task_id = 该任务`
 *  的全部节点；**根** = `parent_id` 为空或父不在本任务成员集合内的节点。这里不 readdir、
 *  不读 header（旧 buildTaskSessionIndex 每次请求全盘 readdir+读首行）。
 *
 *  每任务返回：置顶节点全量 + 非置顶根从 offset 起的 limit 个（含各自 fork 子树），
 *  外加 rootTotal（根数，前端「加载更多」游标）与 sessionTotal（任务下全部节点数，
 *  删除确认文案用）。响应字段与分页语义与旧实现一致，前端契约不变。
 */
export async function loadTaskSessionsPage(
  taskId: string,
  offset = 0,
  limit = 5,
): Promise<{ sessions: SessionInfo[]; rootTotal: number; sessionTotal: number; pinnedSessionIds: string[] }> {
  const { listPinnedTaskSessionIds } = await import("./task-store");
  // 冷启动闸门（与同族 loadProjectSessions / loadAllSessionIndex 一致）：任务成员来自
  // 库，而库要等首轮扫描才把磁盘会话建行。少了这一句，冷启动时任务区可能读到
  // 「任务在、会话 0」且之后无人重拉（30s 后才自愈）。
  // 闸门抛错（扫描器故障 / 库异常）不能穿透成路由 500：库里有上一轮扫描的行，
  // 照旧查库返回比空页 / 500 都好。这里的闸门只是「尽力补一轮」。
  try {
    await ensureSessionIndexReady();
  } catch (error) {
    // 文案保持中性：这里只知道「索引就绪检查失败」，库好不好是另一回事——库可用时下面
    // 照常返回库内行，库不可用时下面的查库 catch 降级为空页。旧文案「（继续查库）」把
    // 后一种情形说反了，会让排查者以为库没问题。
    console.error(
      "[pi-web] 任务区索引就绪检查失败（接着查库；库不可用则降级为空页）:",
      error instanceof Error ? error.message : String(error),
    );
  }
  // 同族读取函数（loadProjectSessions / loadAllSessionIndex）在 db 不可用时返回空，
  // 这里同样降级为空页（路由层不必因一次读不到库整个 /api/tasks 500）。
  // ORDER BY：成员顺序确定，让 modified 相同的根在 slice(offset, offset+limit)
  // 下分页稳定（rowid 升序＝建行顺序；下面的 sort 是稳定排序，同键保持此顺序）。
  let rows: Array<{ session_id: string; parent_id: string | null; modified: number | null }>;
  let pinnedSessionIds: string[];
  try {
    rows = getDb()
      .prepare("SELECT session_id, parent_id, modified FROM session_meta WHERE task_id = ? ORDER BY modified DESC, rowid")
      .all(taskId) as Array<{ session_id: string; parent_id: string | null; modified: number | null }>;
    pinnedSessionIds = listPinnedTaskSessionIds(taskId);
  } catch {
    return { sessions: [], rootTotal: 0, sessionTotal: 0, pinnedSessionIds: [] };
  }

  const memberIds = new Set(rows.map((r) => r.session_id));
  const modifiedOf = new Map<string, number>();
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const row of rows) {
    modifiedOf.set(row.session_id, row.modified ?? 0);
    if (row.parent_id && memberIds.has(row.parent_id)) {
      const siblings = childrenOf.get(row.parent_id) ?? [];
      siblings.push(row.session_id);
      childrenOf.set(row.parent_id, siblings);
    } else {
      roots.push(row.session_id);
    }
  }

  const collectSubtree = (rootId: string): string[] => {
    const out = [rootId];
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const child of childrenOf.get(cur) ?? []) {
        out.push(child);
        queue.push(child);
      }
    }
    return out;
  };

  // 排序键：modified（最后活动时间；session_meta.updated 只是归属/置顶时间，
  // 用它切页会把活跃会话切到后页而前端够不着）。
  const byModifiedDesc = (a: string, b: string) => (modifiedOf.get(b) ?? 0) - (modifiedOf.get(a) ?? 0);
  const pinnedSet = new Set(pinnedSessionIds);
  const nonPinnedRoots = roots.filter((id) => !pinnedSet.has(id)).sort(byModifiedDesc);

  // 当前页根 = 置顶节点全量（不受 offset 影响）+ 非置顶根 slice(offset, offset+limit)；子树跟随根。
  // 排序只作用于页序，返回的 pinnedSessionIds 保持库内原序（与旧实现一致）。
  const pageRootIds = [...[...pinnedSessionIds].sort(byModifiedDesc), ...nonPinnedRoots.slice(offset, offset + limit)];
  const wantedIds = new Set<string>();
  for (const rid of pageRootIds) {
    for (const id of collectSubtree(rid)) wantedIds.add(id);
  }
  // 详情走 session_meta（与聊天列表 loadProjectSessions 同源）——标题/最后回复由库供给，
  // 不读文件；库内没有行的 id 自然跳过。
  const sessions = await attachSessionProjectInfo(await loadSessionDetailsFromMeta([...wantedIds]));

  return { sessions, rootTotal: roots.length, sessionTotal: rows.length, pinnedSessionIds };
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListGeneration: number | undefined;
}

/** 写路径的「数据变了」信号：归属/pin/改名/新建/删除/事件都会调它。
 *
 *  列表已无缓存（读取 = 每次一次单表查询），所以目前**没有生产读者**：这里只保留
 *  generation 自增的既有行为（T1–T4b 的写路径与 auto-name / patch-write-failure 的
 *  断言都依赖调用本身）。若要连函数一起删，需要同时改掉全部调用方与那两处断言——
 *  属待清理项，本次不动。 */
export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

/**
 * Find one session's file by name, as a bounded fallback for sessions that are
 * not in session_meta yet (a session an external tool just created).
 *
 * Session files are written as `<timestamp>_<id>.jsonl` under a per-project
 * directory, so the id can be located by reading directory entries alone. The
 * header is then parsed — bounded, first line only — to confirm the match
 * rather than trusting the name. Returns null when nothing matches; callers
 * must not fall back to a full catalogue scan (that read path is gone).
 *
 * 决策 4 的代价（说得明白，免后人误以为是 bug）：这里只平铺 readdir 每个项目目录的
 * **第一层**，并依赖 `_<id>.jsonl` 命名约定。子目录里的会话（`<session>/forks/…`、
 * `<session>/<runId>/run-0/session.jsonl`）与文件名不合约定的行因此解析不到——它们要等
 * 扫描器把 path 写进 session_meta（≤30s）才能被 resolveSessionPath 命中。换来的是读
 * 取路径不发全量扫盘。
 *
 * `sessionId` is only ever compared against names that came back from
 * `readdir`, never joined into a path itself, so a separator or `..` inside it
 * cannot reach the filesystem.
 */
async function findSessionPathByName(sessionId: string): Promise<string | null> {
  // The SDK keeps `getSessionsDir` internal, but it is `<agentDir>/sessions`,
  // the same way the other agent-dir paths are derived in this codebase.
  const sessionsDir = joinPath(getAgentDir(), "sessions");
  if (!sessionId || !existsSync(sessionsDir)) return null;

  const suffix = `_${sessionId}.jsonl`;
  let projectDirs;
  try {
    projectDirs = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of projectDirs) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = joinPath(sessionsDir, entry.name);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const match = names.find((name) => name.endsWith(suffix));
    if (!match) continue;

    const candidate = joinPath(dir, match);
    try {
      if (readSessionHeader(candidate)?.id === sessionId) return candidate;
    } catch {
      // 读不出 header（不可读/截断）→ 不认这个候选；不回落全量扫盘（读取路径已无此退路）。
    }
  }
  return null;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // 库是路径的事实源（扫描器已把每个磁盘会话的 path 写入 session_meta）：
  // 命中即用，不读目录、不扫盘。
  try {
    const row = getDb()
      .prepare("SELECT path FROM session_meta WHERE session_id = ?")
      .get(sessionId) as { path: string | null } | undefined;
    if (row?.path && existsSync(row.path)) {
      cacheSessionPath(sessionId, row.path);
      return row.path;
    }
  } catch {
    // db 不可用 → 走名字兜底
  }

  // 库内无行/路径已失效（外部工具刚建的会话）→ 按名字匹配兜底：每项目目录一次
  // readdir + 一次 header 读，不再退化成全量头尾扫。
  const direct = await findSessionPathByName(sessionId);
  if (direct) {
    cacheSessionPath(sessionId, direct);
    return direct;
  }
  return null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  try {
    const db = getDb();
    // 精确命中（绝大多数调用：header.parentSession 与建行时写入的 path 同源）。
    const exact = db
      .prepare("SELECT session_id, path FROM session_meta WHERE path = ?")
      .get(filePath) as { session_id: string; path: string } | undefined;
    if (exact?.path) {
      cacheSessionPath(exact.session_id, exact.path);
      return exact.session_id;
    }
    // 归一化差异兜底（`/a/./b`、Windows 大小写）：按文件名后缀粗筛，再用
    // sessionPathKey 精确比较。`_` 在 LIKE 里是单字符通配符 → 只会多筛不会漏筛。
    const base = basenamePath(filePath);
    if (base) {
      const candidates = db
        .prepare("SELECT session_id, path FROM session_meta WHERE path LIKE ?")
        .all(`%${base}`) as Array<{ session_id: string; path: string | null }>;
      for (const row of candidates) {
        if (row.path && sessionPathKey(row.path) === pathKey) {
          cacheSessionPath(row.session_id, row.path);
          return row.session_id;
        }
      }
    }
  } catch {
    // db 不可用 → 查不到（读取路径不再扫盘兜底）
  }
  return undefined;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    let foundNewline = false;

    while (position < maxHeaderBytes && !foundNewline) {
      const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const data = buffer.subarray(0, bytesRead);
      const newlineIndex = data.indexOf(0x0a);
      chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
      position += bytesRead;
      foundNewline = newlineIndex !== -1;
    }

    if (!foundNewline && position >= maxHeaderBytes) return null;
    const firstLine = Buffer.concat(chunks).toString("utf8").trimEnd();
    if (!firstLine) return null;
    try {
      const header = JSON.parse(firstLine) as SessionHeader;
      return header.type === "session" ? header : null;
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = SessionManager.open(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

/**
 * 取活动分支上最后一条 `pi-todo.state` 快照。解析规则完全交给
 * `todo-store.parseTodoSnapshot`（与扩展共用一套校验：id/content/status 全合法才收），
 * 否则面板与工具会对同一份脏数据给出不同答案。
 *
 * 调用方必须传入**活动分支**（`sliceActiveBranch` / `getBranch`）而不是全量 entries：
 * 全量里混着别的分支（fork / 旧分支）的快照，面板会显示不属于当前会话的 todo。
 */
export function extractTodosFromEntries(entries: SessionEntry[]): Todo[] {
  let todos: Todo[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== TODO_STATE_CUSTOM_TYPE) continue;
    const parsed = parseTodoSnapshot((entry as { data?: unknown }).data);
    if (parsed) todos = parsed.todos;
  }
  return todos;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; tail?: number; excludeLeaf?: boolean } = {},
): SessionContext {
  const { tail, excludeLeaf } = options;
  // Restrict the input to the active leaf's ancestor chain, capped at `tail`.
  // SDK buildSessionContext only consumes this chain, so feeding it the full
  // forest forces O(n) work and, for a linear session, O(n) recursion depth in
  // any caller that rebuilds the path. Slicing here bounds both to O(tail).
  const sliced = tail && tail > 0 ? sliceActiveBranch(entries, leafId ?? null, tail, excludeLeaf) : entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of sliced) byId.set(e.id, e);

  const piEntries = sliced as unknown as PiSessionEntry[];
  const piCtx = piBuildSessionContext(piEntries, leafId, byId as unknown as Map<string, PiSessionEntry>);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    byId as unknown as Map<string, PiSessionEntry>,
  );

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const parentIds: (string | null)[] = [];
  for (const entry of contextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
      parentIds.push(localEntry.parentId);
    }
  }

  // Collect the latest pi-todo.state snapshot from the **whole active branch** —
  // not from compaction-truncated contextEntries: compaction trims the LLM
  // context, not the UI's data source. Reading the truncated list made the
  // top-bar todo panel go empty mid-task while /todos (which walks getEntries)
  // still showed items — two sources disagreeing.
  const todos = extractTodosFromEntries(
    sliceActiveBranch(entries, leafId ?? null, entries.length) as unknown as SessionEntry[],
  );

  return {
    messages,
    entryIds,
    parentIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
    todos,
  };
}

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` entries (most-recent first after the final reverse). Iterative: a
 * linear session's chain length equals its entry count, so a recursive walk
 * would overflow the stack. The result is still a valid prefix of the active
 * branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf && leaf?.parentId) leaf = byId.get(leaf.parentId);
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current && chain.length < tail) {
    chain.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  chain.reverse();
  return chain;
}

/**
 * Whether paging `tail` ancestors from `leafId` (or its parent when
 * `excludeLeaf` is set) would hit a cap — i.e. there is older history beyond
 * the current window. The `tail` is measured on *entries*, and UI messages can
 * filter entries down further, so the client cannot infer this from its own
 * message count; the server is the source of truth.
 */
export function hasOlderHistory(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
): boolean {
  if (tail <= 0) return false;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  let cur: SessionEntry | undefined = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (excludeLeaf && cur?.parentId) cur = byId.get(cur.parentId);
  let count = 0;
  while (cur) {
    count++;
    if (count > tail) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      // Real sessions may store assistant content as a string (not a block array),
      // so guard the block-level transform instead of assuming an array.
      const content = message.content;
      if (!Array.isArray(content)) return message;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}

/**
 * 轻量 turn 索引：活动分支上每个 user/assistant 回合的文本摘要（预览/导航用，
 * 不含完整 content）。O(chain) 单遍扫描，只提取纯文本。
 */
const TURN_INDEX_USER_TEXT_MAX = 120;
const TURN_INDEX_PREVIEW_MAX = 140;

function truncateForTurnIndex(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 提取 user 消息纯文本预览（string 或 text blocks；纯附件消息给占位文案）。 */
function extractUserPreview(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return truncateForTurnIndex(content.trim(), TURN_INDEX_USER_TEXT_MAX);
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
  if (text) return truncateForTurnIndex(text, TURN_INDEX_USER_TEXT_MAX);
  return content.length > 0 ? "[attachment]" : "";
}

/** 提取 assistant 回复纯文本预览（所有 text blocks 拼接；thinking/toolCall 不参与）。 */
function extractAssistantPreview(content: Array<{ type: string; text?: string }>): string {
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n\n")
    .trim();
  return text ? truncateForTurnIndex(text, TURN_INDEX_PREVIEW_MAX) : "";
}

/**
 * 活动分支全量 turn 索引：从 leaf 沿 parentId 回溯到根，单遍收集 user/
 * assistant 回合的文本摘要。O(chain)，不 cap —— 导航条需要「尽可能多」。
 */
export function extractTurnIndex(entries: SessionEntry[], leafId: string | null): TurnIndexItem[] {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let cur: SessionEntry | undefined = leaf;
  while (cur) {
    chain.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  chain.reverse();

  const turns: TurnIndexItem[] = [];
  let current: TurnIndexItem | null = null;
  for (const entry of chain) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      current = { entryId: entry.id, userText: extractUserPreview(message.content), assistantPreview: "" };
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      const preview = extractAssistantPreview(message.content);
      if (preview) current.assistantPreview = preview;
    }
  }
  return turns;
}

/**
 * 按 id 批量点查会话摘要（看板卡片轮询用，替代全量列表自筛）。
 *
 * 库优先（用户决策 4）：title / last_reply / modified 全部取 session_meta，
 * 一次点查不读任何文件（旧实现逐卡 scanOneSessionFile 读头尾）。只有
 * **库里完全没有行**的 id（外部工具刚建、尚未入索引的会话）才回退到
 * resolveSessionPath + 单文件详情读。查不到（id 不存在）跳过。
 */
export async function loadSessionSummariesByIds(ids: string[]): Promise<SessionInfo[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];

  const rowById = new Map<string, SessionMetaRow>();
  try {
    const found = getDb()
      .prepare(`SELECT ${META_SELECT_COLUMNS} FROM session_meta WHERE session_id IN (${unique.map(() => "?").join(",")})`)
      .all(...unique) as Array<Record<string, unknown>>;
    for (const r of found) rowById.set(r.session_id as string, r);
  } catch {
    // db 不可用 → 全部走文件兜底
  }

  const byId = new Map<string, SessionInfo>();
  const missing: string[] = [];
  for (const id of unique) {
    const row = rowById.get(id);
    if (!row) {
      missing.push(id);
      continue;
    }
    if (row.path) cacheSessionPath(id, row.path as string);
    byId.set(id, mapSessionMetaRow(row));
  }

  // 兜底：库内无行的 id（外部工具刚建的会话）—— 一次路径解析 + 文件头尾读。
  for (const id of missing) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) continue;
    const scanned = scanOneSessionFile(filePath);
    if (!scanned) continue;
    cacheSessionPath(id, scanned.path);
    // parentSessionId 与主路径同字段（会话 id，不是路径）：磁盘上只有父路径，
    // 经库反查一次；父也还没行就留 undefined（与主路径的 NULL 行为一致）。
    const parentSessionId = scanned.parentSessionPath
      ? await resolveSessionIdByPath(scanned.parentSessionPath)
      : undefined;
    byId.set(id, {
      path: scanned.path,
      id: scanned.id,
      cwd: scanned.cwd,
      name: scanned.name,
      created: scanned.created.toISOString(),
      modified: scanned.modified.toISOString(),
      messageCount: 0,
      firstMessage: scanned.firstMessage || "(no messages)",
      lastReply: scanned.lastReply || "",
      parentSessionId,
      transient: false,
    });
  }

  // 返回顺序与入参一致（命中集）。
  return attachSessionProjectInfo(unique.map((id) => byId.get(id)).filter((s): s is SessionInfo => Boolean(s)));
}
