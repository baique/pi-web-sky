"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { AnimatedDropdown } from "./AnimatedDropdown";

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

interface WorktreeSelectorProps {
  /** 用于解析 worktree 列表的当前有效 cwd（项目根或任一 worktree 路径均可） */
  cwd: string;
  /** 切换/新建成功后回调（父级更新 activeCwd / newSessionCwd） */
  onSelect?: (wtPath: string) => void;
  /** 触发按钮外壳样式覆盖（欢迎页玻璃 / 任务卡侧边栏紧凑各自传入） */
  style?: CSSProperties;
  /** 分支名文字样式覆盖 */
  labelStyle?: CSSProperties;
  /** 下拉开关状态上抛（父级用于 hover 门控挂载时避免卸载导致面板消失） */
  onOpenChange?: (open: boolean) => void;
}

const branchIcon = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <line x1="6" y1="3" x2="6" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

/**
 * 可复用 worktree 选择器：触发按钮 + 下拉（列表/过滤/新建/删除+force 确认）。
 * 从 SessionSidebar 文件 tab 原实现抽取；切换/新建成功后回调 onSelect，
 * 由父级更新全局有效 cwd（activeCwd / newSessionCwd）。不服务会话中切换
 * （会话 cwd 落盘即锁定，任务卡 #16）。
 */
