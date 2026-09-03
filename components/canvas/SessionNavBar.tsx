"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { TodoItem } from "@/lib/types";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { SessionStatsSummary } from "@/components/SessionStatsSummary";

/**
 * 卡片顶部导航条（会话内部 UI，看板工作台专用）。
 *
 * 入口复用主界面同款组件/样式语言，数据经 ChatWindow 回调捕获：
 * - 历史：新标签页打开会话导出页（同 AppShell handleViewFullHistory）
 * - 统计：浮层展示 SessionStatsInfo（精简版 session-info popover 样式）
 * - TODO：浮层展示 pi-todo.state（与 AppShell todo 面板同渲染逻辑）
 */
export interface SessionNavBarHandle {
  /** 打开统计弹层（供 /session 命令等外部触发） */
  openStats: () => void;
}

export const SessionNavBar = forwardRef<SessionNavBarHandle, {
  sessionId: string;
  stats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  todos: TodoItem[];
}>(function SessionNavBar({
  sessionId,
  stats,
  contextUsage,
  todos,
}, ref) {
  const { t } = useI18n();
  const [statsOpen, setStatsOpen] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);
  const navRef = useRef<HTMLDivElement>(null);
  const statsBtnRef = useRef<HTMLButtonElement | null>(null);
  const todoBtnRef = useRef<HTMLButtonElement | null>(null);

  // /session 等外部触发打开统计弹层
  useImperativeHandle(ref, () => ({
    openStats: () => { setStatsOpen(true); setTodoOpen(false); },
  }), []);

  // 打开一个弹层时收起其他；target="none" 全部关闭
  const openOne = (target: "stats" | "todo" | "none") => {
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

  // 统计按钮文案：拿到模型上下文占用（percent）+ 上下文长度（contextWindow）时，
  // 把「统计」二字换成实时占用摘要（如 42% / 1.0M），否则保持「统计」。（同 AppShell 顶栏）
  const statsLabel = contextUsage?.contextWindow && contextUsage.percent !== null
    ? `${contextUsage.percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
    : t("nav.stats");

  const activeTodoCount = todos.filter((todo) => todo.status !== "completed").length;

  // 弹层宽度 = 标题栏可视宽：弹层展开在标题栏下方，与标题同宽同左。
  // 注：标题栏是卡片外壳内、工作台上方的元素；卡片外壳含 padding 8 左右 + 边框，比标题栏宽（会超宽）。
  // 宽度必须用 getBoundingClientRect（屏幕可视宽，已含画布 zoom 缩放），不能用 clientWidth（布局宽）——
  // 面板 portal 到 body 不受画布 zoom，用布局宽会在 zoom≠1 时比标题栏宽（超宽）或窄。
  const getPanelWidth = useCallback(() => {
    const tb = navRef.current?.closest("[data-session-titlebar]");
    return tb?.getBoundingClientRect().width ?? 300;
  }, []);

  // 空白处点击 / Escape 关闭所有弹层（与 AppShell 顶栏行为一致）
  const anyOpen = statsOpen || todoOpen;
  useEffect(() => {
    if (!anyOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // 点击弹层内部不关闭（弹层已 portal 到 body，需用各自 panel ref）
      if (target instanceof Node) {
        const inNav = navRef.current?.contains(target);
        // 在导航条内点击：按钮自身 toggle 管理，不在此关闭（避免关开竞争）
        if (inNav) return;
        // portal 弹层内的点击不关闭
        if (document.querySelector('[data-session-nav-popover]')?.contains(target)) return;
        if (document.querySelector('[data-session-nav-todo]')?.contains(target)) return;
        if (document.querySelector('.glass-top-panel')?.contains(target)) return;
      }
      setStatsOpen(false);
      setTodoOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setStatsOpen(false);
      setTodoOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anyOpen]);

  return (
    <div
      ref={navRef}
      style={{
        // 融入卡片标题栏：不设高度/背景/border（标题栏已提供玻璃与分隔线）
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "0 4px",
        position: "relative",
        pointerEvents: "all",
        height: "100%",
      }}
    >
      {/* 历史：新标签页打开完整会话导出 */}
      <button
        type="button"
        onClick={handleFullHistory}
        title={t("history.full")}
        aria-label={t("history.full")}
        style={navBtnStyle}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = navBgHover; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
        <span style={navBtnText}>{t("history.full")}</span>
      </button>

      <span style={navDivider} />

      {/* 统计 */}
      <button
        ref={statsBtnRef}
        type="button"
        onClick={() => openOne(statsOpen ? "none" : "stats")}
        title={t("session.title")}
        aria-label={t("session.title")}
        aria-expanded={statsOpen}
        style={{
          ...navBtnStyle,
          background: statsOpen ? navBgActive : "transparent",
          color: statsOpen ? "var(--accent)" : "var(--text-muted)",
        }}
        onMouseEnter={(e) => { if (!statsOpen) { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = navBgHover; } }}
        onMouseLeave={(e) => { if (!statsOpen) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; } }}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="20" x2="12" y2="10" />
          <line x1="18" y1="20" x2="18" y2="4" />
          <line x1="6" y1="20" x2="6" y2="16" />
        </svg>
        <span style={navBtnText}>{statsLabel}</span>
      </button>

      {/* TODO */}
      {todos.length > 0 && (
        <button
          ref={todoBtnRef}
          type="button"
          onClick={() => openOne(todoOpen ? "none" : "todo")}
          title={t("todo.title")}
          aria-label={t("todo.title")}
          aria-expanded={todoOpen}
          style={{
            ...navBtnStyle,
            background: todoOpen ? navBgActive : "transparent",
            color: todoOpen ? "var(--accent)" : "var(--text-muted)",
          }}
          onMouseEnter={(e) => { if (!todoOpen) { e.currentTarget.style.color = "var(--text)"; e.currentTarget.style.background = navBgHover; } }}
          onMouseLeave={(e) => { if (!todoOpen) { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "transparent"; } }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M8 9h8M8 13h5" />
          </svg>
          <span style={navBtnText}>{t("nav.todo")}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>{activeTodoCount > 0 ? activeTodoCount : "✓"}</span>
        </button>
      )}

      {statsOpen && stats && (
        <StatsPopover navRef={navRef} navWidth={getPanelWidth()} stats={stats} contextUsage={contextUsage} onClose={() => setStatsOpen(false)} />
      )}
      {todoOpen && todos.length > 0 && (
        <TodoPopover navRef={navRef} navWidth={getPanelWidth()} todos={todos} onClose={() => setTodoOpen(false)} />
      )}
    </div>
  );
});

const navBtnStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 4,
  width: "auto",
  height: 26,
  padding: "0 6px",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "color 0.12s, background 0.12s",
};

/** 顶栏菜单按钮文字标签（图标 + 短文案） */
const navBtnText: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  whiteSpace: "nowrap",
};

/** 顶栏菜单按钮之间的竖直分隔线 */
const navDivider: React.CSSProperties = {
  flexShrink: 0,
  width: 1,
  height: 16,
  alignSelf: "center",
  background: "color-mix(in srgb, var(--border) 70%, transparent)",
  margin: "0 3px",
};

/* 顶栏菜单按钮的玻璃 hover/激活底色：引玻璃 token，不写死 rgba，自动跟随主题与减弱透明降级。
   chrome 层按钮浮在卡片玻璃上，用半透明玻璃提亮，而非实底 bg-selected。 */
const navBgHover = "color-mix(in srgb, var(--glass-bg-strong) 40%, transparent)";
const navBgActive = "color-mix(in srgb, var(--glass-bg-strong) 60%, transparent)";

/** token 数紧凑格式化：1M / 12k / 345（与 AppShell 顶栏统计按钮同规约） */
function formatCompact(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(0)}k`
      : String(n);
}

/** 统计浮层：复用 AppShell session-info popover 的样式语言，展示卡片内可得的 SessionStatsInfo */
function StatsPopover({
  navRef,
  navWidth,
  stats,
  contextUsage,
  onClose,
}: {
  navRef: React.RefObject<HTMLDivElement | null>;
  navWidth: number;
  stats: SessionStatsInfo;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const nav = navRef.current;
      if (!nav) return;
      const r = nav.getBoundingClientRect();
      // 面板与标题栏同宽同左（展开在标题栏下方）：left = 标题栏左缘，top = 标题栏底（紧贴）
      const tb = nav.closest("[data-session-titlebar]") as HTMLElement | null;
      const tbRect = tb?.getBoundingClientRect();
      const width = navWidth;
      const left = tbRect ? tbRect.left : Math.min(r.right - width, Math.max(8, r.left));
      const top = tbRect ? tbRect.bottom : r.bottom;
      setPos({ top, left });
    };
    update();
    const ro = new ResizeObserver(update);
    if (navRef.current) ro.observe(navRef.current);
    if (navRef.current?.closest("[data-session-titlebar]")) ro.observe(navRef.current.closest("[data-session-titlebar]") as Element);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [navRef, navWidth]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (navRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [navRef, onClose]);

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

  const popoverEl = (
    <div
      ref={panelRef}
      data-session-nav-popover
      role="dialog"
      aria-label={t("session.title")}
      className="glass-panel"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: navWidth,
        maxHeight: "min(560px, calc(100dvh - 44px))",
        overflowY: "auto",
        zIndex: 1200,
        padding: "12px 16px",
        fontSize: 12,
        lineHeight: 1.5,
        fontFamily: "var(--font-mono)",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
      }}
    >
      <div style={{ display: "grid", gap: 16, fontSize: 12, lineHeight: 1.5, fontFamily: "var(--font-mono)" }}>
        {/* 第一行：会话统计紧凑摘要（in⬆ out⬇ cache↻ cost context），复刻顶栏按钮内容格式 */}
        <SessionStatsSummary stats={stats} contextUsage={contextUsage} />
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

  return createPortal(popoverEl, document.body);
}

