import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { closeSync, existsSync, openSync, readSync } from "fs";
import { readdir } from "fs/promises";
import { join as joinPath, normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext, TodoItem } from "./types";
import type { SessionEntry as PiSessionEntry } from "@earendil-works/pi-coding-agent";
import { getDb } from "./sqlite-db";
import { normalizeToolCalls } from "./normalize";
import { projectIdentityKey } from "./project-identity";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";
import { scanSessionFiles, scanSessionFileMeta, scanOneSessionFile, sessionScanner } from "./session-scanner";

export { getAgentDir };

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

async function loadAllSessions(): Promise<SessionInfo[]> {
  // 轻量扫描：只读每个会话文件的头部（header + 首条用户消息）与尾部（最新
  // session_info 自定义名），最后活动时间用文件 mtime——列表只展示标题+时间，
  // 不读取消息正文（SDK 的 listAll 会全量读每个 jsonl 并拼接全部文本，在大会话
  // 文件上会把列表刷新拖到秒级甚至十几秒）。
  const scanned = await sessionScanner.scan();
  const pathToId = new Map<string, string>();
  for (const s of scanned) pathToId.set(sessionPathKey(s.path), s.id);

  const sessions = scanned.map((s) => {
    cacheSessionPath(s.id, s.path);
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      name: s.name,
      created: s.created.toISOString(),
      modified: s.modified.toISOString(),
      // 列表不消费消息数（精确值需要全量读，已移除）；保留字段以兼容类型。
      messageCount: 0,
      firstMessage: s.firstMessage || "(no messages)",
      lastReply: s.lastReply || "",
      parentSessionId: s.parentSessionPath ? pathToId.get(sessionPathKey(s.parentSessionPath)) : undefined,
      transient: false,
    };
  });
  return attachSessionProjectInfo(sessions);
}

/** 聊天区会话两阶段分页（侧栏左侧聊天区）。
 *
 *  阶段一：scanSessionFileMeta——readdir + stat 拿全量 id+mtime（不读内容，
 *  按 mtime 降序）；再用 session_meta.task_id 过滤掉任务会话，剩聊天区全集。
 *  阶段二：只对「置顶全量 + 当前页」子集 scanOneSessionFile 读详情——列表
 *  加载不再随会话总量线性变慢。
 *
 *  返回：pinned（置顶全量，不分页）+ sessions（当前页非置顶）+ total（非置顶总数）。
 */
export async function loadChatSessionsPage(options: {
  offset?: number;
  limit?: number;
} = {}): Promise<{ pinned: SessionInfo[]; sessions: SessionInfo[]; total: number }> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.max(1, Math.floor(options.limit ?? 20));

  // 阶段一：全量 id+mtime（轻量，不读内容）。
  const metas = await scanSessionFileMeta();

  // 过滤：归属任务的会话交 /api/tasks 管，不进聊天区。
  let taskSessionIds = new Set<string>();
  try {
    const { listAllTaskSessionIds } = await import("./task-store");
    taskSessionIds = listAllTaskSessionIds();
  } catch {
    // db not available — fall back to all chat
  }
  const chatMetas = metas.filter((m) => !taskSessionIds.has(m.id));

  // 阶段一排序：scanSessionFileMeta 已按 mtime 降序。置顶在列表里始终保持
  // 独立全量（客户端置顶区单独渲染），非置顶按序取页。
  const pinnedIds = listPinnedSessionIds();
  const pinnedMetas = chatMetas.filter((m) => pinnedIds.has(m.id));
  const nonPinnedMetas = chatMetas.filter((m) => !pinnedIds.has(m.id));
  const pageMetas = nonPinnedMetas.slice(offset, offset + limit);

  // 阶段二：只读置顶 + 当前页的详情。
  const scanned = await readSessionDetails([...pinnedMetas, ...pageMetas]);
  const pinnedCount = pinnedMetas.length;
  const pinnedSessions = scanned.slice(0, pinnedCount);
  const pageSessions = scanned.slice(pinnedCount);
  const pinned = await attachSessionProjectInfo(pinnedSessions);
  const sessions = await attachSessionProjectInfo(pageSessions);
  return { pinned, sessions, total: nonPinnedMetas.length };
}