export function WorktreeSelector({ cwd, onSelect, style, labelStyle, onOpenChange }: WorktreeSelectorProps) {
  const { t } = useI18n();
  const [state, setState] = useState<WorktreeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [homeDir, setHomeDir] = useState("");
  const [open, setOpen] = useState(false);
  const [triggerHovered, setTriggerHovered] = useState(false);
  const [filter, setFilter] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);
  /** 下拉面板 fixed 定位（portal 到 body，避免被滚动容器 overflow 裁剪） */
  const [panelPos, setPanelPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  // 加载 worktree 列表（cwd 变化时重新加载）
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cwd || loadedForRef.current === cwd) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setLoading(false);
        if (d.error || !d.projectRoot) {
          setState(null);
          return;
        }
        setState({
          forCwd: cwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? "",
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
        loadedForRef.current = cwd;
      })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd]);

  // 当前选中的 worktree：优先精确匹配 cwd，其次服务端解析路径，最后主 worktree
  const currentWorktree = state
    ? state.worktrees.find((w) => w.path === cwd)
      ?? (state.forCwd === cwd && state.currentWorktreePath
        ? state.worktrees.find((w) => w.path === state.currentWorktreePath)
        : undefined)
      ?? state.worktrees.find((w) => w.isMain)
    : undefined;

  const openDropdown = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 展开方向启发式：下方空间不足 320px 时向上（面板 maxHeight ≈ 300）
    const spaceBelow = window.innerHeight - rect.bottom;
    const up = spaceBelow < Math.min(320, rect.top);
    setPanelPos({ left: rect.left, top: up ? rect.top : rect.bottom, width: rect.width, up });
    setOpen(true);
  }, []);

  // 下拉开关状态统一上抛：父级（任务行 hover 门控）据此保持挂载，避免面板 portal 到 body 后移出触发卸载
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  const handleSelect = useCallback((path: string) => {
    setOpen(false);
    setError(null);
    setFilter("");
    onSelect?.(path);
  }, [onSelect]);

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || busy || !state) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewOpen(false);
      setNewBranch("");
      // Optimistically register the new worktree so the parent project
      // identity resolves before any refetch lands.
      setState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      handleSelect(data.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newBranch, busy, state, handleSelect]);

  const handleRemove = useCallback(async (path: string, force: boolean) => {
    if (!state || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setConfirmRemove(path);
          return;
        }
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setConfirmRemove(null);
      setState((prev) => prev ? { ...prev, worktrees: prev.worktrees.filter((w) => w.path !== path) } : prev);
      // 删的是当前 worktree → 回主工作区
      if (currentWorktree?.path === path) handleSelect(state.projectRoot);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [state, busy, currentWorktree?.path, handleSelect]);

  // Close dropdowns on outside click（面板已 portal 到 body，需单独检查）
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      const inside = rootRef.current?.contains(t) || panelRef.current?.contains(t);
      if (inside) return;
      setOpen(false);
      setNewOpen(false);
      setNewBranch("");
      setError(null);
      setConfirmRemove(null);
      setFilter("");
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const showFilter = (state?.worktrees.length ?? 0) >= 8;
  const visibleWorktrees = showFilter && filter.trim()
    ? (state?.worktrees ?? []).filter((w) =>
        (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(filter.trim().toLowerCase()))
    : (state?.worktrees ?? []);
  const currentPath = currentWorktree?.path ?? null;
  // 门禁（H2）：非 git 目录或 repo 子目录不提供 worktree 切换——
  // 旧侧栏语义：非 git 只提示、子目录会话保持自身项目身份（切到根 checkout 会误改归属）。
  const gated = state !== null && !(state.isGit && state.isTopLevel);
  const gateHint = gated
    ? state!.isGit
      ? "当前为仓库子目录，子目录会话保持自身项目身份"
      : "该目录不是 git 仓库，worktree 切换不可用"
    : null;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        onClick={gated ? undefined : openDropdown}
        title={gated ? (gateHint ?? undefined) : (currentWorktree ? currentWorktree.path : t("sidebar.switchWorktree"))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 28,
          boxSizing: "border-box",
          padding: "0 10px",
          background: open ? "var(--side-active)" : triggerHovered ? "var(--side-hover)" : "transparent",
          border: "none",
          borderRadius: 5,
          cursor: gated ? "default" : "pointer",
          fontSize: 11,
          lineHeight: 1.35,
          color: "var(--text-muted)",
          textAlign: "left",
          transition: "background 0.12s",
          ...style,
        }}
        onMouseEnter={() => setTriggerHovered(true)}
        onMouseLeave={() => setTriggerHovered(false)}
      >
        {branchIcon}
        <PathLabel
          text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : loading ? "…" : t("sidebar.worktrees")}
          style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)", ...labelStyle }}
        />
        {currentWorktree?.isMain && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
        )}
        {!gated && (state?.worktrees.length ?? 0) > 1 && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
            {state!.worktrees.length}
          </span>
        )}
        {!gated && (
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        )}
      </button>

      {panelPos && createPortal(
        <div ref={panelRef} style={{ position: "fixed", left: panelPos.left, top: panelPos.top, width: panelPos.width, zIndex: 100 }}>
        <AnimatedDropdown
          open={open}
          up={panelPos.up}
          style={{
            position: "absolute",
            top: panelPos.up ? "auto" : 4,
            bottom: panelPos.up ? "calc(100% + 4px)" : "auto",
            left: 0,
            right: 0,
            minWidth: 220,
            background: "var(--popover-glass)",
            backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
            WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
            border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
            overflow: "hidden",
          }}
        >
        {showFilter && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  setOpen(false);
                }
              }}
              placeholder={t("sidebar.filterWorktrees")}
              autoFocus
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                borderRadius: 5,
                outline: "none",
                background: "var(--side-input)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
          {visibleWorktrees.map((wt) => {
            const isCurrent = wt.path === currentPath;
            if (confirmRemove === wt.path) {
              return (
                <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("sidebar.forceRemoveCheckout")}
                  </span>
                  <button
                    onClick={() => void handleRemove(wt.path, true)}
                    disabled={busy}
                    style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                  >
                    {t("sidebar.force")}
                  </button>
                  <button
                    onClick={() => setConfirmRemove(null)}
                    style={{ padding: "3px 9px", background: "transparent", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                  >
                    {t("sidebar.cancel")}
                  </button>
                </div>
              );
            }
            return (
              <div
                key={wt.path}
                style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
              >
                <button
                  onClick={() => handleSelect(wt.path)}
                  title={wt.path}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 10px",
                    background: "transparent",
                    border: "none",
                    color: isCurrent ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {isCurrent ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polyline points="1.5 5 4 7.5 8.5 2.5" />
                    </svg>
                  ) : (
                    <span style={{ width: 10, flexShrink: 0 }} />
                  )}
                  <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                  {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                </button>
                {!wt.isMain && (
                  <button
                    onClick={() => void handleRemove(wt.path, false)}
                    disabled={busy}
                    title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 34, height: 28, padding: 0, marginRight: 4,
                      background: "none", border: "none",
                      color: "var(--text-dim)", cursor: "pointer",
                      borderRadius: 5, flexShrink: 0,
                      transition: "color 0.12s, background 0.12s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
          {showFilter && visibleWorktrees.length === 0 && filter.trim() && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
          )}
        </div>

        {!newOpen ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setNewOpen(true);
              setError(null);
              setTimeout(() => newInputRef.current?.focus(), 0);
            }}
            title={t("sidebar.createWorktreeTitle")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
            <span>{t("sidebar.newWorktree")}</span>
          </button>
        ) : (
          <div style={{ padding: "6px 8px" }}>
            <input
              ref={newInputRef}
              value={newBranch}
              onChange={(e) => {
                setNewBranch(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
                if (e.key === "Escape") {
                  setNewOpen(false);
                  setNewBranch("");
                  setError(null);
                }
              }}
              placeholder={t("sidebar.branchName")}
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--accent)",
                borderRadius: 5,
                outline: "none",
                background: "var(--side-input)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
              <button
                onClick={() => void handleCreate()}
                disabled={busy || !newBranch.trim()}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 5,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: busy || !newBranch.trim() ? "not-allowed" : "pointer",
                  opacity: busy || !newBranch.trim() ? 0.65 : 1,
                }}
              >
                {busy ? t("sidebar.creating") : t("sidebar.create")}
              </button>
              <button
                onClick={() => { setNewOpen(false); setNewBranch(""); setError(null); }}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {t("sidebar.cancel")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <div style={{
            padding: "5px 10px 8px",
            color: "#dc2626",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}>
            {error}
          </div>
        )}
        </AnimatedDropdown>
        </div>,
        document.body,
      )}
    </div>
  );
}
