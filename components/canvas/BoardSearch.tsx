"use client";

/**
 * 看板内搜索框（常驻，画布顶部居中，玻璃胶囊）—— RF 版。
 * 遍历 RF nodes（会话卡标题 + 便笺正文），定位 = setViewport 居中 + 高亮描边。
 * 需要 ReactFlowProvider 包裹（SessionCanvas 提供）。
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import { useI18n } from "@/hooks/useI18n";
import { useBoardSearch } from "./BoardSearchContext";

export interface SearchableItem {
  nodeId: string;
  kind: "session-card" | "sticky-note";
  text: string;
}

export function BoardSearch({
  editor: _unused,
  inputRef,
  nodes,
}: {
  /** 兼容旧签名（RF 版不再用 tldraw editor） */
  editor?: unknown;
  /** Ctrl+F 聚焦目标 */
  inputRef?: RefObject<HTMLInputElement | null>;
  /** 当前画布节点（搜索遍历对象） */
  nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }>;
}) {
  const { t } = useI18n();
  const { setHighlight } = useBoardSearch();
  const { setViewport, getViewport, getNodes } = useReactFlow();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const localRef = useRef<HTMLInputElement>(null);
  const focusEl = inputRef ?? localRef;

  // 可搜索节点：会话卡标题 + 便笺正文
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /** 定位：把命中节点平移到视口中心（保持缩放）+ 高亮描边 */
  const locate = useCallback((index: number) => {
    const m = matches[index];
    if (!m) return;
    const node = (getNodes() as Array<{ id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number } }>).find((n) => n.id === m.item.nodeId);
    if (!node) return;
    const w = node.measured?.width ?? 340;
    const h = node.measured?.height ?? 160;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const vp = getViewport();
    // 屏幕中心 = viewport 平移 + 缩放
    setViewport({
      x: -cx * vp.zoom + window.innerWidth / 2,
      y: -cy * vp.zoom + window.innerHeight / 2,
      zoom: vp.zoom,
    }, { duration: 300 });
    setHighlight(m.item.nodeId);
    setActiveIndex(index);
  }, [matches, getNodes, getViewport, setViewport, setHighlight]);

  const locateNext = useCallback(() => {
    if (matches.length === 0) return;
    locate((activeIndex + 1) % matches.length);
  }, [matches, activeIndex, locate]);

  const locatePrev = useCallback(() => {
    if (matches.length === 0) return;
    locate((activeIndex - 1 + matches.length) % matches.length);
  }, [matches, activeIndex, locate]);

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

  return (
    <div style={{ position: "relative", width: 280 }} data-testid="board-search">
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
          {matches.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>{t("boards.searchNoResults")}</div>
          ) : (
            matches.map((m, i) => {
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
            })
          )}
        </div>
      )}
    </div>
  );
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
