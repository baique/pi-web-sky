"use client";

/**
 * 画布左下角工具区（替代 RF 默认 Controls，玻璃质感，与左上角标题工具区对照）。
 *
 * - 放大 / 缩小 / fit 视口：调用 RF 原实现（zoomIn / zoomOut / fitView），仅换按钮外观。
 * - 进行中：原在左上角标题工具区（BoardTopbar 的「展开进行中」），此处挪到左下角，
 *   点击后向上展开面板（按钮在底部，面板在上方弹出，箭头向上）；列出运行中 + 工作中
 *   （展开态）的会话卡，点击定位（平移居中 + accent 高亮，与 Ctrl+F 搜索同机制）。
 *
 * 必须在 ReactFlowProvider + BoardSearchProvider + SessionRunningProvider 内渲染
 * （useReactFlow / setHighlight / useSessionRunningContext）。
 */

import { useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardSearch } from "./BoardSearchContext";
import { boardFloatGlass } from "./board-glass";

/** session-card 运行中 phase（useBoardCanvas running 快照写入；waiting_input 视为待用户，不算运行） */
const RUNNING_PHASES = new Set(["waiting_model", "running_tools", "running_command"]);

/** 进行中项：运行中 / 工作中（展开态）的会话卡 */
interface RunningItem {
  nodeId: string;
  label: string;
}

