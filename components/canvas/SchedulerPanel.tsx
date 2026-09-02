"use client";

/**
 * 看板右上角调度器状态面板（独立浮层，画布核心不动）。
 *
 * 数据全局（不分看板）：后端 /api/task-scheduler/status 返回调度器真实运行态。
 * 折叠态：小胶囊显示状态点 + 「调度器」+ 工作中摘要（正在派发/审核 或 运行中 N / 待审核 N）。
 * 展开态（向左下方展开）：派发/审查两态（工作中/休眠）、当前进行中任务、任务队列计数。
 * 点击「当前进行中」的任务：若该任务卡就在当前画布 → 平移居中 + accent 高亮（复用
 * setViewport + setHighlight）；不在当前画布则禁用（任务全局，卡片散在不同看板）。
 *
 * 轮询 2.5s（与 running 快照同频）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardSearch } from "./BoardSearchContext";

/** 与 lib/task-scheduler.ts 对齐（避免引 server 模块进 client bundle） */
interface RunningCard {
  id: string;
  boardId: string;
  number: number;
  name: string;
  execStatus: string;
}

interface SchedulerStatus {
  started: boolean;
  running: RunningCard[];
  lastAction: { type: string; cardNumber?: number; cardName?: string; at: number };
  activity: { kind: "dispatch" | "resume" | "review" | "blockcheck"; cardNumber?: number; cardName?: string; at: number } | null;
  queue: {
    dispatchable: number;
    running: number;
    review: number;
    waitingReply: number;
    failed: number;
  };
}

const POLL_MS = 2500;

/** activity.kind → 工作中副文案 */
const ACTIVITY_LABEL: Record<string, string> = {
  dispatch: "正在派发",
  resume: "续会话",
  review: "AI 审核中",
  blockcheck: "阻塞巡检",
};

/** 折叠态「此刻在忙」摘要 */
function workingSummary(s: SchedulerStatus): string | null {
  if (s.activity) return ACTIVITY_LABEL[s.activity.kind] ?? "工作中";
  if (s.running.length > 0) return `运行中 ${s.running.length}`;
  if (s.queue.review > 0) return `待审核 ${s.queue.review}`;
  return null;
}

