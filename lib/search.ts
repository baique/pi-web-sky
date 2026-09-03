import { getDb } from "./sqlite-db";
import { searchSessions, type SearchResult as SessionSearchResult } from "./session-search";

/**
 * 任务卡搜索 + 会话搜索的合并入口。
 * 会话搜索走 session_search FTS5，任务卡走 task_cards LIKE（数据量小）。
 */

export interface TaskCardSearchHit {
  id: string;
  boardId: string;
  projectKey: string;
  number: number;
  name: string;
  description: string;
  readyStatus: string;
  execStatus: string;
}

export type SearchHit =
  | { kind: "session"; result: SessionSearchResult }
  | { kind: "task-card"; card: TaskCardSearchHit; titleMatch: boolean; snippet: string };

/**
 * 搜索任务卡和会话，合并返回结果。任务卡在前，会话在后。
 */
export async function searchTaskCardsAndSessions(
  query: string,
  limit = 20,
): Promise<{ indexing: boolean; results: SearchHit[] }> {
  const q = query.trim();
  if (!q) return { indexing: false, results: [] };

  const db = getDb();
  const cardLimit = Math.ceil(limit / 2);
  const sessionLimit = Math.ceil(limit / 2);

  // 搜索任务卡
  const cardRows = db
    .prepare(
      `SELECT id, board_id, project_key, number, name, description, ready_status, exec_status
       FROM task_cards
       WHERE name LIKE ? OR description LIKE ?
       LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, cardLimit) as Array<{
      id: string;
      board_id: string;
      project_key: string;
      number: number;
      name: string;
      description: string;
      ready_status: string;
      exec_status: string;
    }>;

  const terms = q.split(/\s+/).filter(Boolean);

  const results: SearchHit[] = [];

  for (const row of cardRows) {
    const titleHit = terms.every((t) => row.name.toLowerCase().includes(t.toLowerCase()));
    const snippet = row.description ? findSnippet(row.description, terms) : "";
    results.push({
      kind: "task-card",
      card: {
        id: row.id,
        boardId: row.board_id,
        projectKey: row.project_key,
        number: row.number,
        name: row.name,
        description: row.description,
        readyStatus: row.ready_status,
        execStatus: row.exec_status,
      },
      titleMatch: titleHit,
      snippet,
    });
  }

  // 搜索会话（复用 session_search FTS5）
  const { indexing, results: sessionResults } = await searchSessions(q, sessionLimit);
  for (const r of sessionResults) {
    results.push({ kind: "session", result: r });
  }

  return { indexing, results };
}

/** 从 description 中提取匹配片段 */
function findSnippet(text: string, terms: string[], maxLen = 120): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t.toLowerCase());
    if (p !== -1) {
      pos = p;
      break;
    }
  }
  if (pos === -1) return text.slice(0, maxLen);
  const start = Math.max(0, pos - 30);
  const end = Math.min(text.length, pos + maxLen - 30);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ") + suffix;
}
