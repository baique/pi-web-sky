"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentInspectReply, SubagentSnapshot, SubagentSnapshotNode } from "@/lib/subagent-widget";
import { invokeSubagentInspect, nextInspectRequestId, subscribeInspectReplies } from "@/lib/extension-command";
import { SubagentInspectPanel } from "./SubagentInspectPanel";

const STATE_COLORS: Record<string, string> = {
  running: "#22c55e",
  queued: "#a3a3a3",
  complete: "#22c55e",
  failed: "#f87171",
  partial: "#fbbf24",
  paused: "#fbbf24",
  stopped: "#a3a3a3",
  rejected: "#f87171",
};

const STATE_LABELS: Record<string, string> = {
  running: "running",
  queued: "queued",
  complete: "done",
  failed: "failed",
  partial: "partial",
  paused: "paused",
  stopped: "stopped",
  rejected: "rejected",
};

function formatElapsed(startedAt?: number, endedAt?: number): string {
  if (!startedAt) return "";
  const end = endedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem > 0 ? ` ${rem}s` : ""}`;
}

function StateDot({ state }: { state: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        flexShrink: 0,
        display: "inline-block",
        background: STATE_COLORS[state] ?? "#a3a3a3",
        boxShadow: `0 0 0 3px ${(STATE_COLORS[state] ?? "#a3a3a3")}22`,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * 过滤冗余层级：pi-subagents 快照里每个 run 通常带一个同名同状态的 step 子节点
 * （single 模式的 run 只有一个 step，信息完全重复）。渲染时若某节点的唯一子节点
 * 与它同名且状态一致，就折叠掉子层，避免出现"delegate → delegate"的视觉嵌套。
 */
function isRedundantChild(node: SubagentSnapshotNode): boolean {
  const children = node.children;
  if (!children || children.length !== 1) return false;
  const child = children[0];
  return child.kind === "step"
    && (child.label === node.label || child.label === node.kind)
    && child.state === node.state;
}

function visibleChildren(node: SubagentSnapshotNode): SubagentSnapshotNode[] {
  if (isRedundantChild(node)) return [];
  return node.children ?? [];
}

function NodeRow({
  node,
  depth,
  onInspect,
  inspecting,
}: {
  node: SubagentSnapshotNode;
  depth: number;
  onInspect: (node: SubagentSnapshotNode) => void;
  inspecting: boolean;
}) {
  const { t } = useI18n();
  const label = node.label || node.kind;
  const elapsed = formatElapsed(node.startedAt, node.endedAt);
  const tokens = node.activity?.turnCount !== undefined || node.activity?.toolCount !== undefined;
  const inspectable = node.state === "running" || node.state === "complete" || node.state === "failed" || node.state === "partial";

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div
        onClick={() => inspectable && onInspect(node)}
        title={inspectable ? t("chat.extensionInspect") : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          padding: "3px 0",
          borderRadius: 5,
          cursor: inspectable ? "pointer" : "default",
          ...(inspectable && !inspecting ? { background: "transparent", transition: "background 0.1s" } : {}),
        }}
        onMouseEnter={(e) => { if (inspectable && !inspecting) e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { if (inspectable && !inspecting) e.currentTarget.style.background = "transparent"; }}
      >
        <StateDot state={node.state} />
        <span
          style={{
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {label}
        </span>
        <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0 }}>
          {STATE_LABELS[node.state] ?? node.state}
        </span>
        {elapsed && (
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0 }}>
            {elapsed}
          </span>
        )}
        {tokens && (
          <span style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, flexShrink: 0 }}>
            ⟳ {node.activity?.turnCount ?? 0} {node.activity?.toolCount !== undefined ? `/ ${node.activity.toolCount}t` : ""}
          </span>
        )}
      </div>
      {visibleChildren(node).map((child) => (
        <NodeRow key={child.id} node={child} depth={depth + 1} onInspect={onInspect} inspecting={false} />
      ))}
    </div>
  );
}

export function SubagentWidgetCard({
  snapshot,
  sessionId,
}: {
  snapshot: SubagentSnapshot;
  sessionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inspectingNode, setInspectingNode] = useState<SubagentSnapshotNode | null>(null);
  const [inspectReply, setInspectReply] = useState<SubagentInspectReply | null>(null);
  const pendingRequestRef = useRef<{ requestId: string; nodeId: string } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const runs = snapshot.runs;
  const runningCount = runs.filter((r) => r.state === "running" || r.state === "queued").length;
  const doneCount = runs.filter((r) => r.state === "complete").length;
  const failedCount = runs.filter((r) => r.state === "failed" || r.state === "rejected").length;

  // 点击卡片/面板外部或按 Esc 时收起展开层（对齐 pi-todo 的 outside-close）。
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setExpanded(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpanded(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [expanded]);

  useEffect(() => {
    const unsubscribe = subscribeInspectReplies((reply, requestId) => {
      if (pendingRequestRef.current?.requestId !== requestId) return;
      pendingRequestRef.current = null;
      setInspectReply(reply as SubagentInspectReply);
    });
    return unsubscribe;
  }, []);

  const handleInspect = useCallback((node: SubagentSnapshotNode) => {
    if (!sessionId) return;
    const requestId = nextInspectRequestId();
    pendingRequestRef.current = { requestId, nodeId: node.id };
    setInspectingNode(node);
    setInspectReply(null);
    void invokeSubagentInspect(sessionId, requestId, node.id).catch(() => {
      pendingRequestRef.current = null;
      setInspectingNode(null);
    });
  }, [sessionId]);

  return (
    <>
      {inspectReply && inspectingNode && (
        <SubagentInspectPanel
          reply={inspectReply}
          title={inspectingNode.label || inspectingNode.kind}
          onClose={() => {
            setInspectReply(null);
            setInspectingNode(null);
          }}
        />
      )}
      {/* 嵌入 shelf 的触发块：无边框无背景，与其余 widget 触发块一致；
          右边界线同标准触发块（widget 之间分隔） */}
      <div
        ref={rootRef}
        className={`subagent-widget-card${expanded ? " is-expanded" : ""}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: "100%",
          padding: "0 10px",
          fontSize: 11,
          flex: "0 0 180px",
          width: 180,
          minWidth: 0,
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          borderRight: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
          transition: "color 0.1s, background 0.1s",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "none",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            fontSize: 11,
            textAlign: "left",
            padding: 0,
            minWidth: 0,
          }}
        >
          <span className="extension-widget-placement" aria-hidden="true">
            <svg
              className="extension-widget-placement-icon"
              viewBox="0 0 8 6"
              width="8"
              height="6"
              data-direction="up"
              focusable="false"
            >
              <path d="M4 0l4 6H0z" />
            </svg>
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, flexShrink: 0, fontSize: 11 }}>
            subagents
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, fontSize: 11 }}>
            {runs.length} runs · {runningCount} running · {doneCount} done{failedCount > 0 ? ` · ${failedCount} failed` : ""}
          </span>
        </button>

        {expanded && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: 0,
              width: "100%",
              zIndex: 60,
              border: "1px solid var(--bubble-border)",
              borderRadius: "var(--bubble-inner-radius) var(--bubble-inner-radius) 0 0",
              background: "var(--frame-glass)",
              backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
              padding: "6px 10px 8px",
              maxHeight: "min(40dvh, 320px)",
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            {runs.map((node) => (
              <NodeRow key={node.id} node={node} depth={0} onInspect={handleInspect} inspecting={inspectingNode?.id === node.id} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