export function SchedulerPanel({ nodes }: {
  /** 当前画布节点（用于把全局 running 任务映射成本画布 nodeId） */
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>;
}) {
  const { setViewport, getViewport, getNodes } = useReactFlow();
  const { setHighlight } = useBoardSearch();
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 轮询调度器状态（工作中/休眠 + 队列）—— 数据全局，任何看板一致
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/task-scheduler/status", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { status: SchedulerStatus };
        if (!cancelled) setStatus(d.status);
      } catch { /* 静默 */ }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 当前画布内 running 任务卡：cardId → nodeId（供点击定位）
  const nodeIdByCardId = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const d = n.data as { cardId?: string; execStatus?: string };
      if (d.cardId && d.execStatus === "running") m.set(d.cardId, n.id);
    }
    return m;
  }, [nodes]);

  /** 定位到本画布任务卡（若在） */
  const locate = (nodeId: string) => {
    const node = (getNodes() as Array<{ id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; style?: { width?: number; height?: number } }>).find((n) => n.id === nodeId);
    if (!node) return;
    const w = node.measured?.width ?? node.style?.width ?? 380;
    const h = node.measured?.height ?? node.style?.height ?? 270;
    const cx = node.position.x + w / 2;
    const cy = node.position.y + h / 2;
    const vp = getViewport();
    setViewport({ x: -cx * vp.zoom + window.innerWidth / 2, y: -cy * vp.zoom + window.innerHeight / 2, zoom: vp.zoom }, { duration: 300 });
    setHighlight(nodeId);
  };

  const s = status;
  const busy = Boolean(s?.activity);
  const running = s?.running ?? [];
  const queue = s?.queue;
  const summary = s ? workingSummary(s) : null;

  return (
    <div
      ref={rootRef}
      style={{ position: "absolute", top: 12, right: 12, zIndex: 40, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="调度器状态"
        title="调度器状态（数据全局，不分看板）"
        style={{
          display: "flex", alignItems: "center", gap: 7, height: 36,
          padding: "0 6px 0 14px", borderRadius: 999,
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 2px 12px -6px rgba(0,0,0,0.18)",
          color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap",
        }}
      >
        {/* 状态点：工作中=橙（脉冲）；仅任务在跑=绿；空闲=灰 */}
        <span
          aria-hidden
          style={{
            width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
            background: busy ? "#f59e0b" : running.length > 0 ? "#10b981" : "var(--text-dim)",
            boxShadow: busy ? "0 0 6px 1px rgba(245,158,11,0.6)" : running.length > 0 ? "0 0 6px 1px rgba(16,185,129,0.5)" : "none",
            animation: busy ? "pulse 1.6s ease-in-out infinite" : undefined,
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>调度器</span>
        {s?.started === false && <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>未启动</span>}
        {summary && <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{summary}</span>}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div style={{
          display: "flex", flexDirection: "column",
          marginTop: 6, padding: "8px 0", width: 320,
          borderRadius: 14,
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 8px 30px -8px rgba(0,0,0,0.3)",
          color: "var(--text)",
        }}>
          <div style={{ padding: "2px 14px 8px", borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>调度器</span>
            <span style={{ fontSize: 10.5, color: "var(--text-dim)" }}>全局 · 不分看板</span>
          </div>

          {/* 派发 / 审查 两态（工作中 / 休眠） */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "10px 12px 8px" }}>
            <StateCell label="派发" active={s?.activity?.kind === "dispatch" || s?.activity?.kind === "resume"} activityLabel={s?.activity && (s.activity.kind === "dispatch" || s.activity.kind === "resume") ? ACTIVITY_LABEL[s.activity.kind] : undefined} />
            <StateCell label="审查" active={s?.activity?.kind === "review" || s?.activity?.kind === "blockcheck"} activityLabel={s?.activity && (s.activity.kind === "review" || s.activity.kind === "blockcheck") ? ACTIVITY_LABEL[s.activity.kind] : undefined} />
          </div>

          {/* 当前进行中的任务（全局 running，可点定位到本画布任务卡） */}
          <div style={{ padding: "0 14px 8px" }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-meta)", letterSpacing: 0.3, marginBottom: 5 }}>当前进行中</div>
            {running.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 2px 4px" }}>无</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {running.slice(0, 6).map((c) => {
                  const nodeId = nodeIdByCardId.get(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { if (nodeId) locate(nodeId); }}
                      disabled={!nodeId}
                      title={nodeId ? "点击定位到本看板任务卡" : "该任务在当前画布无对应卡片（其它看板/未渲染）"}
                      style={{
                        display: "flex", alignItems: "center", gap: 7, width: "100%",
                        padding: "4px 6px", border: "none", borderRadius: 6,
                        background: "transparent", color: "var(--text)", fontSize: 12,
                        textAlign: "left", cursor: nodeId ? "pointer" : "default",
                        opacity: nodeId ? 1 : 0.55,
                      }}
                    >
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
                      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{c.number} {c.name}</span>
                    </button>
                  );
                })}
                {running.length > 6 && (
                  <div style={{ padding: "3px 6px 0", fontSize: 10.5, color: "var(--text-dim)" }}>…共 {running.length} 个</div>
                )}
              </div>
            )}
          </div>

          {/* 任务队列 */}
          {queue && (
            <div style={{ padding: "8px 14px 10px", borderTop: "1px solid color-mix(in srgb, var(--border) 50%, transparent)" }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-meta)", letterSpacing: 0.3, marginBottom: 6 }}>任务队列</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 5 }}>
                <QueueChip label="待派发" value={queue.dispatchable} />
                <QueueChip label="运行中" value={queue.running} accent />
                <QueueChip label="待审核" value={queue.review} warn />
                <QueueChip label="等回复" value={queue.waitingReply} />
                <QueueChip label="失败" value={queue.failed} danger />
              </div>
            </div>
          )}

          {!s && (
            <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 派发/审查单格：label + 状态点 + 工作中副文案 */
function StateCell({ label, active, activityLabel }: { label: string; active: boolean; activityLabel?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "7px 8px", borderRadius: 8,
      border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
      background: active ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
    }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: active ? "#f59e0b" : "var(--text-dim)", boxShadow: active ? "0 0 6px 1px rgba(245,158,11,0.6)" : "none", animation: active ? "pulse 1.6s ease-in-out infinite" : undefined }} />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>{label}</span>
        <span style={{ fontSize: 10, color: active ? "var(--text-muted)" : "var(--text-dim)", whiteSpace: "nowrap" }}>
          {activityLabel ?? "休眠"}
        </span>
      </div>
    </div>
  );
}

/** 队列小计数块 */
function QueueChip({ label, value, accent, warn, danger }: { label: string; value: number; accent?: boolean; warn?: boolean; danger?: boolean }) {
  const color = accent ? "#10b981" : warn ? "#f59e0b" : danger ? "#ef4444" : "var(--text-muted)";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "5px 0", borderRadius: 8, background: "color-mix(in srgb, var(--border) 22%, transparent)" }}>
      <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.1, color: value > 0 ? color : "var(--text-dim)" }}>{value}</span>
      <span style={{ fontSize: 9.5, color: "var(--text-meta)" }}>{label}</span>
    </div>
  );
}
