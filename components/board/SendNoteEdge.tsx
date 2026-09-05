"use client";

/**
 * 发送线（send-note）：便笺/文本节点 → 会话卡的专用连线类型。
 *
 * 线上中点渲染「发送」按钮，点击把便笺/文本内容作为普通消息（plaintext）
 * 发给目标会话（POST /api/agent/[id] { type: "prompt", message }）。
 *
 * 一次性语义（线属性）：点击瞬间把 data.sent=true 写回 yjs（跨端/重复点击
 * 防双发），发送成功后按钮变为「已发送」禁用；失败回滚 sent=false 可重试。
 */

import { useCallback, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useBoardCanvasOps } from "./BoardCanvasContext";

/** 可作为发送源的节点类型（用户内容，均有 data.text） */
export const NOTE_NODE_TYPES = new Set(["sticky-note", "text", "text-node"]);

export function isNoteNode(n: { type?: string } | undefined): boolean {
  return Boolean(n && NOTE_NODE_TYPES.has(n.type ?? ""));
}

export interface SendNoteEdgeData extends Record<string, unknown> {
  /** 标记：便笺→会话发送线（onConnect 建线时写入） */
  sendNote?: boolean;
  /** 已发送（一次性，写回 yjs 持久化 + 多端同步） */
  sent?: boolean;
}

export function SendNoteEdge({ id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const { getNodes } = useReactFlow();
  const { updateEdge } = useBoardCanvasOps();
  const edgeData = data as SendNoteEdgeData | undefined;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const sent = Boolean(edgeData?.sent);
  // 本地发送态（不落库）：busy=请求中，failed=上次失败（可重试）
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const busyRef = useRef(false);

  // 渲染期从 RF store 读端点实时判定可发送性；点击时再取最新文本（不依赖本帧）
  const nodes = getNodes();
  const noteNode = nodes.find((n) => n.id === source && isNoteNode(n)) ?? nodes.find((n) => n.id === target && isNoteNode(n));
  const sessionNode = nodes.find((n) => n.id === target && n.type === "session-card") ?? nodes.find((n) => n.id === source && n.type === "session-card");
  const sessionId = (sessionNode?.data as { sessionId?: string } | undefined)?.sessionId;
  // 新会话卡（cwd 非空 = 会话尚未创建）不能发送
  const isNewSessionCard = Boolean((sessionNode?.data as { cwd?: string } | undefined)?.cwd);
  const text = ((noteNode?.data as { text?: string } | undefined)?.text ?? "").trim();

  const handleSend = useCallback(async () => {
    if (sent || busyRef.current) return;
    const current = getNodes();
    const note = current.find((n) => n.id === source && isNoteNode(n)) ?? current.find((n) => n.id === target && isNoteNode(n));
    const sess = current.find((n) => n.id === target && n.type === "session-card") ?? current.find((n) => n.id === source && n.type === "session-card");
    const sid = (sess?.data as { sessionId?: string } | undefined)?.sessionId;
    const sessData = sess?.data as { cwd?: string } | undefined;
    if (!note || !sess || !sid || sessData?.cwd) return;
    const msg = ((note.data as { text?: string } | undefined)?.text ?? "").trim();
    if (!msg) return;
    busyRef.current = true;
    setBusy(true);
    setFailed(false);
    // 点击即占位（跨端/重复点击防双发），失败再回滚
    updateEdge(id, { data: { sent: true } });
    try {
      await sendAgentCommand(sid, { type: "prompt", message: msg });
    } catch (e) {
      updateEdge(id, { data: { sent: false } });
      setFailed(true);
      console.warn("[board] 发送便笺内容到会话失败:", e instanceof Error ? e.message : e);
    }
    busyRef.current = false;
    setBusy(false);
  }, [id, source, target, sent, updateEdge, getNodes]);

  // 按钮文案 / 禁用 / 提示
  let label = "发送";
  let title = "把便笺内容作为消息发送给该会话";
  let disabled = false;
  if (sent) {
    label = "✓ 已发送";
    title = "已发送（每条连线只发送一次）";
    disabled = true;
  } else if (busy) {
    label = "发送中…";
    disabled = true;
  } else if (failed) {
    label = "重试";
    title = "上次发送失败，点击重试";
  } else if (!text) {
    title = "便笺内容为空，无法发送";
    disabled = true;
  } else if (!sessionId) {
    title = "会话不存在";
    disabled = true;
  } else if (isNewSessionCard) {
    title = "新会话卡尚未创建会话，无法发送";
    disabled = true;
  }

  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
            zIndex: 1000,
          }}
        >
          <button
            type="button"
            onClick={handleSend}
            disabled={disabled}
            title={title}
            data-testid={`send-note-${id}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 10px",
              borderRadius: 999,
              border: disabled ? "1px solid color-mix(in srgb, var(--border) 60%, transparent)" : "1px solid color-mix(in srgb, var(--accent) 45%, transparent)",
              background: "var(--board-card-glass)",
              backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
              color: disabled ? "var(--text-dim)" : "var(--accent)",
              fontSize: 11,
              fontWeight: 600,
              cursor: disabled ? "default" : "pointer",
              whiteSpace: "nowrap",
              boxShadow: "0 1px 6px -2px rgba(0,0,0,0.25)",
              userSelect: "none",
            }}
          >
            {label}
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
