import { readFileSync } from "fs";
import { getDb } from "./sqlite-db";
import type { SessionInfo } from "./types";

// ============================================================================
// Session full-text search over a SQLite FTS5 (trigram) index.
//
// Key properties (verified locally):
//  - trigram tokenizer matches CJK substrings, unlike unicode61 which treats a
//    whole CJK run as one token.
//  - queries shorter than 3 chars never match via MATCH -> LIKE fallback on
//    the same FTS table, which is index-accelerated for trigram.
//  - FTS5 MATCH syntax needs special chars escaped -> build a quoted phrase.
//
// Text is extracted from the .jsonl directly (lightweight parser, no SDK) so
// this module stays loadable in plain-node unit tests.
// ============================================================================

const BODY_CAP = 256 * 1024;
const TOOL_INPUT_CAP = 500;
const BASH_OUTPUT_CAP = 4 * 1024;
const TITLE_CAP = 200;

interface SearchRow {
  session_id: string;
  titleMatch: number;
  snip: string | null;
}

interface RawEntry {
  type: string;
  message?: {
    role: string;
    content?: unknown;
    command?: string;
    output?: string;
  };
  summary?: string;
}

export interface SearchResult {
  session: SessionInfo;
  titleMatch: boolean;
  snippet: string;
}

function appendText(parts: string[], text: string, budgetLeft: () => number) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return;
  const room = budgetLeft();
  parts.push(t.length <= room ? t : t.slice(0, room));
}

function contentText(content: unknown, omitImages: boolean): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string; thinking?: string; toolCallId?: string; toolName?: string; input?: unknown };
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "thinking" && typeof b.thinking === "string") parts.push(b.thinking);
    else if (b.type === "toolCall" && typeof b.toolName === "string") {
      let input = "";
      try {
        input = JSON.stringify(b.input ?? {});
      } catch {
        input = "";
      }
      parts.push(`[tool:${b.toolName}] ${input.slice(0, TOOL_INPUT_CAP)}`);
    } else if (b.type === "image") {
      if (!omitImages) parts.push("[image]");
    }
  }
  return parts.join("\n");
}

/**
 * Extract searchable title + body from a session's jsonl file. Kept separate
 * from indexing so tests can exercise extraction without touching the DB.
 */
export function extractSessionText(session: SessionInfo): { title: string; body: string } {
  const title = (session.name || (session.firstMessage || "").slice(0, TITLE_CAP)).slice(0, 400);
  const parts: string[] = [];
  let size = 0;
  const budgetLeft = () => BODY_CAP - size;
  const push = (text: string) => {
    if (size >= BODY_CAP) return;
    const before = parts.length;
    appendText(parts, text, budgetLeft);
    size += parts.slice(before).join("\n").length;
  };

  let entries: RawEntry[] = [];
  try {
    entries = parseSessionFile(session.path);
  } catch {
    // Unreadable session (deleted mid-scan): index with empty body so it
    // still appears in title-only search.
  }
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const { role, content } = entry.message;
      if (role === "user") push(contentText(content, false));
      else if (role === "assistant") push(contentText(content, false));
      else if (role === "toolResult") {
        const text = contentText(content, true);
        // Keep tool errors searchable, drop everything else once big.
        push(text.length > 600 ? text.slice(0, 600) : text);
      } else if (role === "bashExecution") {
        if (typeof entry.message?.command === "string") push(`> ${entry.message.command}`);
        if (typeof entry.message?.output === "string") push(entry.message.output.slice(0, BASH_OUTPUT_CAP));
      }
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      push(entry.summary);
    } else if (entry.type === "custom_message") {
      const content = (entry as unknown as { content?: unknown }).content;
      if (typeof content === "string") push(content);
    }
  }
  return { title, body: parts.join("\n") };
}