/** 阶段二：批量读详情（只读需要的子集）。返回顺序与入参一致。 */
async function readSessionDetails(metas: Array<{ path: string; id: string; modified: Date }>): Promise<SessionInfo[]> {
  const pathToId = new Map<string, string>();
  for (const m of metas) pathToId.set(sessionPathKey(m.path), m.id);
  const sessions: SessionInfo[] = [];
  for (const meta of metas) {
    const scanned = scanOneSessionFile(meta.path);
    if (!scanned) continue;
    cacheSessionPath(scanned.id, scanned.path);
    sessions.push({
      path: scanned.path,
      id: scanned.id,
      cwd: scanned.cwd,
      name: scanned.name,
      created: scanned.created.toISOString(),
      modified: scanned.modified.toISOString(),
      messageCount: 0,
      firstMessage: scanned.firstMessage || "(no messages)",
      lastReply: scanned.lastReply || "",
      parentSessionId: scanned.parentSessionPath ? pathToId.get(sessionPathKey(scanned.parentSessionPath)) : undefined,
      transient: false,
    });
  }
  return sessions;
}

/** 全量置顶会话 id 集合（一次查询，避免逐会话查库）。 */
function listPinnedSessionIds(): Set<string> {
  try {
    const rows = getDb()
      .prepare("SELECT session_id FROM session_meta WHERE pinned = 1")
      .all() as Array<{ session_id: string }>;
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set();
  }
}

/** 任务会话详情按需分页（侧栏任务区）。
 *
 *  服务端分流：任务下的会话详情由 /api/tasks 直接下发，前端不再用
 *  /api/sessions 全量列表 join task.sessionIds 反查（旧设计已被服务端
 *  分流取代——前端零归属判断）。
 *
 *  每任务返回：置顶根会话全量 + 非置顶根从 offset 起的 limit 个（含各自
 *  fork 子树），外加 rootTotal（根会话总数，加载更多游标）与
 *  sessionTotal（含子树全部节点数，删除确认文案用）。
 */
export async function loadTaskSessionsPage(
  taskId: string,
  offset = 0,
  limit = 5,
): Promise<{ sessions: SessionInfo[]; rootTotal: number; sessionTotal: number; pinnedSessionIds: string[] }> {
  return loadTaskSessionsPageWithIndex(taskId, await buildTaskSessionIndex(), offset, limit);
}

/** 任务会话索引：全量 id+path+mtime（readdir/stat，不读内容）+ 父链（读 header 首行）。
 *  一次构建供多个任务复用——/api/tasks 列表对每个任务都调 loadTaskSessionsPage，
 *  若各自全量扫文件会随任务数线性变慢（N 任务 = N 次全量 readdir+header）。 */
export async function buildTaskSessionIndex(): Promise<{
  metaById: Map<string, { path: string; id: string; modified: Date }>;
  childrenOf: Map<string, string[]>;
}> {
  // 阶段一：全量 id+path+mtime（readdir+stat，不读内容）。
  const metas = await scanSessionFileMeta();
  const metaById = new Map(metas.map((m) => [m.id, m]));
  const metaByPath = new Map(metas.map((m) => [sessionPathKey(m.path), m]));

  // 父链索引（只读每个文件 header 首行——比 scanOneSessionFile 便宜，
  // 不需要尾部反向分块）：childId -> parentId（childrenOf: parentId -> [childId]）。
  const childrenOf = new Map<string, string[]>();
  for (const m of metas) {
    let parentPath: string | undefined;
    try {
      parentPath = readSessionHeader(m.path)?.parentSession ?? undefined;
    } catch {
      // 首行不可读 → 视为根会话
    }
    if (!parentPath) continue;
    const parentMeta = metaByPath.get(sessionPathKey(parentPath));
    if (!parentMeta) continue;
    const arr = childrenOf.get(parentMeta.id) ?? [];
    arr.push(m.id);
    childrenOf.set(parentMeta.id, arr);
  }
  return { metaById, childrenOf };
}

