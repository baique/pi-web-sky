/**
 * 看板内搜索定位（Ctrl+F）的纯函数。
 *
 * 只遍历当前画布上的 shape（session-card 标题 + sticky-note 便笺文字），
 * 不做会话正文索引（正文搜索属另一需求，见 .agent/spec/2026-08-30-board-search.md 不做项）。
 * 画布节点量级小（几十个），includes 子串匹配足够，无需索引。
 */

import type { Editor, TLShapeId } from "tldraw";

export type SearchableKind = "session-card" | "sticky-note";

export interface SearchableItem {
  shapeId: TLShapeId;
  kind: SearchableKind;
  /** 完整原文（匹配用全文） */
  text: string;
}

export interface SearchMatch {
  item: SearchableItem;
  /** 命中片段（下拉展示用，前后截断） */
  snippet: string;
}

/** 收集当前画布上可搜索的节点。空文本节点跳过（无搜索价值）。 */
export function collectSearchable(editor: Editor): SearchableItem[] {
  const out: SearchableItem[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type === "session-card") {
      const title = String((shape.props as { title?: unknown }).title ?? "").trim();
      if (title) out.push({ shapeId: shape.id, kind: "session-card", text: title });
    } else if (shape.type === "sticky-note") {
      const text = String((shape.props as { text?: unknown }).text ?? "").trim();
      if (text) out.push({ shapeId: shape.id, kind: "sticky-note", text });
    }
  }
  return out;
}

/** 按 query 过滤（大小写不敏感子串匹配）。空 query 返回空结果。 */
export function filterMatches(items: SearchableItem[], query: string): SearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items
    .filter((it) => it.text.toLowerCase().includes(q))
    .map((it) => ({ item: it, snippet: makeSnippet(it.text, query) }));
}

/** 命中片段：以首个命中位置为中心截取 ~44 字符，两端加省略号。 */
export function makeSnippet(text: string, query: string, maxLen = 44): string {
  const q = query.trim().toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  const start = Math.max(0, idx - Math.floor((maxLen - q.length) / 2));
  const end = Math.min(text.length, start + maxLen);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${text.slice(start, end)}${tail}`;
}
