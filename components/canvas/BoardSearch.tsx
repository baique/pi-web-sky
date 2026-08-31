"use client";

/**
 * 看板内搜索框（常驻，画布顶部居中，玻璃胶囊）。
 *
 * 交互（spec 2026-08-30-board-search）：
 * - 输入实时过滤：遍历画布 shape（会话卡标题 + 便笺正文），下拉显示命中列表
 * - Enter / ↓：定位下一个命中（循环）；↑：上一个；点击命中项：定位该项
 * - 定位 = zoomToBounds 动画 + 选中 + accent 描边渐隐（BoardSearchContext 驱动）
 * - Esc：下拉开时先关下拉；再按清空并失焦（关闭搜索）
 * - 失焦不清空 query，仅收下拉；再聚焦恢复列表
 * - Ctrl+F 聚焦由 SessionCanvas 处理（通过 inputRef prop 传入本组件 input）
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Editor } from "tldraw";
import { useI18n } from "@/hooks/useI18n";
import { collectSearchable, filterMatches } from "@/lib/board-search";
import type { SearchMatch } from "@/lib/board-search";
import { useBoardSearch } from "./BoardSearchContext";

export function BoardSearch({
  editor,
  inputRef,
}: {
  editor: Editor | null;
  /** Ctrl+F 聚焦目标（SessionCanvas 传入；不传则用内部 ref） */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  const { setHighlight } = useBoardSearch();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  /** 当前定位/浏览的命中下标（-1 = 未定位任何命中） */
  const [activeIndex, setActiveIndex] = useState(-1);
  const localRef = useRef<HTMLInputElement>(null);
  const focusEl = inputRef ?? localRef;

  const matches = useMemo<SearchMatch[]>(() => {
    if (!editor) return [];
    return filterMatches(collectSearchable(editor), query);
  }, [editor, query]);

  /** 定位到第 index 个命中：居中平移（保持当前缩放，centerOnPoint）+ 选中 + 高亮描边（已失效 shape 跳过） */
  const locate = useCallback((index: number) => {
    if (!editor) return;
    const match = matches[index];
    if (!match) return;
    const shape = editor.getShape(match.item.shapeId);
    if (!shape) return;
    const bounds = editor.getShapePageBounds(shape.id);
    if (!bounds) return;
    // 只定位：把命中节点平移到视口中心，不改缩放级别（不做 zoom 自适应）
    editor.centerOnPoint(bounds.center, { animation: { duration: 300 } });
    editor.select(shape.id);
    setHighlight(shape.id);
    setActiveIndex(index);
  }, [editor, matches, setHighlight]);

  const locateNext = useCallback(() => {
    if (matches.length === 0) return;
    locate((activeIndex + 1) % matches.length);
  }, [matches, activeIndex, locate]);

  const locatePrev = useCallback(() => {
    if (matches.length === 0) return;
    locate((activeIndex - 1 + matches.length) % matches.length);
  }, [matches, activeIndex, locate]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      locateNext();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      locatePrev();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (open) {
        setOpen(false);
      } else {
        setQuery("");
        setActiveIndex(-1);
        focusEl.current?.blur();
      }
    }
    // 其余按键放行（输入正常）；不 stopPropagation——tldraw 对 input 焦点自动豁免键盘
  }, [open, locateNext, locatePrev, focusEl]);

  const showDropdown = open && query.trim().length > 0;

  return (
    <div style={{ position: "relative", width: 280 }} data-testid="board-search">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 34,
          padding: "0 8px 0 10px",
          borderRadius: 999,
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ color: "var(--text-dim)", flexShrink: 0 }}
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          ref={focusEl}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onBlur={() => setOpen(false)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={t("boards.searchPlaceholder")}
          spellCheck={false}
          aria-label={t("boards.searchPlaceholder")}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--text)",
            fontSize: 12.5,
            fontFamily: "inherit",
          }}
        />
        {query && (
          <button
            type="button"
            title={t("common.close")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setQuery("");
              setActiveIndex(-1);
              focusEl.current?.focus();
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              padding: 0,
              border: "none",
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--border) 35%, transparent)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        )}
      </div>

      {showDropdown && (
        <div
          data-testid="board-search-dropdown"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 40,
            left: 0,
            right: 0,
            zIndex: 60,
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: 12,
            padding: 4,
            background: "var(--board-card-glass)",
            backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            boxShadow: "0 4px 18px -6px rgba(0,0,0,0.28)",
          }}
        >
          {matches.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-muted)" }}>
              {t("boards.searchNoResults")}
            </div>
          ) : (
            matches.map((m, i) => {
              const active = i === activeIndex;
              return (
                <button
                  key={m.item.shapeId}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => locate(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 10px",
                    border: "none",
                    borderRadius: 8,
                    background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : "transparent",
                    color: "var(--text)",
                    fontSize: 12.5,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span aria-hidden style={{ flexShrink: 0, display: "inline-flex", color: active ? "var(--accent)" : "var(--text-dim)" }}>
                    {m.item.kind === "session-card" ? (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3z" />
                        <path d="M15 3v6h6" />
                      </svg>
                    )}
                  </span>
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.snippet}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
                    {m.item.kind === "session-card" ? t("boards.searchSession") : t("boards.searchNote")}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