/** 加载单个任务会话详情分页（复用外部已构建的任务索引，避免重复全量扫）。 */
export async function loadTaskSessionsPageWithIndex(
  taskId: string,
  index: { metaById: Map<string, { path: string; id: string; modified: Date }>; childrenOf: Map<string, string[]> },
  offset = 0,
  limit = 5,
): Promise<{ sessions: SessionInfo[]; rootTotal: number; sessionTotal: number; pinnedSessionIds: string[] }> {
  const { metaById, childrenOf } = index;
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

  const { listTaskSessionIds, listPinnedTaskSessionIds } = await import("./task-store");
  const rootIds = listTaskSessionIds(taskId);
  const pinnedSessionIds = listPinnedTaskSessionIds(taskId);
  const pinnedSet = new Set(pinnedSessionIds);
  const nonPinnedRoots = rootIds.filter((id) => !pinnedSet.has(id));

  // 当前页根 = 置顶全量 + 非置顶 slice(offset, offset+limit)；子树跟随根。
  const pageRootIds = [...pinnedSessionIds, ...nonPinnedRoots.slice(offset, offset + limit)];
  const wantedIds = new Set<string>();
  for (const rid of pageRootIds) {
    for (const id of collectSubtree(rid)) wantedIds.add(id);
  }
  const orderedMetas = [...wantedIds].map((id) => metaById.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const sessions = await attachSessionProjectInfo(await readSessionDetails(orderedMetas));

  // sessionTotal：任务下全部根 + 子树节点数（删除确认文案）。
  const allIds = new Set<string>();
  for (const rid of rootIds) for (const id of collectSubtree(rid)) allIds.add(id);
  return { sessions, rootTotal: rootIds.length, sessionTotal: allIds.size, pinnedSessionIds };
}

export async function listAllSessions(options: { force?: boolean } = {}): Promise<SessionInfo[]> {
  if (options.force) invalidateSessionListCache();
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // If a mutation invalidated this scan, make this caller join (or start) a
    // scan for the current generation. Returning the stale result here made a
    // refresh race indistinguishable from a successful refresh.
    if ((globalThis.__piSessionListGeneration ?? 0) !== generation) {
      return listAllSessions();
    }
    globalThis.__piSessionListCache = { data, ts: Date.now() };
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 300_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
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
 * Find one session's file without parsing the catalogue.
 *
 * Session files are written as `<timestamp>_<id>.jsonl` under a per-project
 * directory, so the id can be located by reading directory entries alone. The
 * header is then parsed — bounded, first line only — to confirm the match
 * rather than trusting the name. Returns null when nothing matches, leaving the
 * caller on the full scan.
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
      // Unreadable or truncated: let the full scan decide.
    }
  }
  return null;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Opening one session should not wait for the whole catalogue to be parsed.
  // The name carries the id, so this costs a directory listing per project plus
  // one header read, and only a miss falls through to the full scan.
  const direct = await findSessionPathByName(sessionId);
  if (direct) {
    cacheSessionPath(sessionId, direct);
    return direct;
  }

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
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

export function extractTodosFromEntries(entries: SessionEntry[]): TodoItem[] {
  // pi todo state is stored as {"type":"custom","customType":"pi-todo.state","data":{"todos":[...]}}
  // entries appended to the session file — pick the latest snapshot. Todo
  // entries are otherwise dropped from chat history (entryToUiMessage returns null).
  let todos: TodoItem[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "pi-todo.state") continue;
    const data = (entry as { data?: unknown }).data;
    if (!isRecord(data) || !Array.isArray(data.todos)) continue;
    todos = data.todos.filter((t: unknown): t is TodoItem => (
      isRecord(t) && typeof t.content === "string"
    ));
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

  // Collect the latest pi-todo.state snapshot from the active branch.
  const todos = extractTodosFromEntries(contextEntries as unknown as SessionEntry[]);

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
