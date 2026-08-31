"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatedDropdown } from "@/components/AnimatedDropdown";

/**
 * 主题化下拉选择（替代原生 select）：观感对齐侧栏 worktree 选择器，
 * 复用 --side-* / --border / --text token，深色浅色主题自适应。
 * 用法：受控（value + onChange），options 为 { value, label } 数组。
 */
export interface ThemedSelectOption {
  value: string;
  label: string;
}

export function ThemedSelect({
  value,
  options,
  onChange,
  width = "100%",
}: {
  value: string;
  options: ThemedSelectOption[];
  onChange: (value: string) => void;
  width?: string | number;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const selected = options.find((o) => o.value === value);

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
          gap: 6,
          padding: "0 8px",
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
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.label ?? ""}
        </span>
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
            minWidth: 120,
            maxHeight: 200,
            overflowY: "auto",
            // 浮层弹窗玻璃：比 chrome 浓（--popover-glass），避免列表浮在画布/壁纸上显得发虚。
            // 卡内不挂 backdrop-filter（卡根已有 blur，嵌套 backdrop root 只会重复模糊）。
            background: "var(--popover-glass)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 6px 20px -6px rgba(0,0,0,0.35)",
            padding: 4,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              style={{
                display: "block",
                width: "100%",
                boxSizing: "border-box",
                padding: "5px 8px",
                border: "none",
                borderRadius: 4,
                background: o.value === value ? "var(--side-active)" : "transparent",
                color: "var(--text)",
                fontSize: 11,
                textAlign: "left",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--side-hover)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = o.value === value ? "var(--side-active)" : "transparent"; }}
            >
              {o.label}
            </button>
          ))}
        </AnimatedDropdown>
      )}
    </div>
  );
}
