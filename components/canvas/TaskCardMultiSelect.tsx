"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatedDropdown } from "@/components/AnimatedDropdown";
import type { TaskCard } from "@/lib/task-card-store";

/**
 * 同看板任务卡多选下拉（前置/关联依赖选择用）。
 * - 候选卡只看本看板（调用方已按 boardId 过滤），每项 `#N 名称`。
 * - 触发框：已选 chips（#N）+ 计数；下拉内复选，选中不关闭（连续多选）。
 * - 浮层样式与 ThemedSelect 同源（--popover-glass，深浅主题自适应）。
 */
export function TaskCardMultiSelect({
  candidates,
  selected,
  onChange,
  placeholder = "选择任务卡…",
  excludeId,
  width = "100%",
}: {
  candidates: TaskCard[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  excludeId?: string;
  width?: string | number;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const options = candidates.filter((c) => c.id !== excludeId);
  const selectedSet = new Set(selected);

  // 点击外部 / Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (id: string) => {
    onChange(selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  const selectedCandidates = options.filter((c) => selectedSet.has(c.id));
  const overflowCount = selectedCandidates.length > 3 ? selectedCandidates.length - 3 : 0;
  const visibleChips = selectedCandidates.slice(0, 3);

  return (
    <div ref={rootRef} style={{ position: "relative", width }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: "100%",
          height: 28,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "0 6px",
          background: open ? "var(--side-active)" : hovered ? "var(--side-hover)" : "transparent",
          border: "1px solid var(--border)",
          borderRadius: 5,
          cursor: "pointer",
          fontSize: 11,
          color: "var(--text)",
          textAlign: "left",
          transition: "background 0.12s",
        }}
      >
        {visibleChips.length > 0 ? (
          <>
            {visibleChips.map((c) => (
              <span
                key={c.id}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  padding: "1px 5px",
                  borderRadius: 999,
                  background: "var(--side-selected)",
                  color: "var(--accent)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                }}
              >
                #{c.number}
              </span>
            ))}
            {overflowCount > 0 && (
              <span style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 10 }}>+{overflowCount}</span>
            )}
          </>
        ) : (
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }}>
            {placeholder}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open && (
        <AnimatedDropdown
          open
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 120,
            minWidth: 160,
            maxHeight: 180,
            overflowY: "auto",
            background: "var(--popover-glass)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 6px 20px -6px rgba(0,0,0,0.35)",
            padding: 4,
          }}
        >
          {options.length === 0 ? (
            <div style={{ padding: "8px", color: "var(--text-dim)", fontSize: 11 }}>本看板无其他任务卡</div>
          ) : (
            options.map((c) => {
              const checked = selectedSet.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); toggle(c.id); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "5px 8px",
                    border: "none",
                    borderRadius: 4,
                    background: checked ? "var(--side-selected)" : "transparent",
                    color: "var(--text)",
                    fontSize: 11,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    if (!checked) (e.currentTarget as HTMLButtonElement).style.background = "var(--side-hover)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLButtonElement).style.background = checked ? "var(--side-selected)" : "transparent";
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: 12,
                      height: 12,
                      borderRadius: 3,
                      border: "1px solid var(--border)",
                      background: checked ? "var(--accent)" : "transparent",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--accent-contrast, #fff)",
                    }}
                  >
                    {checked && (
                      <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="1.5 5 3.5 7 8.5 2" />
                      </svg>
                    )}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }}>#{c.number}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                </button>
              );
            })
          )}
        </AnimatedDropdown>
      )}
    </div>
  );
}
