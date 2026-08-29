"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Tldraw, defaultShapeUtils, type TLComponents } from "tldraw";
import { SessionCardUtil } from "./SessionCardShape";
import { useI18n } from "@/hooks/useI18n";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import type { SessionInfo } from "@/lib/types";

// 自定义 shape util + tldraw 默认（arrow 连线等）。
const shapeUtils = [...defaultShapeUtils, SessionCardUtil];

/**
 * tldraw 画布舞台：无限画布 + 工具行 + 连线模式 + 拖放添加会话。
 * 收合卡 shape 用 SessionCardUtil；连线用 tldraw 原生 arrow。
 */
export function CanvasStage({
  board,
  connectMode,
  onToggleConnectMode,
  isDark,
}: {
  board: UseBoardCanvasReturn;
  connectMode: boolean;
  onToggleConnectMode: () => void;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // 加载会话列表（添加会话用）
  const loadSessions = useCallback(async () => {
    setPickerLoading(true);
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { sessions: SessionInfo[] };
        setSessions(data.sessions);
      }
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const components = useMemo<TLComponents>(() => ({
    // 保留 tldraw 默认 UI（工具条/缩放/小地图），但去掉我们不需要的
    // ActionsMenu/HelpMenu/MainMenu/PageMenu 等顶栏项，保持画布干净。
    ActionsMenu: null,
    HelpMenu: null,
    MainMenu: null,
    PageMenu: null,
    StylePanel: null,
    SharePanel: null,
    MenuPanel: null,
    TopPanel: null,
    KeyboardShortcutsDialog: null,
    DebugPanel: null,
    DebugMenu: null,
  }), []);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      {/* 工具行（chrome 材质，同看板栏第二行） */}
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderBottom: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          background: "var(--frame-glass)",
          backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
        }}
      >
        {/* 添加会话 */}
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => { void loadSessions(); setPickerOpen((v) => !v); }}
            title={t("boards.addSession")}
            aria-expanded={pickerOpen}
            style={toolBtnStyle(undefined, pickerOpen)}
          >
            <span style={{ fontSize: 13, lineHeight: 1 }}>＋</span>
            <span>{t("boards.addSession")}</span>
          </button>
          {pickerOpen && (
            <div
              className="glass-popover"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                left: 0,
                zIndex: 1150,
                width: 280,
                maxHeight: 320,
                overflowY: "auto",
                padding: 4,
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                boxShadow: "0 8px 24px -8px rgba(0,0,0,0.25)",
              }}
            >
              {pickerLoading ? (
                <div style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.loading")}</div>
              ) : sessions.length === 0 ? (
                <div style={{ padding: "10px 8px", color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" }}>
                  {t("boards.noSessions")}
                </div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      board.addSessionNode(s.id);
                      setPickerOpen(false);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 10px",
                      border: "none",
                      background: "none",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 12.5,
                      textAlign: "left",
                      borderRadius: 6,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                  >
                    {s.name ?? s.firstMessage ?? s.id}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* 连线模式 */}
        <button
          type="button"
          onClick={onToggleConnectMode}
          title={t("boards.connectDesc")}
          aria-pressed={connectMode}
          style={toolBtnStyle(connectMode ? "var(--accent)" : undefined, connectMode)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
          <span>{t("boards.connect")}</span>
        </button>

        {/* 自动布局（本期置灰占位） */}
        <button type="button" disabled title={t("boards.autoLayoutDesc")} style={{ ...toolBtnStyle(undefined, false), opacity: 0.4, cursor: "default" }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          <span>{t("boards.autoLayout")}</span>
        </button>

        <div style={{ flex: 1 }} />

        {/* 清理失效节点 */}
        <button
          type="button"
          onClick={() => void board.cleanupInvalid()}
          title={t("boards.cleanupDesc")}
          style={toolBtnStyle(undefined, false)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          <span>{t("boards.cleanup")}</span>
        </button>
      </div>

      {/* tldraw 舞台 */}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {board.loading ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("boards.loadingCanvas")}
          </div>
        ) : board.error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: 13 }}>
            {board.error}
          </div>
        ) : (
          <Tldraw
            shapeUtils={shapeUtils}
            onMount={board.onMount}
            components={components}
            autoFocus={false}
            colorScheme={isDark ? "dark" : "light"}
          />
        )}
      </div>
    </div>
  );
}

function toolBtnStyle(activeColor?: string, active?: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 10px",
    border: "1px solid color-mix(in srgb, var(--border) 50%, transparent)",
    background: active ? "var(--side-active)" : "var(--glass-bg-input)",
    color: activeColor ?? "var(--text)",
    cursor: "pointer",
    fontSize: 12,
    borderRadius: 7,
    whiteSpace: "nowrap",
  };
}
