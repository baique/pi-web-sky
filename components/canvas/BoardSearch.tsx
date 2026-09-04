"use client";

/**
 * 看板内搜索框（常驻，画布顶部居中，玻璃胶囊）—— RF 版。
 * 单个输入框同时搜两类：
 *  - 节点命中（本地）：遍历 RF nodes（会话卡标题 + 便笺正文），includes 匹配；
 *  - 正文命中（远程）：调 /api/search 搜会话聊天正文（FTS5），后端按当前看板 sessionId 集合过滤，
 *    只展示看板内会话的正文命中；
 * 下拉分组合并展示；点击任意命中 → setViewport 居中 + 高亮描边。
 * 需要 ReactFlowProvider 包裹（SessionCanvas 提供）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { useI18n } from "@/hooks/useI18n";
import { useBoardSearch } from "./BoardSearchContext";

export interface SearchableItem {
  nodeId: string;
  kind: "session-card" | "sticky-note";
  text: string;
}

interface BodyHit {
  sessionId: string;
  title: string;
  snippet: string;
  titleMatch: boolean;
}

/** 正文搜索防抖（ms） */
const BODY_DEBOUNCE_MS = 350;

interface SearchApiHit {
  kind: string;
  result?: {
    session: { id: string; name?: string; firstMessage?: string };
    titleMatch?: boolean;
    snippet?: string;
  };
}