/** Lightweight per-line JSONL parse — only fields the search needs. */
function parseSessionFile(path: string): RawEntry[] {
  const text = readFileSync(path, "utf8");
  const entries: RawEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as RawEntry;
      if (entry && typeof entry.type === "string") entries.push(entry);
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

/** Escape a user term into an FTS5 quoted-phrase token. */
export function fuzzyQueryForTerm(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * Bring the index in sync with the (optionally injected) session list:
 * re-index changed/new sessions by modified-mtime, drop vanished ones.
 * Returns whether any write happened this round (frontend "indexing" hint).
 */
export async function ensureSearchIndex(
  sessionsOverride?: SessionInfo[],
): Promise<{ indexing: boolean }> {
  let sessions = sessionsOverride;
  if (!sessions) {
    const { listAllSessions } = await import("./session-reader");
    sessions = await listAllSessions();
  }
  const db = getDb();

  const stateRows = db.prepare("SELECT session_id, mtime FROM search_state").all() as {
    session_id: string;
    mtime: string;
  }[];
  const state = new Map(stateRows.map((r) => [r.session_id, r.mtime]));
  const known = new Set<string>();
  let changed = false;

  const upsertState = db.prepare(
    "INSERT INTO search_state (session_id, mtime, title) VALUES (?, ?, ?) " +
      "ON CONFLICT(session_id) DO UPDATE SET mtime = excluded.mtime, title = excluded.title",
  );
  const insertFts = db.prepare(
    "INSERT INTO session_search (session_id, title, body) VALUES (?, ?, ?)",
  );
  const deleteFts = db.prepare("DELETE FROM session_search WHERE session_id = ?");

  for (const session of sessions) {
    known.add(session.id);
    if (state.get(session.id) === session.modified) continue;
    const { title, body } = extractSessionText(session);
    db.exec("BEGIN");
    try {
      deleteFts.run(session.id);
      if (body || title) insertFts.run(session.id, title, body);
      upsertState.run(session.id, session.modified, title);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    changed = true;
  }
  db.exec("BEGIN");
  try {
    for (const sessionId of state.keys()) {
      if (!known.has(sessionId)) {
        deleteFts.run(sessionId);
        db.prepare("DELETE FROM search_state WHERE session_id = ?").run(sessionId);
        changed = true;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { indexing: changed };
}

/**
 * Full-text search over all sessions. Queries of any length; ≥3 chars go
 * through FTS5 trigram MATCH (CJK substring safe), shorter ones through LIKE.
 * Results: title hits first, then most recently modified. `sessionsOverride`
 * injects the session list (tests) instead of loading the real catalogue.
 */
export async function searchSessions(
  q: string,
  limit = 30,
  sessionsOverride?: SessionInfo[],
  sessionIds?: string[],
): Promise<{ indexing: boolean; results: SearchResult[] }> {
  const query = q.trim();
  if (!query) return { indexing: false, results: [] };
  const sessions = sessionsOverride ?? (await loadAllSessions());
  const indexed = await ensureSearchIndex(sessions);

  const cap = Math.min(Math.max(limit, 1), 50);
  const db = getDb();
  const sessionsById = new Map(sessions.map((s) => [s.id, s]));
  // 限定搜索范围到指定会话（看板正文搜索传当前看板 sessionId 集合）。
  const sidClause = sessionIds?.length ? ` AND session_id IN (${sessionIds.map(() => "?").join(",")})` : "";
  const sidParams = sessionIds?.length ? sessionIds : [];

  let rows: SearchRow[];
  const titleIds = new Set<string>();
  // 多关键字：空格分隔，全部命中（AND）。
  // FTS5 trigram 对 1-2 字符词不可靠：任一词 <3 字符 → 整条退化为 LIKE 逐词 AND。
  const terms = query.split(/\s+/).filter(Boolean);
  const allLong = terms.every((term) => term.length >= 3);
  if (allLong) {
    // 每个词一个 FTS 短语，AND 组合（各词均为子串命中）
    const phrase = terms.map(fuzzyQueryForTerm).join(" AND ");
    rows = db
      .prepare(
        "SELECT session_id, ifnull(snippet(session_search, 2, '[', ']', '…', 12), '') AS snip " +
          `FROM session_search WHERE session_search MATCH ?${sidClause} LIMIT ?`,
      )
      .all(phrase, ...sidParams, cap) as unknown as SearchRow[];
    for (const r of db.prepare(`SELECT session_id FROM session_search WHERE title MATCH ?${sidClause}`).all(phrase, ...sidParams) as { session_id: string }[]) {
      titleIds.add(r.session_id);
    }
  } else {
    // LIKE 逐词 AND：每个词 (title LIKE ? OR body LIKE ?)，组合成 AND
    const where = terms.map(() => "(title LIKE ? OR body LIKE ?)").join(" AND ");
    const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
    rows = db
      .prepare(`SELECT session_id, '' AS snip FROM session_search WHERE ${where}${sidClause} LIMIT ?`)
      .all(...params, ...sidParams, cap) as unknown as SearchRow[];
    const titleWhere = terms.map(() => "title LIKE ?").join(" AND ");
    const titleParams = terms.map((term) => `%${term}%`);
    for (const r of db.prepare(`SELECT session_id FROM session_search WHERE ${titleWhere}${sidClause}`).all(...titleParams, ...sidParams) as { session_id: string }[]) {
      titleIds.add(r.session_id);
    }
  }

  // Title hits first, then most recently modified.
  const results: SearchResult[] = [];
  for (const row of rows) {
    const session = sessionsById.get(row.session_id);
    if (!session) continue;
    results.push({
      session,
      titleMatch: titleIds.has(row.session_id),
      snippet: row.snip ?? "",
    });
  }
  results.sort(
    (a, b) =>
      Number(b.titleMatch) - Number(a.titleMatch)
      || b.session.modified.localeCompare(a.session.modified),
  );
  return { indexing: indexed.indexing, results };
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const { listAllSessions } = await import("./session-reader");
  return listAllSessions();
}