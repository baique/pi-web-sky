"use client";

import "tldraw/tldraw.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tldraw, defaultShapeUtils, type TLComponents } from "tldraw";
import { SessionCardUtil } from "./SessionCardShape";
import { WorkbenchOverlay } from "./WorkbenchOverlay";
import { useI18n } from "@/hooks/useI18n";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import type { SessionInfo } from "@/lib/types";

// 自定义 shape util + tldraw 默认（arrow 连线等）。
const shapeUtils = [...defaultShapeUtils, SessionCardUtil];

/**
 * tldraw 画布舞台：无限画布 + 工具行 + 拖放添加会话。
 * 连线用 tldraw 内置 arrow 工具（工具栏已有），不做自定义连线。
 */
export function CanvasStage({
  board,
  isDark,
}: {
  board: UseBoardCanvasReturn;
  isDark: boolean;
}) {
  const { t } = useI18n();
  const [dragOver, setDragOver] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // 会话拖入画布：tldraw 内部会 stopPropagation drop，React 合成 onDrop 收不到。
  // 改用原生事件监听（挂在外层容器，捕获阶段提前拦截）。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onDragOverNative = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/session-id")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(true);
    };
    const onDragLeaveNative = () => setDragOver(false);
    const onDropNative = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/session-id")) return;
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const sid = e.dataTransfer.getData("text/session-id");
      if (!sid) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      board.addSessionNode(sid, x, y);
    };
    // 捕获阶段挂载：确保先于 tldraw 内部处理拿到事件
    el.addEventListener("dragover", onDragOverNative, true);
    el.addEventListener("dragleave", onDragLeaveNative, true);
    el.addEventListener("drop", onDropNative, true);
    return () => {
      el.removeEventListener("dragover", onDragOverNative, true);
      el.removeEventListener("dragleave", onDragLeaveNative, true);
      el.removeEventListener("drop", onDropNative, true);
    };
  }, [board]);

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
          position: "relative",
          zIndex: 20,
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
        {/* 添加会话（从会话区拖拽放入；提示文案） */}
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "4px 10px",
            border: "1px dashed color-mix(in srgb, var(--border) 55%, transparent)",
            background: "var(--glass-bg-input)",
            color: "var(--text-muted)",
            fontSize: 12,
            borderRadius: 7,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ fontSize: 13, lineHeight: 1 }}>＋</span>
          <span>{t("boards.dragToAdd")}</span>
        </span>

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

      {/* tldraw 舞台（接收会话拖入） */}
      <div
        ref={stageRef}
        style={{ flex: 1, minHeight: 0, position: "relative" }}
      >
        {dragOver && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "color-mix(in srgb, var(--accent) 10%, transparent)",
              border: "2px dashed var(--accent)",
              borderRadius: 10,
              pointerEvents: "none",
              color: "var(--accent)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {t("boards.dropToAdd")}
          </div>
        )}
        {/* 展开工作台浮层由 WorkbenchOverlay portal 到 document.body，无需挂载点 */}
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
          >
            <TldrawInner>
              <WorkbenchOverlay />
            </TldrawInner>
          </Tldraw>
        )}
      </div>
    </div>
  );
}

/**
 * 包装 useEditor 的子组件必须挂在 <Tldraw> 内部。
 * 这里只渲染 children（WorkbenchOverlay 等需要 useEditor 的组件）。
 */
function TldrawInner({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
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
