"use client";

import "tldraw/tldraw.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tldraw, DefaultToolbar, DefaultToolbarContent, createShapeId, defaultShapeUtils, type TLComponents, type TLUiOverrides } from "tldraw";
import { SessionCardUtil } from "./SessionCardShape";
import { StickyNoteUtil } from "./StickyNoteShape";
import { StickyNoteTool } from "./StickyNoteTool";
import { useI18n } from "@/hooks/useI18n";
import type { UseBoardCanvasReturn } from "@/hooks/useBoardCanvas";
import type { SessionInfo } from "@/lib/types";

// 自定义 shape util：会话卡 + 自研 markdown 便笺（sticky-note）。
const shapeUtils = [...defaultShapeUtils, SessionCardUtil, StickyNoteUtil];

// useTools() 是硬编码列表（不含自定义工具），内置 note 工具的 onDragStart 会直接创建 type:"note"。
// 这里用 UI overrides 把 note 工具换成我们的：
// - onSelect → setCurrentTool("note")（编辑器里的 note 已被 StickyNoteTool 替换为 sticky-note）
// - onDragStart → 直接创建 sticky-note（避免拖拽出内置便笺）
const uiOverrides: TLUiOverrides[] = [{
  tools(editor, tools) {
    const note = tools["note"];
    if (!note) return tools;
    return {
      ...tools,
      note: {
        ...note,
        onSelect(source) {
          editor.setCurrentTool("note");
          (note as { onSelect?: (s: unknown) => void }).onSelect?.(source);
        },
        onDragStart(source, info) {
          // 拖拽从工具栏创建我们的 sticky-note；不要调原始 onDragStart（它会再建一个内置 note，导致两个控件）
          const { x, y } = editor.inputs.getCurrentPagePoint();
          const id = createShapeId();
          const mark = editor.markHistoryStoppingPoint("drag sticky-note");
          editor.createShape({ id, type: "sticky-note", x, y });
          const shape = editor.getShape(id);
          if (!shape) { editor.setCurrentTool("select.idle"); return; }
          const bounds = editor.getShapePageBounds(id);
          const w = bounds?.w ?? 260;
          const h = bounds?.h ?? 200;
          editor.updateShape({ id, type: "sticky-note", x: x - w / 2, y: y - h / 2 });
          editor.select(id);
          editor.setCurrentTool("select.translating", {
            ...info, target: "shape", shape, isCreating: true, creatingMarkId: mark,
            onCreate() { editor.setCurrentTool("select.idle"); editor.select(id); },
          });
        },
      },
    };
  },
}];

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
    SharePanel: null,
    MenuPanel: null,
    TopPanel: null,
    KeyboardShortcutsDialog: null,
    DebugPanel: null,
    DebugMenu: null,
    // 底部工具条：保留 tldraw 默认工具（note 按钮经 uiOverrides 换成我们的 sticky-note）
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
            - 背景用 --board-scrim-bg（rgba(0,0,0,alpha)，透明度滑块驱动）
            - 磨砂用 --board-scrim-filter：由 wallpaper-settings 计算，
              磨砂为 0 时置 none（避免 saturate 残留仍去饱和背景）
            玻璃只挂这一层，卡片/工具条各自玻璃不在此重复叠 backdrop-filter。 */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            pointerEvents: "none",
            background: "var(--board-scrim-bg)",
            backdropFilter: "var(--board-scrim-filter, none)",
            WebkitBackdropFilter: "var(--board-scrim-filter, none)",
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
            tools={[StickyNoteTool]}
            overrides={uiOverrides}
            onMount={(editor) => {
              // 开启内置拖放吸附对齐（对齐线/中点/边缘），不影响展示效果
              editor.user.updateUserPreferences({ isSnapMode: true });
              board.onMount(editor);
            }}
            components={components}
            autoFocus={false}
            colorScheme={isDark ? "dark" : "light"}
          />
        )}
      </div>
    </div>
  );
}

