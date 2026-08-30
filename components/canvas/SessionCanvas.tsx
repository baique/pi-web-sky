"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { useBoardCanvas } from "@/hooks/useBoardCanvas";
import { useBoardScrimSettings } from "@/lib/board-scrim-settings";
import type { SessionInfo } from "@/lib/types";

// ssr:false — tldraw 依赖浏览器环境，仅进入看板模式时下载（~1MB）。
const CanvasStage = dynamic(() => import("./CanvasStage").then((m) => m.CanvasStage), {
  ssr: false,
  loading: () => (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-muted)",
        fontSize: 13,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: "2px solid color-mix(in srgb, var(--text) 15%, transparent)",
            borderTopColor: "var(--accent)",
            animation: "spin 0.8s linear infinite",
          }}
        />
        Loading canvas…
      </div>
    </div>
  ),
});

/**
 * 看板模式容器：主区域整体替换为画布（侧栏保留）。
 * - 无顶部栏：切换看板走侧栏 BoardList；拖入会话、连线走画布自身交互
 * - 画布（tldraw）：无限画布 / 缩放 / 平移 / 拖拽 / 框选；底部工具条含清理失效按钮
 * - 会话卡：双击展开工作台（复用 ChatWindow，嵌卡片内）
 */
export function SessionCanvas({
  boardId,
  projectKey,
  onOpenSession,
  onRunningSessionIdsChange,
}: {
  boardId: string;
  projectKey?: string;
  onExit: () => void;
  onOpenSession: (session: SessionInfo, isRestore?: boolean) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
}) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const board = useBoardCanvas({ boardId, projectKey, onOpenSession: (sid) => onOpenSession({ id: sid } as SessionInfo, false) });
  const { settings: scrim, update: updateScrim } = useBoardScrimSettings();
  const [scrimOpen, setScrimOpen] = useState(false);

  // 运行中集合上报给 AppShell（顶部会话运行状态保持一致）
  useEffect(() => {
    onRunningSessionIdsChange?.(new Set(board.running?.runningSessionIds ?? []));
  }, [board.running, onRunningSessionIdsChange]);

  return (
    // 看板模式容器：完全透明，壁纸/页面背景直接透出。玻璃只挂在卡片上（--board-card-glass），
    // 不整块涂气泡白玻璃——看板底与壁纸不冲突。
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* 顶部悬浮按钮组：清理失效 + 磨砂调节 */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          zIndex: 30,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: 4,
            borderRadius: 10,
            background: "var(--board-card-glass)",
            backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
          }}
        >
          <button
            type="button"
            onClick={() => setScrimOpen((v) => !v)}
            title={t("boards.scrimTitle")}
            aria-expanded={scrimOpen}
            style={{
              ...floatingIconBtn,
              color: scrimOpen ? "var(--accent)" : "var(--text-muted)",
              background: scrimOpen ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
            }}
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
          <button
            type="button"
            onClick={() => void board.cleanupInvalid()}
            title={t("boards.cleanupDesc")}
            style={floatingIconBtn}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
        {scrimOpen && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 10px",
              borderRadius: 10,
              background: "var(--board-card-glass)",
              backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
              boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
              color: "var(--text)",
              fontSize: 12.5,
              whiteSpace: "nowrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 14, flexShrink: 0, textAlign: "center", fontSize: 12 }}>◐</span>
              <span style={{ flexShrink: 0 }}>{t("boards.scrimAlpha")}</span>
              <input
                type="range"
                min={0}
                max={100}
                value={scrim.alpha}
                onChange={(e) => updateScrim({ alpha: Number(e.target.value) })}
                style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)", cursor: "pointer" }}
                aria-label={t("boards.scrimAlpha")}
              />
              <span style={{ width: 34, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text-dim)" }}>
                {scrim.alpha}%
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 14, flexShrink: 0, textAlign: "center", fontSize: 12 }}>❄</span>
              <span style={{ flexShrink: 0 }}>{t("boards.scrimBlur")}</span>
              <input
                type="range"
                min={0}
                max={30}
                value={scrim.blur}
                onChange={(e) => updateScrim({ blur: Number(e.target.value) })}
                style={{ flex: 1, minWidth: 120, accentColor: "var(--accent)", cursor: "pointer" }}
                aria-label={t("boards.scrimBlur")}
              />
              <span style={{ width: 30, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text-dim)" }}>
                {scrim.blur}px
              </span>
            </div>
          </div>
        )}
      </div>
      <CanvasStage
        board={board}
        isDark={isDark}
      />
    </div>
  );
}

const floatingIconBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: 7,
  transition: "background 0.12s, color 0.12s",
};
