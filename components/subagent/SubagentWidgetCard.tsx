"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SubagentInspectReply, SubagentSnapshot, SubagentSnapshotNode } from "@/lib/subagent-widget";
import { dispatchInspectReply, invokeSubagentInspect, nextInspectRequestId, subscribeInspectReplies } from "@/lib/extension-command";
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
  const tool = node.activity?.currentTool;
  const tokens = node.activity?.turnCount !== undefined || node.activity?.toolCount !== undefined;

  return (
    <div style={{ paddingLeft: depth * 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: "3px 0" }}>
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
        {tool && (
          <span
            style={{
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              minWidth: 0,
            }}
          >
            ⎿ {tool}
          </span>
        )}
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
        {(node.state === "running" || node.state === "complete" || node.state === "failed" || node.state === "partial") && (
          <button
            type="button"
            onClick={() => onInspect(node)}
            disabled={inspecting}
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              padding: "1px 7px",
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: inspecting ? "default" : "pointer",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
            }}
          >
            {inspecting ? "…" : t("chat.extensionInspect")}
          </button>
        )}
      </div>
      {node.children?.map((child) => (
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
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [inspectingNode, setInspectingNode] = useState<SubagentSnapshotNode | null>(null);
  const [inspectReply, setInspectReply] = useState<SubagentInspectReply | null>(null);
  const pendingRequestRef = useRef<{ requestId: string; nodeId: string } | null>(null);

  const runs = snapshot.runs;
  const runningCount = runs.filter((r) => r.state === "running" || r.state === "queued").length;
  const doneCount = runs.filter((r) => r.state === "complete").length;
  const failedCount = runs.filter((r) => r.state === "failed" || r.state === "rejected").length;

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
      <div
        className="subagent-widget-card"
        style={{
          border: "1px solid var(--bubble-border)",
          borderRadius: "var(--bubble-inner-radius)",
          background: "var(--bubble-tool-bg)",
          backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))",
          fontSize: 12,
          overflow: "hidden",
          minWidth: 220,
          maxWidth: "100%",
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "6px 10px",
            background: "none",
            border: "none",
            color: "var(--text-meta)",
            cursor: "pointer",
            fontSize: 12,
            textAlign: "left",
          }}
        >
          <span style={{ color: "var(--text-meta)", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 11, flexShrink: 0 }}>
            subagents
          </span>
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {runs.length} runs · {runningCount} running · {doneCount} done{failedCount > 0 ? ` · ${failedCount} failed` : ""}
          </span>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {expanded && (
          <div style={{ borderTop: "1px solid var(--bubble-hairline)", padding: "6px 10px 8px" }}>
            {runs.map((node) => (
              <NodeRow key={node.id} node={node} depth={0} onInspect={handleInspect} inspecting={inspectingNode?.id === node.id} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
