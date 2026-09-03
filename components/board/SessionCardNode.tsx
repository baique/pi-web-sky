"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { computeResizeSnap } from "@/lib/board-align";
import { SessionWorkbench } from "@/components/canvas/SessionWorkbench";
import { CARD_W, CARD_H } from "@/hooks/useBoardCanvas";
import type { CanvasPhase, SessionCardData } from "@/hooks/useBoardCanvas";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { memoBoardNode } from "./memoNode";
import { dispatchBoardSessionRenamed } from "@/lib/board-events";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";

/**
 * 会话卡（RF 节点版，替代 tldraw session-card shape）。
 * - 收合 340×160 ↔ 展开 840×600（data.expanded 切换 + 尺寸切换，两态手动尺寸保留）
 * - 展开态嵌入 SessionWorkbench（ChatWindow 工作台）
 * - resize：NodeResizer（min 尺寸随态）
 * - 改名：内联输入 → PATCH /api/sessions/[id]
 * - 玻璃：useCardGlass 局部贴图
 */

/** 展开工作台默认尺寸 */
const EXPANDED_DEFAULT_W = 840;
const EXPANDED_DEFAULT_H = 600;

const phaseMeta: Record<string, { dot: string; label: string }> = {
  waiting_model: { dot: "var(--accent)", label: "thinking" },
  running_tools: { dot: "#f59e0b", label: "tools" },
  running_command: { dot: "#f59e0b", label: "command" },
  waiting_input: { dot: "var(--text)", label: "waiting" },
  idle: { dot: "var(--text-dim)", label: "idle" },
  "just-ended": { dot: "#10b981", label: "done" },
};

