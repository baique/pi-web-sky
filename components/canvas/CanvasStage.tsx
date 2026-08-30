"use client";

import "tldraw/tldraw.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tldraw, DefaultToolbar, DefaultToolbarContent, defaultShapeUtils, type TLComponents } from "tldraw";
import { SessionCardUtil } from "./SessionCardShape";
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
    // 底部工具条：保留 tldraw 默认工具（清理失效已移入顶部悬浮按钮组）
    Toolbar: () => (
      <DefaultToolbar>
        <DefaultToolbarContent />
      </DefaultToolbar>
    ),
  }), []);

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
      {/* tldraw 舞台（接收会话拖入）。子层：背景透明，玻璃由父层 SessionCanvas 统一提供。 */}
      <div
        ref={stageRef}
        style={{ flex: 1, minHeight: 0, position: "relative" }}
      >
        {/* 画布 scrim：内容层之下、壁纸之上的一层“暗色承托 + 磨砂”底。
            - absolute inset 0 铺满舞台，pointerEvents none 不拦截拖拽/选择
            - 背景用 --board-scrim-bg（暗色 token，明暗主题都保持暗色）
            - 磨砂用 --board-scrim-blur（右上角调节滑块驱动）
            玻璃只挂这一层，卡片/工具条各自玻璃不在此重复叠 backdrop-filter。 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            background: "var(--board-scrim-bg)",
            backdropFilter: "blur(var(--board-scrim-blur)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--board-scrim-blur)) saturate(var(--glass-saturate))",
          }}
        />
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
          />
        )}
      </div>
    </div>
  );
}

