"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";
import { useTheme } from "@/hooks/useTheme";
import { DEFAULT_EMOJI, resolveEmoji, randomEmoji, STATUS_EMOJI, type EmojiCardKind } from "@/lib/card-emoji";

/**
 * 卡片标题栏 emoji 选择器（会话/任务/便笺共用）。
 * - 显示：状态跟随（🚀/🤔/⏳/😱）> 用户设置 > 类别默认（💬/✅/📝）
 * - 点击 → portal 弹层（fixed 定位锚点旁 + 视口翻转），绕开卡片 overflow:hidden 裁剪
 * - 面板：emoji-picker-react v4 + 底部【随机】【清除】；CSS 变量覆盖成项目苹果风
 * - 关闭：点击外部 / Esc / 画布滚轮缩放（fixed 坐标失准，不做跟随）
 */
const PANEL_W = 288;
const PANEL_H = 340; // emoji 网格 300 + footer ~36 + 边距余量
const PANEL_GAP = 4;

/** 苹果风覆盖：emoji-picker-react 的 --epr-* 变量，映射到项目 token（明暗自适应） */
const EPR_VARS: Record<string, string> = {
  "--epr-bg-color": "var(--popover-glass)",
  "--epr-dark-bg-color": "var(--popover-glass)",
  "--epr-text-color": "var(--text)",
  "--epr-dark-text-color": "var(--text)",
  "--epr-picker-border-color": "transparent",
  "--epr-dark-picker-border-color": "transparent",
  "--epr-picker-border-radius": "16px",
  "--epr-hover-bg-color": "var(--side-hover)",
  "--epr-dark-hover-bg-color": "var(--side-hover)",
  "--epr-dark-hover-bg-color-reduced-opacity": "var(--side-hover)",
  "--epr-focus-bg-color": "var(--side-hover)",
  "--epr-dark-focus-bg-color": "var(--side-hover)",
  "--epr-search-input-bg-color": "var(--side-input)",
  "--epr-dark-search-input-bg-color": "var(--side-input)",
  "--epr-search-input-bg-color-active": "var(--side-input)",
  "--epr-dark-search-input-bg-color-active": "var(--side-input)",
  "--epr-search-border-color": "var(--border)",
  "--epr-dark-search-border-color": "var(--border)",
  "--epr-search-input-border-radius": "8px",
  "--epr-search-input-text-color": "var(--text)",
  "--epr-dark-search-input-text-color": "var(--text)",
  "--epr-search-input-placeholder-color": "var(--text-dim)",
  "--epr-dark-search-input-placeholder-color": "var(--text-dim)",
  "--epr-category-label-bg-color": "var(--popover-glass)",
  "--epr-dark-category-label-bg-color": "var(--popover-glass)",
  "--epr-category-label-text-color": "var(--text-muted)",
  "--epr-dark-category-label-text-color": "var(--text-muted)",
  "--epr-category-icon-active-color": "var(--accent)",
  "--epr-dark-category-icon-active-color": "var(--accent)",
  "--epr-emoji-size": "22px",
  "--epr-emoji-padding": "3px",
  "--epr-category-navigation-button-size": "26px",
  "--epr-header-padding": "6px 8px 0",
  "--epr-horizontal-padding": "8px",
  "--epr-category-padding": "6px",
  "--epr-highlight-color": "var(--accent)",
  "--epr-dark-highlight-color": "var(--accent)",
};

export function EmojiPickerField({
  kind,
  value,
  status,
  onChange,
}: {
  kind: EmojiCardKind;
  value?: string;
  status?: string | null;
  onChange: (emoji: string) => void;
}) {
  const { isDark } = useTheme();
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const override = status ? STATUS_EMOJI[kind]?.[status] ?? null : null;
  const display = resolveEmoji(kind, value, status);

  const openPanel = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    if (left + PANEL_W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - PANEL_W - 8);
    let top = rect.bottom + PANEL_GAP;
    if (top + PANEL_H > window.innerHeight - 8) top = Math.max(8, rect.top - PANEL_GAP - PANEL_H);
    setPos({ left, top });
    setOpen(true);
  }, []);

  // 关闭：点击外部 / Esc / 画布滚轮（缩放时 fixed 坐标失准，直接关）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // 滚轮：仅在画布缩放面（.react-flow__pane）上滚动才关（缩放使 fixed 坐标失准）；
    // 卡内滚动区（nowheel/内部容器）不关——滚动内容不必打断选 emoji。
    const onWheel = (e: WheelEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if ((e.target as Node)?.nodeType === Node.ELEMENT_NODE && (e.target as Element).closest?.(".react-flow__pane")) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("wheel", onWheel);
    };
  }, [open]);

  const handlePick = useCallback(
    (emoji: EmojiClickData) => {
      onChange(emoji.emoji);
      setOpen(false);
    },
    [onChange],
  );

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      // 卡内按钮惯例：阻断冒泡（含 dblclick）——否则两次快速点击会冒泡到卡根
      // 触发展开/收合（会话/任务卡）或进入编辑（便笺）
      e.stopPropagation();
      if (open) {
        setOpen(false); // 已开：点击触发钮关闭（toggle）
        return;
      }
      openPanel();
    },
    [open, openPanel],
  );
  const handleTriggerDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="nodrag"
        title={override ? `状态跟随：${override}（点击设置 emoji）` : `选择 emoji（当前：${display}）`}
        aria-label="选择 emoji"
        onClick={handleToggle}
        onDoubleClick={handleTriggerDoubleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 22,
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: hovered ? "var(--side-hover)" : "transparent",
          fontSize: 13,
          lineHeight: 1,
          cursor: "pointer",
          transition: "background 0.12s",
        }}
      >
        {display}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="nodrag"
            style={{ position: "fixed", left: pos.left, top: pos.top, width: PANEL_W, zIndex: 300 }}
          >
            <div
              style={{
                borderRadius: 16,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--popover-glass)",
                // 面板挂 body 下（portal），可安全用 backdrop-filter（卡内嵌套会重复模糊，这里不会）
                backdropFilter: "blur(var(--glass-blur-popover)) saturate(var(--glass-saturate))",
                WebkitBackdropFilter: "blur(var(--glass-blur-popover)) saturate(var(--glass-saturate))",
                boxShadow: "0 18px 44px -14px rgba(0,0,0,0.42)",
              }}
            >
              <EmojiPicker
                theme={isDark ? Theme.DARK : Theme.LIGHT}
                emojiStyle={EmojiStyle.NATIVE}
                lazyLoadEmojis
                skinTonesDisabled
                autoFocusSearch={false}
                width={PANEL_W}
                height={300}
                previewConfig={{ showPreview: false }}
                onEmojiClick={handlePick}
                style={EPR_VARS as React.CSSProperties}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 10px 9px",
                  borderTop: "1px solid var(--bubble-hairline)",
                }}
              >
                <button
                  type="button"
                  onClick={() => onChange(randomEmoji(value))}
                  title="随机换一个"
                  style={footerBtnStyle}
                >
                  🎲 随机
                </button>
                <button
                  type="button"
                  onClick={() => { onChange(""); setOpen(false); }}
                  title={`清除，恢复默认 ${DEFAULT_EMOJI[kind]}`}
                  style={footerBtnStyle}
                >
                  清除
                </button>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  已设置：{value || DEFAULT_EMOJI[kind]}
                </span>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

const footerBtnStyle: React.CSSProperties = {
  border: "none",
  background: "color-mix(in srgb, var(--border) 30%, transparent)",
  color: "var(--text-muted)",
  borderRadius: 6,
  padding: "3px 10px",
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