function SessionCardNodeImpl({ id, data, selected, width, height }: NodeProps & { data: SessionCardData }) {
  const { getNodes } = useReactFlow();
  const { updateNode, deleteNode, setSnapLines } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? data.w ?? CARD_W;
  const h = height ?? data.h ?? CARD_H;
  const expanded = Boolean(data.expanded);
  // 最新 data 镜像：回调（promote/resize）读 ref，不依赖渲染期 data 引用（引用随 yjs 回灌变化 → 回调每帧重建 → 工作台 memo 失效）
  const dataRef = useRef(data);
  dataRef.current = data;
  const { title, projectName, messageCount, phase, runningMs, endedAt, lastActivityAt, stale, sessionId, lastReply, cwd, taskId } = data;
  const isNewSession = Boolean(cwd);
  const { setContainer } = useCardGlass("var(--board-card-glass)");

  // 收合态中间区滚动容器 ref（内部滚动 nowheel 由 RF 隔离）
  const replyScrollRef = useRef<HTMLDivElement | null>(null);

  // 改名
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(title || "");
    setRenaming(true);
    requestAnimationFrame(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); });
  };
  const commitRename = async () => {
    if (!sessionId) return;
    const name = renameValue.trim();
    setRenaming(false);
    if (!name || name === title) return;
    const prevTitle = title;
    updateNode(id, { data: { ...data, title: name } });
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        dispatchBoardSessionRenamed(sessionId, name);
      } else {
        updateNode(id, { data: { ...data, title: prevTitle } });
      }
    } catch {
      updateNode(id, { data: { ...data, title: prevTitle } });
    }
  };
  const cancelRename = () => setRenaming(false);

  // 独立展开/收起：切换 expanded + 尺寸（两态手动尺寸保留）
  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isNewSession) {
      deleteNode(id);
      return;
    }
    const next = nextExpandState(data, w, h);
    updateNode(id, { data: next.data });
    // 尺寸三处对齐：顶层 width/height（NodeResizer 拖过会残留，RF 优先读它）
    // + style（RF 备选）。只改 style 会被顶层残留值屏蔽。
    updateNode(id, { width: next.w, height: next.h, style: { width: next.w, height: next.h } });
  };

  // resize：写回 style + data.w/h + 对齐参考线吸附
  // resizingRef 守卫：停止后 yjs 尺寸回灌可能再触发 onResize，不得再画线（抬起线不消失）
  const resizingRef = useRef(false);
  const onResizeStart = useCallback(() => {
    resizingRef.current = true;
    setSnapLines([]);
  }, [setSnapLines]);
  const onResizeEnd = useCallback(() => {
    resizingRef.current = false;
    setSnapLines([]);
    requestAnimationFrame(() => setSnapLines([]));
  }, [setSnapLines]);
  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    if (!resizingRef.current) return;
    const nodes = getNodes();
    const self = nodes.find((n) => n.id === id);
    const pos = self?.position ?? { x: 0, y: 0 };
    const snap = computeResizeSnap(id, pos, params.width, params.height, nodes);
    setSnapLines(snap.lines);
    const finalW = snap.snapW ?? params.width;
    const finalH = snap.snapH ?? params.height;
    updateNode(id, { data: { ...dataRef.current, w: finalW, h: finalH } });
  }, [id, updateNode, setSnapLines, getNodes]);

  // 新会话卡转正：清 cwd 字段（写 Y.Doc → CRDT 广播）
  const handlePromote = useCallback(() => {
    const d = dataRef.current;
    updateNode(id, { data: { ...d, cwd: "", taskId: "" } });
  }, [id, updateNode]);

  const meta = phaseMeta[phase] ?? phaseMeta.idle;

  // 收合态滚轮内部滚动（RF 的 nowheel 类已处理，这里不需要额外监听）

  return (
    <>
      {/* resize 手柄 + 连线 Handle 挂在卡根外（RF wrapper 直接子级）：
          卡根 overflow:hidden（或展开态 visible）会裁掉/错位外扩的 resize 角柄，
          放外面后手柄可正常外扩/命中。
          直线隐藏（四边直线无法圆角）：选中态边线由卡根圆角 accent 边框呈现。 */}
      <NodeResizer
        isVisible={selected}
        minWidth={expanded ? 600 : CARD_W}
        minHeight={expanded ? 500 : CARD_H}
        onResizeStart={onResizeStart}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
        keepAspectRatio={false}
      />

      {/* 连线 Handle：exec/依赖线端点（左侧 target / 右侧 source） */}
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />

    <div
      ref={setContainer}
      data-board-node
      data-testid={`session-card-${sessionId}`}
      onDoubleClick={toggleExpand}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: expanded ? 18 : 14,
        border: isHighlighted
          ? "2px solid var(--accent)"
          : `1px solid ${stale ? "color-mix(in srgb, var(--border) 80%, transparent)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
        background: "transparent",
        // 选中态：外圈描边用 box-shadow（带 5px 间距、不占布局→不压缩内容区）。边框保持固定 1px。
        boxShadow: selected
          ? "0 0 0 5px transparent, 0 0 16px 5px color-mix(in srgb, var(--accent) 28%, transparent), 0 2px 12px -6px rgba(0,0,0,0.18)"
          : isHighlighted ? HIGHLIGHT_SHADOW : "0 2px 12px -6px rgba(0,0,0,0.18)",
        animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
        opacity: stale ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        color: "var(--text)",
        userSelect: "none",
        padding: expanded ? 8 : "8px 10px 6px",
        // 卡根整卡可拖（左右下边缘留抓手区），内部内容区单独 default
        cursor: "grab",
        overflow: expanded ? "visible" : "hidden",
      }}
    >

      {/* 标题栏 = 恒可拖拽层（展开/收起都保留可拖）：不拦 pointer → RF 拖动节点。
          内部交互（改名输入/按钮/导航槽）各自 nodrag 隔离。 */}
      <div
        data-session-titlebar
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 10px",
          height: expanded ? "calc(36px + env(safe-area-inset-top))" : undefined,
          minHeight: expanded ? undefined : 20,
          borderBottom: expanded ? "1px solid color-mix(in srgb, var(--border) 50%, transparent)" : "none",
          cursor: "grab",
          position: "relative",
          ...(expanded ? {} : { marginBottom: 2 }),
        }}
      >
        <CardKindBadge kind="session" color={meta.dot} />
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void commitRename(); if (e.key === "Escape") cancelRename(); }}
            onBlur={() => void commitRename()}
            className="nodrag"
            style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--side-input)", color: "var(--text)", boxSizing: "border-box" }}
          />
        ) : (
          <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", padding: "2px 6px", border: "1px solid transparent", borderRadius: 5, boxSizing: "border-box" }}>
            {isNewSession ? "New session" : (title || "Untitled")}
          </span>
        )}
        {stale && (
          <span style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 4, padding: "0 4px" }}>stale</span>
        )}
        <div style={{ flex: 1 }} />
        {/* 右侧操作区最左：会话标题编辑（历史按钮左侧） */}
        {!isNewSession && !renaming && (
          <button type="button" onClick={startRename} title="Rename" aria-label="Rename" className="nodrag" style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", opacity: 0.65 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          </button>
        )}
        {/* 导航条 portal 挂载点 */}
        <div data-session-navbar-slot className="nodrag" style={{ display: "flex", alignItems: "center" }} />
        <button
          type="button"
          onClick={toggleExpand}
          className="nodrag"
          title={isNewSession ? "Discard" : expanded ? "Collapse" : "Expand"}
          style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
        >
          {isNewSession ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
          ) : expanded ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          )}
        </button>
      </div>

      {expanded ? (
        // 展开工作台（消息/工具/代码块）必须显式恢复文本选中：卡根 userSelect:none 会抑制整卡选中
        <div className="nodrag" style={{ flex: 1, minHeight: 0, padding: "0 12px 0", pointerEvents: "all", overflow: "visible", cursor: "default", userSelect: "text" }}>
          <SessionWorkbench sessionId={sessionId} cwd={cwd} taskId={taskId} onPromote={handlePromote} />
        </div>
      ) : (
        <>
          {/* 中间区：最后回复 */}
          <div
            ref={replyScrollRef}
            className="nowheel nodrag"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", gap: 2, overflowY: "auto", overflowX: "hidden", padding: "2px 12px 0", scrollbarWidth: "thin", scrollbarColor: "color-mix(in srgb, var(--border) 70%, transparent) transparent", userSelect: "text", cursor: "default" }}
          >
            {lastReply ? (
              <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--text-muted)", wordBreak: "break-word", overflowWrap: "anywhere", whiteSpace: "pre-wrap", maxWidth: "100%", userSelect: "text" }}>
                {lastReply}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--text-dim)" }}>
                {projectName && <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>{projectName}</span>}
                {messageCount > 0 && <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{messageCount} msgs</span>}
              </div>
            )}
          </div>
          {/* 底部时间 */}
          <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--text-dim)", borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", paddingTop: 3 }}>
            <span aria-hidden style={{ flexShrink: 0 }}>🕒</span>
            <span>{formatTime(lastActivityAt)}</span>
            <div style={{ flex: 1 }} />
            {runningMs > 0 && phase !== "idle" && (
              <span style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap", flexShrink: 0 }}>{formatDuration(runningMs)}</span>
            )}
          </div>
        </>
      )}
    </div>
    </>
  );
}

/** 展开/收起尺寸切换（两态手动尺寸保留） */
function nextExpandState(data: SessionCardData, w: number, h: number) {
  if (data.expanded) {
    // 展开 → 收合
    return {
      data: { ...data, expanded: false, expandedW: w, expandedH: h, w: data.collapsedW || CARD_W, h: data.collapsedH || CARD_H },
      w: data.collapsedW || CARD_W,
      h: data.collapsedH || CARD_H,
    };
  }
  // 收合 → 展开
  return {
    data: { ...data, expanded: true, collapsedW: w, collapsedH: h, w: data.expandedW || EXPANDED_DEFAULT_W, h: data.expandedH || EXPANDED_DEFAULT_H },
    w: data.expandedW || EXPANDED_DEFAULT_W,
    h: data.expandedH || EXPANDED_DEFAULT_H,
  };
}

function formatDuration(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const h = Math.floor(min / 60);
  return `${h}h${min % 60}m`;
}

function formatTime(lastActivityAt: number): string {
  if (lastActivityAt <= 0) return "";
  const d = new Date(lastActivityAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** memo 化导出：忽略拖拽/位置类 props 每帧变化，避免拖拽时整卡重渲染 */
export const SessionCardNode = memoBoardNode(SessionCardNodeImpl);
