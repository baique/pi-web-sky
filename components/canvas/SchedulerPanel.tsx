"use client";

/**
 * 看板右上角调度器状态面板（独立浮层，画布核心不动）。
 *
 * 数据全局（不分看板）：后端 /api/task-scheduler/status 返回调度器真实运行态。
 * 折叠态：小胶囊显示状态点 + 「调度器」+ 工作中摘要（正在派发/审核 或 运行中 N / 待审核 N）。
 * 展开态（向左下方展开）：派发/审查两态（工作中/休眠）、当前进行中任务、任务队列
 * （各状态下的具体任务卡，点击定位到本看板对应卡；不在本画布则置灰提示）。
 *
 * 轮询 2.5s（与 running 快照同频）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { useBoardSearch } from "./BoardSearchContext";

/** 与 lib/task-scheduler.ts 对齐（避免引 server 模块进 client bundle） */
interface CardBrief {
  id: string;
  boardId: string;
  number: number;
  name: string;
}

interface RunningCard extends CardBrief {
  execStatus: string;
}

interface SchedulerStatus {
  started: boolean;
  /** 本实例是否为唯一调度者（多实例共库时只有 leader 实际调度） */
  leader: boolean;
  running: RunningCard[];
  lastAction: { type: string; cardNumber?: number; cardName?: string; at: number };
  activity: { kind: "dispatch" | "resume" | "review" | "blockcheck"; cardNumber?: number; cardName?: string; at: number } | null;
  queue: {
    dispatchable: CardBrief[];
    review: CardBrief[];
    waitingReply: CardBrief[];
    failed: CardBrief[];
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
  if (s.queue.review.length > 0) return `待审核 ${s.queue.review.length}`;
  return null;
}

export function SchedulerPanel({ nodes }: {
  /** 当前画布节点（用于把全局 running/队列任务映射成本画布 nodeId） */
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>;
}) {
  const { setCenter, getViewport, getNodes } = useReactFlow();
  const { setHighlight } = useBoardSearch();
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 轮询调度器状态（工作中/休眠 + 队列）—— 数据全局，任何看板一致。
  // 链式调度：上一次完成后再排下一次（响应慢自动降频，绝不叠加堆积）。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch("/api/task-scheduler/status", { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as { status: SchedulerStatus };
        if (!cancelled) setStatus(d.status);
      } catch { /* 静默 */ }
    };
    const loop = async () => {
      await load();
      if (!cancelled) timer = setTimeout(loop, POLL_MS);
    };
    void loop();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
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

  // 当前画布内任务卡：cardId → nodeId（供点击定位；只认 execStatus 相关态的在画卡）
  const nodeIdByCardId = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) {
      const d = n.data as { cardId?: string };
      if (d.cardId) m.set(d.cardId, n.id);
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
    // 用 RF 的 setCenter（把指定点移到视口中心，保持缩放），替代手算 setViewport
    void setCenter(cx, cy, { zoom: getViewport().zoom });
    setHighlight(nodeId);
  };

  const s = status;
  const busy = Boolean(s?.activity);
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
        title="调度器状态"
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
            background: busy ? "#f59e0b" : (s?.running.length ?? 0) > 0 ? "#10b981" : "var(--text-dim)",
            boxShadow: busy ? "0 0 6px 1px rgba(245,158,11,0.6)" : (s?.running.length ?? 0) > 0 ? "0 0 6px 1px rgba(16,185,129,0.5)" : "none",
            animation: busy ? "pulse 1.6s ease-in-out infinite" : undefined,
          }}
        />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>调度器</span>
        {s?.started === false && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>未启动</span>}
        {s?.started === true && s?.leader === false && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>跟随</span>}
        {summary && <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{summary}</span>}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div style={{
          display: "flex", flexDirection: "column",
          marginTop: 6, padding: "8px 0", width: 340,
          borderRadius: 14,
          background: "var(--board-card-glass)",
          backdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          WebkitBackdropFilter: "blur(var(--board-blur)) saturate(var(--glass-saturate))",
          border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
          boxShadow: "0 8px 30px -8px rgba(0,0,0,0.3)",
          color: "var(--text)",
        }}>
          <div style={{ padding: "2px 14px 8px", borderBottom: "1px solid color-mix(in srgb, var(--border) 50%, transparent)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>调度器</span>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              {s?.started === false ? "未启动" : s?.started === true && s?.leader === false ? "跟随（非调度者）" : busy ? "工作中" : "休眠"}
            </span>
          </div>

          {/* 派发 / 审查 两态（工作中 / 休眠） */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, padding: "10px 12px 8px" }}>
            <StateCell label="派发" active={s?.activity?.kind === "dispatch" || s?.activity?.kind === "resume"} activityLabel={s?.activity && (s.activity.kind === "dispatch" || s.activity.kind === "resume") ? ACTIVITY_LABEL[s.activity.kind] : undefined} />
            <StateCell label="审查" active={s?.activity?.kind === "review" || s?.activity?.kind === "blockcheck"} activityLabel={s?.activity && (s.activity.kind === "review" || s.activity.kind === "blockcheck") ? ACTIVITY_LABEL[s.activity.kind] : undefined} />
          </div>

          {/* 任务队列：分组列出具体任务，可点击定位本画布卡 */}
          {s && (
            <QueueGroup
              title="任务队列"
              groups={[
                { label: "运行中", color: "#10b981", cards: s.running },
                { label: "待审核", color: "#f59e0b", cards: s.queue.review },
                { label: "待派发", color: "var(--accent)", cards: s.queue.dispatchable },
                { label: "等回复", color: "var(--text-muted)", cards: s.queue.waitingReply },
                { label: "失败", color: "#ef4444", cards: s.queue.failed },
              ]}
              nodeIdByCardId={nodeIdByCardId}
              onLocate={locate}
            />
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
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", lineHeight: 1.2 }}>{label}</span>
        <span style={{ fontSize: 10, fontWeight: 600, color: active ? "var(--text-muted)" : "var(--text-muted)", whiteSpace: "nowrap" }}>
          {activityLabel ?? "休眠"}
        </span>
      </div>
    </div>
  );
}

/** 队列分组：组标题 + 组内任务列表（每项可点定位） */
function QueueGroup({ title, groups, nodeIdByCardId, onLocate }: {
  title: string;
  groups: Array<{ label: string; color: string; cards: CardBrief[] }>;
  nodeIdByCardId: Map<string, string>;
  onLocate: (nodeId: string) => void;
}) {
  const nonEmpty = groups.filter((g) => g.cards.length > 0);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);

  return (
    <div style={{ padding: "8px 12px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px 4px" }}>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: 0.3 }}>{title}</span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-dim)" }}>共 {total}</span>
      </div>
      {nonEmpty.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "2px 2px 6px" }}>队列空闲</div>
      ) : (
        nonEmpty.map((g) => (
          <div key={g.label} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 2px 3px" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: g.color, flexShrink: 0 }} />
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-muted)" }}>{g.label}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{g.cards.length}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {g.cards.slice(0, 4).map((c) => {
                const nodeId = nodeIdByCardId.get(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { if (nodeId) onLocate(nodeId); }}
                    disabled={!nodeId}
                    title={nodeId ? "点击定位到本看板任务卡" : "该任务不在当前看板"}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%",
                      padding: "4px 6px", border: "none", borderRadius: 6,
                      background: "transparent", color: "var(--text)", fontSize: 12,
                      textAlign: "left", cursor: nodeId ? "pointer" : "default",
                      opacity: nodeId ? 1 : 0.55,
                    }}
                  >
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>#{c.number}</span> {c.name}
                    </span>
                    {!nodeId && <span style={{ flexShrink: 0, fontSize: 9.5, color: "var(--text-dim)" }}>其它看板</span>}
                  </button>
                );
              })}
              {g.cards.length > 4 && (
                <div style={{ padding: "2px 6px", fontSize: 10, color: "var(--text-dim)" }}>…共 {g.cards.length} 个</div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
