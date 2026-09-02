"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { NodeResizer, Handle, Position, type NodeProps } from "@xyflow/react";
import { SessionWorkbench } from "@/components/canvas/SessionWorkbench";
import { CARD_W, CARD_H } from "@/hooks/useBoardCanvas";
import type { CanvasPhase, SessionCardData } from "@/hooks/useBoardCanvas";
import { useCardGlass } from "@/hooks/useCardGlass";
import { useBoardCanvasOps } from "./BoardCanvasContext";
import { dispatchBoardSessionRenamed } from "@/lib/board-events";
import { HIGHLIGHT_SHADOW, useBoardSearch } from "@/components/canvas/BoardSearchContext";
import { CardKindBadge } from "@/components/canvas/CardKindBadge";
import { useNodePosition } from "./nodePosition";

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

export function SessionCardNode({ id, data, selected, width, height }: NodeProps & { data: SessionCardData }) {
  const { updateNode, deleteNode } = useBoardCanvasOps();
  const { highlightId } = useBoardSearch();
  const isHighlighted = highlightId === id;
  const w = width ?? data.w ?? CARD_W;
  const h = height ?? data.h ?? CARD_H;
  const expanded = Boolean(data.expanded);
  const { title, projectName, messageCount, phase, runningMs, endedAt, lastActivityAt, stale, sessionId, lastReply, cwd, taskId } = data;
  const isNewSession = Boolean(cwd);
  const position = useNodePosition(id);
  const { setContainer, setNode } = useCardGlass("var(--board-card-glass)");
  useEffect(() => { setNode(position ? { id, position, data, type: "session-card", style: { width: w, height: h } } as never : null); /* eslint-disable-line */ });

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
    // 尺寸通过 style 同步（RF 用 style 控制节点大小）
    updateNode(id, { style: { width: next.w, height: next.h } });
  };

  // resize：写回 style + data.w/h（NodeResizer 已改 style，这里同步 data）
  const onResize = useCallback((_: unknown, params: { width: number; height: number }) => {
    updateNode(id, { data: { ...data, w: params.width, h: params.height } });
  }, [id, data, updateNode]);

  // 新会话卡转正：清 cwd 字段（写 Y.Doc → CRDT 广播）
  const handlePromote = useCallback(() => {
    updateNode(id, { data: { ...data, cwd: "", taskId: "" } });
  }, [id, data, updateNode]);

  const meta = phaseMeta[phase] ?? phaseMeta.idle;

  // 收合态滚轮内部滚动（RF 的 nowheel 类已处理，这里不需要额外监听）

  return (
    <div
      ref={setContainer}
      data-board-node
      data-testid={`session-card-${sessionId}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: expanded ? 18 : 14,
        border: isHighlighted ? "2px solid var(--accent)" : `1px solid ${stale ? "color-mix(in srgb, var(--border) 80%, transparent)" : "color-mix(in srgb, var(--border) 60%, transparent)"}`,
        background: "transparent",
        boxShadow: isHighlighted ? HIGHLIGHT_SHADOW : "0 2px 12px -6px rgba(0,0,0,0.18)",
        animation: isHighlighted ? "board-search-glow 1.8s ease-out forwards" : undefined,
        opacity: stale ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        color: "var(--text)",
        userSelect: "none",
        padding: expanded ? 8 : "8px 10px 6px",
        cursor: expanded ? "default" : "grab",
        overflow: expanded ? "visible" : "hidden",
      }}
    >
      {/* resize 手柄（两态最小尺寸） */}
      <NodeResizer
        isVisible={selected}
        minWidth={expanded ? 600 : CARD_W}
        minHeight={expanded ? 500 : CARD_H}
        onResize={onResize}
        keepAspectRatio={false}
        lineStyle={{ borderColor: "var(--accent)" }}
        handleStyle={{ background: "var(--accent)", borderColor: "var(--accent)" }}
      />

      {/* 连线 Handle：exec/依赖线端点（左侧 target / 右侧 source） */}
      <Handle type="target" position={Position.Left} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />
      <Handle type="source" position={Position.Right} className="board-handle" style={{ background: "var(--text-dim)", width: 8, height: 8, border: "1px solid var(--bg-panel)", opacity: 0.85 }} />

      {/* 标题栏 = 拖拽区（不拦 pointer → RF 拖动节点） */}
      <div
        data-session-titlebar
        className={expanded ? "nodrag" : ""}
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
            style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600, padding: "2px 6px", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--side-input)", color: "var(--text)" }}
          />
        ) : (
          <span style={{ fontSize: expanded ? 12.5 : 12.5, fontWeight: 600, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
            {isNewSession ? "New session" : (title || "Untitled")}
          </span>
        )}
        {!isNewSession && !renaming && (
          <button type="button" onClick={startRename} title="Rename" aria-label="Rename" className="nodrag" style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, padding: 0, border: "none", borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer", opacity: 0.65 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          </button>
        )}
        {stale && (
          <span style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)", border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)", borderRadius: 4, padding: "0 4px" }}>stale</span>
        )}
        <div style={{ flex: 1 }} />
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
        <div style={{ flex: 1, minHeight: 0, padding: "0 4px 0", pointerEvents: "all", overflow: "visible" }}>
          <SessionWorkbench sessionId={sessionId} cwd={cwd} taskId={taskId} onPromote={handlePromote} />
        </div>
      ) : (
        <>
          {/* 中间区：最后回复 */}
          <div
            ref={replyScrollRef}
            className="nowheel nodrag"
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", gap: 2, overflowY: "auto", overflowX: "hidden", padding: "2px 2px 2px 0", scrollbarWidth: "thin", scrollbarColor: "color-mix(in srgb, var(--border) 70%, transparent) transparent", userSelect: "text" }}
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
