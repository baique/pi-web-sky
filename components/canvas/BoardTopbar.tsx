"use client";

/**
 * 看板左上角功能区（独立浮层，画布核心不动）。
 *
 * - 常驻：看板名 + 刷新、新建会话、磨砂调节、清空画布
 * - 展开（chevron）：进行中 —— 当前画面中运行中的会话卡 + 展开态（工作中）的会话卡，
 *   点击定位到卡片（平移居中 + accent 描边渐隐，与 Ctrl+F 搜索同一套 setViewport + setHighlight 机制）。
 *
 * 必须在 ReactFlowProvider + BoardSearchProvider 内渲染（useReactFlow / setHighlight）。
 */

import { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import type { WallpaperSettings } from "@/lib/wallpaper-settings";
import { boardFloatGlass } from "./board-glass";

export function BoardTopbar({
  boardName,
  isTaskBoard,
  reloading,
  onReload,
  onClear,
  onAddSessionCard,
  wallSettings,
  updateWallSettings,
}: {
  boardName: string;
  /** 任务看板：清空文案与可用性提示随此变化 */
  isTaskBoard: boolean;
  reloading: boolean;
  onReload: () => void;
  /** 清空画布（父级已做确认制 + clearBoard） */
  onClear: () => void;
  /** 新建会话卡（父级 board.addNewSessionCard；本组件算好视口中心 flow 坐标传入） */
  onAddSessionCard: (flowPos?: { x: number; y: number }) => void;
  wallSettings: WallpaperSettings;
  updateWallSettings: (patch: Partial<WallpaperSettings>) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [scrimOpen, setScrimOpen] = useState(false);

  const newAtViewportCenter = () => {
    const pane = document.querySelector(".react-flow__pane");
    const rect = pane?.getBoundingClientRect();
    if (!rect) return;
    const flowPos = screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    onAddSessionCard(flowPos);
  };

  return (
    <div style={{ position: "absolute", top: 12, left: 12, zIndex: 40, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, maxWidth: "min(420px, calc(100% - 320px))" }}>
      {/* 主胶囊：看板名 + 刷新 + 新建/磨砂/清空 */}
      <div style={{
        ...boardFloatGlass,
        display: "flex", alignItems: "center", gap: 4, height: 36,
        padding: "0 6px 0 12px", borderRadius: 999,
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
        color: "var(--text)",
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
        <span title={boardName} style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
          {boardName || "看板"}
        </span>
        <button
          type="button"
          onClick={onReload}
          title="刷新画布"
          aria-label="刷新画布"
          style={{ ...btnStyle, cursor: reloading ? "default" : "pointer" }}
          {...(reloading ? {} : iconHoverProps())}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ animation: reloading ? "spin 0.8s linear infinite" : undefined }}>
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>

        <span style={{ flexShrink: 0, width: 1, height: 18, background: "color-mix(in srgb, var(--border) 70%, transparent)", margin: "0 2px" }} />

        {/* 新建会话 */}
        <button
          type="button"
          onClick={newAtViewportCenter}
          title="新建会话"
          aria-label="新建会话"
          style={btnStyle}
          {...iconHoverProps()}
        >
          {/* 与左侧栏新建会话同款聊天气泡图标 */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>

        {/* 磨砂调节 */}
        <button
          type="button"
          onClick={() => setScrimOpen((v) => !v)}
          title="磨砂调节"
          aria-label="磨砂调节"
          aria-expanded={scrimOpen}
          style={{ ...btnStyle, color: scrimOpen ? "var(--accent)" : "var(--text-muted)", background: scrimOpen ? "color-mix(in srgb, var(--accent) 12%, transparent)" : undefined }}
          {...(scrimOpen ? {} : iconHoverProps())}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v2" />
            <path d="M12 19v2" />
            <path d="M5 7l1.5 1.5" />
            <path d="M17.5 15.5L19 17" />
            <path d="M3 12h2" />
            <path d="M19 12h2" />
            <path d="M5 17l1.5-1.5" />
            <path d="M17.5 8.5L19 7" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        {/* 清空画布 */}
        <button
          type="button"
          onClick={onClear}
          title={isTaskBoard ? "清空画布（任务卡片保留）" : "清空画布"}
          aria-label="清空画布"
          style={btnStyle}
          {...iconHoverProps()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* 磨砂滑块（展开时显示，原右上角浮层原样移入） */}
      {scrimOpen && (
        <div style={panelStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 14, flexShrink: 0, textAlign: "center", fontSize: 12 }}>❄</span>
            <span style={{ flexShrink: 0, fontSize: 12.5 }}>磨砂</span>
            <input
              type="range"
              min={0}
              max={30}
              value={wallSettings.scrimBlur}
              onChange={(e) => updateWallSettings({ scrimBlur: Number(e.target.value) })}
              style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)", cursor: "pointer" }}
              aria-label="磨砂强度"
            />
            <span style={{ width: 30, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text)" }}>
              {wallSettings.scrimBlur}px
            </span>
          </div>
        </div>
      )}

    </div>
  );
}

const btnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 2,
  width: 30,
  height: 30,
  padding: 0,
  flexShrink: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: 999,
  transition: "background 0.12s, color 0.12s",
};

/** 图标按钮 hover：背景浅提亮（--text 弱化色，深浅主题自适应）；展开态不注入避免覆盖底色 */
function iconHoverProps() {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.background = "color-mix(in srgb, var(--text) 8%, transparent)";
    },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.background = "transparent";
    },
  };
}

/** 浮层面板（磨砂）的玻璃样式 */
const panelStyle: React.CSSProperties = {
  ...boardFloatGlass,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 10px",
  borderRadius: 12,
  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
  boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
  color: "var(--text)",
  whiteSpace: "nowrap",
};