export function BoardSearch({
  editor: _unused,
  inputRef,
  nodes,
  onViewportSave,
}: {
  /** 兼容旧签名（RF 版不再用 tldraw editor） */
  editor?: unknown;
  /** Ctrl+F 聚焦目标 */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 当前画布节点（搜索遍历对象） */
  nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  /** 定位后把目标视口写回 yjs view map（位置记忆同源，防覆盖竞争） */
  onViewportSave?: (vp: { x: number; y: number; zoom: number }) => void;
}) {
  const { t } = useI18n();
  const { setHighlight } = useBoardSearch();
  const { setCenter, getViewport, getNodes } = useReactFlow();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [bodyHits, setBodyHits] = useState<BodyHit[] | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const focusEl = inputRef ?? localRef;
  const abortRef = useRef<AbortController | null>(null);

  // 当前看板内 sessionId 集合（正文搜索范围）——从画布 session-card 节点收集。
  const boardSessionIds = useMemo(() => {
    const src = nodes ?? (getNodes() as Array<{ id: string; type: string; data: Record<string, unknown> }>);
    const sids: string[] = [];
    for (const n of src) {
      if (n.type !== "session-card") continue;
      const sid = String((n.data as { sessionId?: unknown }).sessionId ?? "");
      if (sid) sids.push(sid);
    }
    return sids;
  }, [nodes, getNodes]);
  const boardSessionIdsKey = boardSessionIds.join(",");

  // 正文命中：防抖调 /api/search（后端按当前看板 sessionId 过滤），AbortController 取消过期请求。
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setBodyHits(null);
      return;
    }
    // 当前看板无会话卡：正文搜索无可搜范围，直接空结果（避免落到全局搜索）
    if (!boardSessionIdsKey) {
      setBodyHits([]);
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      fetch(
        `/api/search?q=${encodeURIComponent(q)}&limit=30&sessionIds=${encodeURIComponent(boardSessionIdsKey)}`,
        { signal: controller.signal },
      )
        .then((r) => (r.ok ? (r.json() as Promise<{ indexing: boolean; results: SearchApiHit[] }>) : null))
        .then((d) => {
          if (!d) return;
          const hits: BodyHit[] = (d.results ?? [])
            .filter((r) => r.kind === "session" && r.result)
            .map((r) => {
              const s = r.result!.session;
              return {
                sessionId: s.id,
                title: s.name || (s.firstMessage || "").slice(0, 50) || s.id.slice(0, 12),
                snippet: r.result!.snippet ?? "",
                titleMatch: Boolean(r.result!.titleMatch),
              };
            });
          setBodyHits(hits);
        })
        .catch(() => setBodyHits([]));
    }, BODY_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [query, boardSessionIdsKey]);

  // 节点命中：可搜索节点（会话卡标题 + 便笺正文）
  const items = useMemo<SearchableItem[]>(() => {
    const src = nodes ?? (getNodes() as Array<{ id: string; type: string; data: Record<string, unknown> }>);
    const out: SearchableItem[] = [];
    for (const n of src) {
      if (n.type === "session-card") {
        const title = String((n.data as { title?: unknown }).title ?? "").trim();
        if (title) out.push({ nodeId: n.id, kind: "session-card", text: title });
      } else if (n.type === "sticky-note" || n.type === "text") {
        const text = String((n.data as { text?: unknown }).text ?? "").trim();
        if (text) out.push({ nodeId: n.id, kind: "sticky-note", text });
      }
    }
    return out;
  }, [nodes, getNodes]);

  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [] as Array<{ item: SearchableItem; snippet: string }>;
    return items
      .filter((it) => {
        const text = it.text.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .map((it) => ({ item: it, snippet: makeSnippet(it.text, terms[0]) }));
  }, [items, query]);

  /** 定位：把指定 nodeId 平移到视口中心（保持缩放）+ 高亮描边 */
  const locateNodeId = useCallback((nodeId: string) => {
    const all = getNodes() as Array<{ id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number } }>;
    const node = all.find((n) => n.id === nodeId);
    if (!node) return;
    const w = node.measured?.width ?? 340;
    const h = node.measured?.height ?? 160;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    // 用 RF 的 setCenter（语义正确：把指定点移到视口中心，保持缩放），
    // 不用手算坐标的 setViewport——避免动画 transition 卡住 + 坐标算错。
    const p = setCenter(cx, cy, { zoom: getViewport().zoom });
    // 定位后把目标视口写回 yjs view map：与位置记忆同源，
    // 避免 CanvasStage 的位置记忆 effect 用旧值覆盖当前视口（定位被拽回）。
    void Promise.resolve(p).then(() => {
      onViewportSave?.(getViewport());
    });
    setHighlight(nodeId);
  }, [getNodes, getViewport, setCenter, setHighlight, onViewportSave]);

  /** 命中总数：节点命中 + 正文命中 */
  const totalCount = matches.length + (bodyHits?.length ?? 0);

  /** 定位第 index 个命中（先节点命中，再正文命中） */
  const locate = useCallback((index: number) => {
    if (index < matches.length) {
      const m = matches[index];
      if (m) locateNodeId(m.item.nodeId);
    } else {
      const hit = bodyHits?.[index - matches.length];
      if (!hit) return;
      const nodeId = (getNodes() as Array<{ id: string; type: string; data: Record<string, unknown> }>).find(
        (n) => n.type === "session-card" && String((n.data as { sessionId?: unknown }).sessionId ?? "") === hit.sessionId,
      )?.id;
      if (!nodeId) return;
      locateNodeId(nodeId);
    }
    setActiveIndex(index);
  }, [matches, bodyHits, locateNodeId, getNodes]);

  const locateNext = useCallback(() => {
    if (totalCount === 0) return;
    locate((activeIndex + 1) % totalCount);
  }, [totalCount, activeIndex, locate]);

  const locatePrev = useCallback(() => {
    if (totalCount === 0) return;
    locate((activeIndex - 1 + totalCount) % totalCount);
  }, [totalCount, activeIndex, locate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); locateNext(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); locatePrev(); }
    else if (e.key === "Escape") {
      e.preventDefault();
      if (open) setOpen(false);
      else { setQuery(""); setActiveIndex(-1); focusEl.current?.blur(); }
    }
  }, [open, locateNext, locatePrev, focusEl]);

  const showDropdown = open && query.trim().length > 0;
  // 正文搜索中（bodyHits === null 且已有关键词）= 首次结果未回；空数组 = 已返回无命中
  const bodyPending = bodyHits === null;
  const nodeVisible = matches.length > 0;
  const bodyVisible = (bodyHits?.length ?? 0) > 0;

  return (
    <div style={{ position: "relative", width: 320 }} data-testid="board-search">
      <div style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 8px 0 10px", borderRadius: 999, background: "var(--board-card-glass)", backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)" }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={focusEl}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(-1); setOpen(true); }}
          onKeyDown={onKeyDown}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onBlur={() => setOpen(false)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={t("boards.searchPlaceholder")}
          spellCheck={false}
          aria-label={t("boards.searchPlaceholder")}
          style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "var(--text)", fontSize: 12.5, fontFamily: "inherit" }}
        />
        {query && (
          <button type="button" title={t("common.close")} onPointerDown={(e) => e.stopPropagation()} onClick={() => { setQuery(""); setActiveIndex(-1); focusEl.current?.focus(); }} style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, padding: 0, border: "none", borderRadius: "50%", background: "color-mix(in srgb, var(--border) 35%, transparent)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, lineHeight: 1 }}>
            ×
          </button>
        )}
      </div>

      {showDropdown && (
        <div data-testid="board-search-dropdown" onPointerDown={(e) => e.stopPropagation()} style={{ position: "absolute", top: 40, left: 0, right: 0, zIndex: 60, maxHeight: 320, overflowY: "auto", borderRadius: 12, padding: 4, background: "var(--board-card-glass)", backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))", border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)", boxShadow: "0 4px 18px -6px rgba(0,0,0,0.28)" }}>
          {!nodeVisible && !bodyVisible && !bodyPending && (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>{t("boards.searchNoResults")}</div>
          )}
          {bodyPending && (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>{t("search.indexing")}</div>
          )}

          {/* 节点命中 */}
          {nodeVisible && (
            <>
              {bodyVisible && <GroupLabel text={t("boards.searchGroupNodes")} />}
              {matches.map((m, i) => {
                const active = i === activeIndex;
                return (
                  <button key={m.item.nodeId} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => locate(i)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 10px", border: "none", borderRadius: 8, background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "transparent", color: "var(--text)", fontSize: 12.5, textAlign: "left", cursor: "pointer" }}>
                    <span aria-hidden style={{ flexShrink: 0, display: "inline-flex", color: active ? "var(--accent)" : "var(--text-dim)" }}>
                      {m.item.kind === "session-card" ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z" /><path d="M15 3v6h6" /></svg>
                      )}
                    </span>
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.snippet}</span>
                    <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{m.item.kind === "session-card" ? t("boards.searchSession") : t("boards.searchNote")}</span>
                  </button>
                );
              })}
            </>
          )}

          {/* 正文命中 */}
          {bodyVisible && (
            <>
              {nodeVisible && <GroupLabel text={t("boards.searchGroupBody")} />}
              {bodyHits!.map((hit, i) => {
                const idx = matches.length + i;
                const active = idx === activeIndex;
                return (
                  <button key={hit.sessionId} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => locate(idx)} style={{ display: "flex", flexDirection: "column", gap: 2, width: "100%", padding: "6px 10px", border: "none", borderRadius: 8, background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "transparent", color: "var(--text)", fontSize: 12.5, textAlign: "left", cursor: "pointer" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      {hit.titleMatch && (
                        <span style={{ flexShrink: 0, fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--accent)", background: "color-mix(in srgb, var(--accent) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)", borderRadius: 3, padding: "0 4px", lineHeight: "15px" }}>
                          {t("search.title")}
                        </span>
                      )}
                      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>{hit.title}</span>
                      <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{t("boards.searchBodyTag")}</span>
                    </span>
                    {hit.snippet && (
                      <span style={{ minWidth: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {renderBodySnippet(hit.snippet)}
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 分组小标题（节点命中 / 正文命中） */
function GroupLabel({ text }: { text: string }) {
  return (
    <div style={{ padding: "6px 12px 2px", fontSize: 10, fontWeight: 700, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.5 }}>
      {text}
    </div>
  );
}

/** 正文 FTS snippet 的 [ … ] 命中标记 → 高亮片段 */
function renderBodySnippet(snippet: string): React.ReactNode {
  const parts = snippet.split(/([\[\]])/g);
  let highlight = false;
  return parts.map((part, i) => {
    if (part === "[") { highlight = true; return null; }
    if (part === "]") { highlight = false; return null; }
    if (!part) return null;
    return highlight
      ? <mark key={i} style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text)", borderRadius: 2 }}>{part}</mark>
      : <span key={i}>{part}</span>;
  });
}

/** 命中片段：以首个命中位置为中心截取 ~44 字符 */
function makeSnippet(text: string, query: string, maxLen = 44): string {
  const q = query.trim().toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
  const start = Math.max(0, idx - Math.floor((maxLen - q.length) / 2));
  const end = Math.min(text.length, start + maxLen);
  const head = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${head}${text.slice(start, end)}${tail}`;
}