/** TODO 浮层：与 AppShell todo 面板同渲染逻辑 */
function TodoPopover({
  navRef,
  navWidth,
  todos,
  onClose,
}: {
  navRef: React.RefObject<HTMLDivElement | null>;
  navWidth: number;
  todos: TodoItem[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      const nav = navRef.current;
      if (!nav) return;
      const r = nav.getBoundingClientRect();
      // 与统计面板一致：宽度 = 标题栏宽，left 锚定标题栏左缘，top = 标题栏底（紧贴）
      const tb = nav.closest("[data-session-titlebar]") as HTMLElement | null;
      const tbRect = tb?.getBoundingClientRect();
      const width = navWidth;
      const left = tbRect ? tbRect.left : Math.min(r.right - width, Math.max(8, r.left));
      const top = tbRect ? tbRect.bottom : r.bottom;
      setPos({ top, left });
    };
    update();
    const ro = new ResizeObserver(update);
    if (navRef.current) ro.observe(navRef.current);
    if (navRef.current?.closest("[data-session-titlebar]")) ro.observe(navRef.current.closest("[data-session-titlebar]") as Element);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [navRef, navWidth]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (navRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [navRef, onClose]);

  if (!pos) return null;

  const popoverEl = (
    <div
      ref={panelRef}
      data-session-nav-todo
      role="menu"
      aria-label={t("todo.title")}
      className="glass-panel"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: navWidth,
        maxHeight: "min(440px, calc(100dvh - 44px))",
        overflowY: "auto",
        zIndex: 1200,
        fontFamily: "inherit",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
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

  return createPortal(popoverEl, document.body);
}
