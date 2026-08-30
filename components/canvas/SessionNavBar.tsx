"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BranchNavigator } from "@/components/BranchNavigator";
import { useI18n } from "@/hooks/useI18n";
import type { SessionTreeNode, TodoItem } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 卡片顶部导航条（会话内部 UI，看板工作台专用）。
 *
 * 四个入口全部复用主界面同款组件/样式语言，数据经 ChatWindow 回调捕获：
 * - 分支：BranchNavigator 原组件（inline + compact）
 * - 历史：新标签页打开会话导出页（同 AppShell handleViewFullHistory）
 * - 统计：浮层展示 SessionStatsInfo（精简版 session-info popover 样式）
 * - TODO：浮层展示 pi-todo.state（与 AppShell todo 面板同渲染逻辑）
 */
export function SessionNavBar({
  sessionId,
  sessionName,
  branchTree,
  branchActiveLeafId,
  onLeafChange,
  stats,
  todos,
}: {
  sessionId: string;
  sessionName?: string;
  branchTree: SessionTreeNode[];
  branchActiveLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  stats: SessionStatsInfo | null;
  todos: TodoItem[];
}) {
  const { t } = useI18n();
  const [branchOpen, setBranchOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const statsBtnRef = useRef<HTMLButtonElement | null>(null);
  const todoBtnRef = useRef<HTMLButtonElement | null>(null);

  // 打开一个弹层时收起其他
  const openOne = (target: "branch" | "stats" | "todo") => {
    setBranchOpen(target === "branch");
    setStatsOpen(target === "stats");
    setTodoOpen(target === "todo");
  };

  const handleFullHistory = useCallback(() => {
    window.open(
      `/api/sessions/${encodeURIComponent(sessionId)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [sessionId]);

  const activeTodoCount = todos.filter((todo) => todo.status !== "completed").length;

  return (
    <div
      ref={navRef}
      style={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "3px 6px",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
        minHeight: 34,
        position: "relative",
      }}
    >
      <BranchNavigator
        tree={branchTree}
        activeLeafId={branchActiveLeafId}
        onLeafChange={onLeafChange}
        inline
        compact
        containerRef={navRef}
        open={branchOpen}
        onToggle={() => openOne("branch")}
        hasSession
      />

      {/* 历史：新标签页打开完整会话导出 */}
      <button
        type="button"
        onClick={handleFullHistory}
        title={t("history.full")}
        aria-label={t("history.full")}
        style={navBtnStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>

      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11.5,
          fontWeight: 600,
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          marginLeft: 4,
        }}
      >
        {sessionName ?? "Untitled"}
      </span>

      {/* 统计 */}
      <button
        ref={statsBtnRef}
        type="button"
        onClick={() => openOne("stats")}
        title={t("session.title")}
        aria-label={t("session.title")}
        aria-expanded={statsOpen}
        style={{
          ...navBtnStyle,
          background: statsOpen ? "var(--bg-selected)" : "transparent",
          color: statsOpen ? "var(--accent)" : "var(--text-muted)",
        }}
        onMouseEnter={(e) => { if (!statsOpen) { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; } }}
        onMouseLeave={(e) => { if (!statsOpen) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; } }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
          <line x1="6" y1="20" x2="6" y2="16" />
        </svg>
      </button>

      {/* TODO */}
      {todos.length > 0 && (
        <button
          ref={todoBtnRef}
          type="button"
          onClick={() => openOne("todo")}
          title={t("todo.title")}
          aria-label={t("todo.title")}
          aria-expanded={todoOpen}
          style={{
            ...navBtnStyle,
            background: todoOpen ? "var(--bg-selected)" : "transparent",
            color: todoOpen ? "var(--accent)" : "var(--text-muted)",
          }}
          onMouseEnter={(e) => { if (!todoOpen) { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = "var(--bg-hover)"; } }}
          onMouseLeave={(e) => { if (!todoOpen) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; } }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M8 9h8M8 13h5" />
          </svg>
          <span style={{ fontSize: 10, fontWeight: 700 }}>{activeTodoCount > 0 ? activeTodoCount : "✓"}</span>
        </button>
      )}

      {statsOpen && stats && (
        <StatsPopover anchorRef={statsBtnRef} stats={stats} onClose={() => setStatsOpen(false)} />
      )}
      {todoOpen && todos.length > 0 && (
        <TodoPopover anchorRef={todoBtnRef} todos={todos} onClose={() => setTodoOpen(false)} />
      )}
    </div>
  );
}

const navBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  width: 26,
  height: 26,
  padding: 0,
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "color 0.12s, background 0.12s",
};

/** 统计浮层：复用 AppShell session-info popover 的样式语言，展示卡片内可得的 SessionStatsInfo */
function StatsPopover({
  anchorRef,
  stats,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  stats: SessionStatsInfo;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const width = 300;
      const left = Math.min(r.right - width, Math.max(8, r.left));
      setPos({ top: r.bottom + 4, left });
    };
    update();
    const ro = new ResizeObserver(update);
    if (anchorRef.current) ro.observe(anchorRef.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchorRef, onClose]);

  if (!pos) return null;

  const formatDuration = (ms: number) => {
    if (ms <= 0) return "0s";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };
  const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
  const totalActiveMs = stats.totalActiveMs ?? 0;

  const sessionRows = [
    ...(stats.sessionName ? [{ label: t("session.name"), value: stats.sessionName }] : []),
    { label: t("session.id"), value: stats.sessionId },
    ...(totalActiveMs > 0 ? [{ label: t("session.totalActive"), value: formatDuration(totalActiveMs) }] : []),
  ];
  const messageRows = [
    [t("session.user"), stats.userMessages.toLocaleString()],
    [t("session.assistant"), stats.assistantMessages.toLocaleString()],
    [t("session.toolCalls"), stats.toolCalls.toLocaleString()],
    [t("session.toolResults"), stats.toolResults.toLocaleString()],
    [t("session.total"), stats.totalMessages.toLocaleString()],
  ];
  const tokenRows = [
    [t("session.input"), stats.tokens.input.toLocaleString()],
    [t("session.output"), stats.tokens.output.toLocaleString()],
    ...(stats.tokens.cacheRead > 0 ? [[t("session.cacheRead"), stats.tokens.cacheRead.toLocaleString()]] : []),
    ...(stats.tokens.cacheWrite > 0 ? [[t("session.cacheWrite"), stats.tokens.cacheWrite.toLocaleString()]] : []),
    [t("session.total"), stats.tokens.total.toLocaleString()],
    ...(stats.cost > 0 ? [[t("session.cost"), `$${stats.cost.toFixed(4)}`]] : []),
    ...(stats.contextUsage?.contextWindow
      ? [[t("session.context"), `${stats.contextUsage.percent !== null ? `${stats.contextUsage.percent.toFixed(1)}%` : "?"} / ${formatCompact(stats.contextUsage.contextWindow)}`]]
      : []),
  ];

  const section = (title: string, rows: string[][], valueAlign: "left" | "right" = "left", compact = false) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
      <div style={{
        display: "grid",
        gridTemplateColumns: compact ? "max-content minmax(0, 1fr)" : "auto minmax(0, 1fr)",
        columnGap: compact ? 14 : 12,
        rowGap: 4,
        justifyContent: compact ? "start" : undefined,
      }}>
        {rows.map(([label, value]) => (
          <div key={`${title}:${label}`} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-meta)", whiteSpace: "nowrap" }}>{label}</div>
            <div style={{
              color: "var(--text-muted)",
              minWidth: 0,
              overflowWrap: "anywhere",
              textAlign: valueAlign,
              whiteSpace: "normal",
            }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("session.title")}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 300,
        maxHeight: "min(560px, calc(100dvh - 44px))",
        overflowY: "auto",
        zIndex: 1200,
        padding: "12px 16px",
        background: "var(--popover-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        borderRadius: 10,
        boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: "var(--font-mono)",
      }}
    >
      <div style={{ display: "grid", gap: 16, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", columnGap: 12, rowGap: 8, alignItems: "start" }}>
          {sessionRows.map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <div style={{ color: "var(--text-meta)", whiteSpace: "nowrap" }}>{row.label}</div>
              <div style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word", whiteSpace: "normal" }}>{row.value}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(160px, 0.5fr) minmax(240px, 0.7fr)", gap: 24 }}>
          {section(t("session.messages"), messageRows)}
          {section(t("session.tokens"), tokenRows, "right", true)}
        </div>
      </div>
    </div>
  );
}

/** TODO 浮层：与 AppShell todo 面板同渲染逻辑 */
function TodoPopover({
  anchorRef,
  todos,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  todos: TodoItem[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const width = 300;
      const left = Math.min(r.right - width, Math.max(8, r.left));
      setPos({ top: r.bottom + 4, left });
    };
    update();
    const ro = new ResizeObserver(update);
    if (anchorRef.current) ro.observe(anchorRef.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchorRef, onClose]);

  if (!pos) return null;

  return (
    <div
      ref={panelRef}
      role="menu"
      aria-label={t("todo.title")}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: 300,
        maxHeight: "min(440px, calc(100dvh - 44px))",
        overflowY: "auto",
        zIndex: 1200,
        background: "var(--popover-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
        borderRadius: 10,
        boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
        fontFamily: "inherit",
      }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "9px 12px",
        borderBottom: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
        fontSize: 12, fontWeight: 650, color: "var(--text)",
      }}>
        {t("todo.title")}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-meta)", fontWeight: 500 }}>
          {todos.filter((todo) => todo.status === "completed").length}/{todos.length} {t("todo.completed")}
        </span>
      </div>
      {todos.length === 0 ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
          {t("todo.empty")}
        </div>
      ) : (
        <div style={{ maxHeight: 330, overflowY: "auto" }}>
          {todos.map((todo) => {
            const done = todo.status === "completed";
            const priorityColor = todo.priority === "high" ? "#ef4444"
              : todo.priority === "medium" ? "rgba(234,179,8,0.9)"
              : "var(--text-meta)";
            return (
              <div
                key={todo.id ?? todo.content}
                style={{
                  display: "flex", alignItems: "flex-start", gap: 8,
                  padding: "7px 12px",
                  borderBottom: "1px solid color-mix(in srgb, var(--border) 45%, transparent)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flexShrink: 0, marginTop: 2,
                    width: 13, height: 13, borderRadius: 4,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 10, fontWeight: 800, lineHeight: 1,
                    color: done ? "#fff" : "transparent",
                    background: done ? "#16a34a" : "color-mix(in srgb, var(--border) 70%, transparent)",
                    border: done ? "none" : "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
                  }}
                >
                  ✓
                </span>
                <span style={{
                  flex: 1, minWidth: 0,
                  fontSize: 12, lineHeight: 1.4,
                  color: done ? "var(--text-meta)" : "var(--text)",
                  textDecoration: done ? "line-through" : "none",
                  wordBreak: "break-word",
                }}>
                  {todo.content}
                </span>
                <span
                  aria-hidden="true"
                  style={{ flexShrink: 0, marginTop: 5, width: 7, height: 7, borderRadius: "50%", background: priorityColor }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