export function BoardControls({
  nodes,
  sessionRunning,
}: {
  /** 当前画布节点（yjs 派生，扫描运行中卡片用） */
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  /** 会话卡运行态镜像（useBoardCanvas 2.5s 轮询维护；yjs data.phase 是旧值，不能用于运行中判定） */
  sessionRunning: Record<string, { phase?: string }>;
}) {
  const { zoomIn, zoomOut, fitView, setViewport, getNodes, getViewport } = useReactFlow();
  const { setHighlight } = useBoardSearch();
  const [queueOpen, setQueueOpen] = useState(false);

  /** 运行中：画面中 phase ∈ 运行中的会话卡（读实时镜像，yjs data.phase 是旧值）。 */
  const runningItems = useMemo<RunningItem[]>(() => {
    const out: RunningItem[] = [];
    for (const n of nodes) {
      if (n.type !== "session-card") continue;
      const d = n.data as { phase?: string; title?: string; sessionId?: string };
      if (!d.sessionId) continue;
      const st = sessionRunning[d.sessionId];
      const phase = st ? st.phase : d.phase;
      const running = phase !== undefined && RUNNING_PHASES.has(phase);
      if (!running) continue;
      const title = (d.title ?? "").trim();
      if (!title) continue;
      out.push({ nodeId: n.id, label: title });
    }
    return out;
  }, [nodes, sessionRunning]);

  /** 工作中：画面中展开态（data.expanded）但未运行中的会话卡（运行中已入上区，去重）。 */
  const expandedItems = useMemo<RunningItem[]>(() => {
    const out: RunningItem[] = [];
    for (const n of nodes) {
      if (n.type !== "session-card") continue;
      const d = n.data as { phase?: string; title?: string; sessionId?: string; expanded?: boolean };
      if (!d.expanded || !d.sessionId) continue;
      const st = sessionRunning[d.sessionId];
      const phase = st ? st.phase : d.phase;
      const running = phase !== undefined && RUNNING_PHASES.has(phase);
      if (running) continue;
      const title = (d.title ?? "").trim();
      if (!title) continue;
      out.push({ nodeId: n.id, label: title });
    }
    return out;
  }, [nodes, sessionRunning]);

  /** 角标总数：运行中 + 工作中 */
  const totalCount = runningItems.length + expandedItems.length;

  /** 定位卡片：节点平移到视口中心（保持缩放）+ accent 高亮描边渐隐（同看板 Ctrl+F） */
  const locate = (nodeId: string) => {
    const node = (getNodes() as Array<{ id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; style?: { width?: number; height?: number } }>).find((n) => n.id === nodeId);
    if (!node) return;
    const w = node.measured?.width ?? node.style?.width ?? 340;
    const h = node.measured?.height ?? node.style?.height ?? 160;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const vp = getViewport();
    setViewport(
      { x: -cx * vp.zoom + window.innerWidth / 2, y: -cy * vp.zoom + window.innerHeight / 2, zoom: vp.zoom },
      { duration: 300 },
    );
    setHighlight(nodeId);
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 6,
      }}
    >
      {/* 进行中面板（按钮在上方展开时显示，向上弹） */}
      {queueOpen && (
        <div
          style={{
            ...boardFloatGlass,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            maxHeight: 300,
            overflowY: "auto",
            padding: 6,
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            boxShadow: "0 -2px 12px -6px rgba(0,0,0,0.18), 0 8px 30px -8px rgba(0,0,0,0.3)",
            color: "var(--text)",
            width: 240,
            whiteSpace: "nowrap",
          }}
        >
          {totalCount === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-muted)" }}>画面中没有运行中或展开的会话</div>
          ) : (
            <>
              {runningItems.length > 0 && (
                <div style={{ padding: "4px 10px 2px", fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.2 }}>
                  运行中 · {runningItems.length}
                </div>
              )}
              {runningItems.map((item) => (
                <button
                  key={item.nodeId}
                  type="button"
                  onClick={() => locate(item.nodeId)}
                  title="点击定位到卡片"
                  style={itemStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span aria-hidden style={{ flexShrink: 0, width: 6, height: 6, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 6px 1px rgba(16,185,129,0.6)", animation: "pulse 1.6s ease-in-out infinite" }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                </button>
              ))}
              {expandedItems.length > 0 && (
                <div style={{ padding: "4px 10px 2px", fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)", letterSpacing: 0.2 }}>
                  工作中 · {expandedItems.length}
                </div>
              )}
              {expandedItems.map((item) => (
                <button
                  key={item.nodeId}
                  type="button"
                  onClick={() => locate(item.nodeId)}
                  title="点击定位到卡片"
                  style={itemStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, transparent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                >
                  <span aria-hidden style={{ flexShrink: 0, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 6px 1px color-mix(in srgb, var(--accent) 45%, transparent)" }} />
                  <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}

      {/* 横排玻璃胶囊工具条（与左上角标题工具区对称） */}
      <div
        style={{
          ...boardFloatGlass,
          display: "flex",
          flexDirection: "row",
          gap: 2,
          padding: 4,
          borderRadius: 12,
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
          color: "var(--text)",
          width: "fit-content",
        }}
      >
        {/* 放大 */}
        <button type="button" onClick={() => zoomIn({ duration: 150 })} title="放大" aria-label="放大" style={ctrlBtnStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M8 11h6" /><path d="M11 8v6" /></svg>
        </button>
        {/* 缩小 */}
        <button type="button" onClick={() => zoomOut({ duration: 150 })} title="缩小" aria-label="缩小" style={ctrlBtnStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /><path d="M8 11h6" /></svg>
        </button>
        {/* fit 视口 */}
        <button type="button" onClick={() => fitView({ padding: 0.2, duration: 300 })} title="适配视口" aria-label="适配视口" style={ctrlBtnStyle} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M21 8V5a2 2 0 0 0-2-2h-3" /><path d="M3 16v3a2 2 0 0 0 2 2h3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
        </button>
        {/* 分隔线 */}
        <div style={{ width: 1, alignSelf: "stretch", background: "color-mix(in srgb, var(--border) 70%, transparent)", margin: "2px 1px" }} />
        {/* 进行中：点击向上展开面板（箭头朝上） */}
        <button
          type="button"
          onClick={() => setQueueOpen((v) => !v)}
          title={queueOpen ? "收起进行中" : "展开进行中"}
          aria-label={queueOpen ? "收起进行中" : "展开进行中"}
          aria-expanded={queueOpen}
          style={{
            ...ctrlBtnStyle,
            color: queueOpen ? "var(--accent)" : "var(--text-muted)",
            background: queueOpen ? "color-mix(in srgb, var(--accent) 12%, transparent)" : undefined,
          }}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: queueOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
          {totalCount > 0 && (
            <span style={{
              position: "absolute", top: -2, right: -2,
              minWidth: 14, height: 14, padding: "0 3px", boxSizing: "border-box",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              borderRadius: 999, fontSize: 9, fontWeight: 700, lineHeight: 1,
              background: "color-mix(in srgb, var(--accent) 18%, transparent)",
              color: "var(--accent)",
              border: "1px solid color-mix(in srgb, var(--border) 40%, transparent)",
            }}>{totalCount}</span>
          )}
        </button>
      </div>
    </div>
  );
}

const ctrlBtnStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  width: 34,
  height: 30,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  borderRadius: 8,
  transition: "background 0.12s, color 0.12s",
};

function hoverIn(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = "color-mix(in srgb, var(--text) 8%, transparent)";
  e.currentTarget.style.color = "var(--text)";
}
function hoverOut(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = "transparent";
  e.currentTarget.style.color = "var(--text-muted)";
}

const itemStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%",
  padding: "6px 10px", border: "none", borderRadius: 8,
  background: "transparent", color: "var(--text)", fontSize: 12.5,
  textAlign: "left", cursor: "pointer",
};
