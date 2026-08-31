"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatedDropdown } from "@/components/AnimatedDropdown";

/**
 * 工作区选择器（worktree picker）：交互参照文件树下方（SessionSidebar）的选择器——
 * 触发按钮显示当前选中（分支/主 checkout），下拉列全部工作区 + 手动新建输入。
 * 供任务卡表单「工作区」字段使用；数据走 /api/worktrees（GET 列表 / POST 新建）。
 */

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

export function WorktreePicker({
  cwd,
  value,
  onChange,
}: {
  /** 当前选中目录（决定加载哪个项目的 worktrees） */
  cwd: string | null;
  /** 当前选中的工作区路径（外部联动 cwd 时同步传入） */
  value: string | null;
  /** 选择 / 新建工作区后的回调（外部联动 cwd） */
  onChange: (path: string) => void;
}) {
  const [state, setState] = useState<WorktreeState | null>(null);
  const [open, setOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  // 加载 cwd 所在项目的 worktrees（git 项目才有列表；非 git 置空）
  useEffect(() => {
    const c = cwd;
    if (!c) {
      setState(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/worktrees?cwd=${encodeURIComponent(c)}`, { cache: "no-store" });
        if (!res.ok) return;
        const d = (await res.json()) as {
          projectRoot?: string;
          isGit?: boolean;
          currentWorktreePath?: string | null;
          worktrees?: Array<{ path: string; branch?: string | null; isMain?: boolean }>;
        };
        if (cancelled) return;
        setState({
          forCwd: c,
          projectRoot: d.projectRoot ?? c,
          isGit: d.isGit ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: (d.worktrees ?? []).map((w) => ({ path: w.path, branch: w.branch ?? null, isMain: Boolean(w.isMain) })),
        });
      } catch {
        if (!cancelled) setState(null);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  // 当前选中项：外部 value → cwd 所在工作区 → 服务端 currentWorktreePath → 主 checkout
  const current =
    state?.worktrees.find((w) => w.path === value) ??
    state?.worktrees.find((w) => w.path === cwd) ??
    (state?.currentWorktreePath ? state.worktrees.find((w) => w.path === state.currentWorktreePath) : undefined) ??
    state?.worktrees.find((w) => w.isMain) ??
    null;

  // 手动新建工作区：POST /api/worktrees（在项目根新建分支），成功后联动 cwd
  const create = async () => {
    const b = branch.trim();
    if (!b || busy || !state) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.projectRoot, branch: b }),
      });
      const d = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
      if (!res.ok || !d.path) {
        setErr(d.error ?? "创建失败");
        setBusy(false);
        return;
      }
      setBranch("");
      setNewOpen(false);
      setOpen(false);
      onChange(d.path);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const label = current
    ? (current.isMain ? `主 checkout（${current.branch ?? ""}）` : current.branch ?? current.path)
    : (state?.isGit ? "选择工作区…" : "非 git 项目");

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setErr(null); }}
        style={{
          width: "100%",
          height: 28,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 8px",
          background: open ? "var(--side-active)" : "transparent",
          border: "1px solid var(--border)",
          borderRadius: 5,
          cursor: "pointer",
          fontSize: 11,
          color: "var(--text)",
          textAlign: "left",
          fontFamily: "var(--font-mono)",
        }}
        title={current?.path ?? undefined}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: current && !current.isMain ? "var(--accent)" : "var(--text-dim)" }}>
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>

      <AnimatedDropdown
        open={open}
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          left: 0,
          right: 0,
          zIndex: 120,
          minWidth: 200,
          background: "var(--popover-glass)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          boxShadow: "0 6px 20px -6px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        <div style={{ maxHeight: "min(40vh, 260px)", overflowY: "auto", padding: 4 }}>
          {(state?.worktrees ?? []).length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
              {state?.isGit === false ? "非 git 项目，无法创建工作区" : "暂无工作区"}
            </div>
          ) : (
            (state?.worktrees ?? []).map((wt) => {
              const isCurrent = wt.path === (current?.path ?? value);
              return (
                <button
                  key={wt.path}
                  type="button"
                  onClick={() => {
                    onChange(wt.path);
                    setOpen(false);
                    setErr(null);
                  }}
                  title={wt.path}
                  style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "6px 8px",
                    border: "none",
                    borderRadius: 4,
                    background: isCurrent ? "var(--side-active)" : "transparent",
                    color: "var(--text)",
                    fontSize: 11,
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                  }}
                  onMouseEnter={(e) => { if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "var(--side-hover)"; }}
                  onMouseLeave={(e) => { if (!isCurrent) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
                >
                  <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wt.isMain ? `主 checkout（${wt.branch ?? ""}）` : wt.branch ?? wt.path}
                  </span>
                  <span style={{ display: "block", fontSize: 9.5, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {wt.path}
                  </span>
                </button>
              );
            })
          )}
        </div>
        {/* 手动新建 */}
        {!newOpen ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNewOpen(true);
              setErr(null);
              setTimeout(() => newInputRef.current?.focus(), 0);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "7px 10px",
              background: "none",
              border: "none",
              borderTop: "1px solid var(--bubble-hairline)",
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
            <span>新建工作区</span>
          </button>
        ) : (
          <div style={{ padding: "6px 8px", borderTop: "1px solid var(--bubble-hairline)" }}>
            <input
              ref={newInputRef}
              value={branch}
              onChange={(e) => { setBranch(e.target.value); setErr(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void create(); }
                if (e.key === "Escape") { setNewOpen(false); setBranch(""); setErr(null); }
              }}
              placeholder="新分支名"
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
                type="button"
                onClick={() => void create()}
                disabled={busy || !branch.trim()}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 5,
                  color: "var(--accent-contrast, #fff)",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: busy || !branch.trim() ? "not-allowed" : "pointer",
                  opacity: busy || !branch.trim() ? 0.65 : 1,
                }}
              >
                {busy ? "创建中…" : "创建"}
              </button>
              <button
                type="button"
                onClick={() => { setNewOpen(false); setBranch(""); setErr(null); }}
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
                取消
              </button>
            </div>
          </div>
        )}
        {err && (
          <div style={{ padding: "5px 10px 8px", color: "#dc2626", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>
            {err}
          </div>
        )}
      </AnimatedDropdown>
    </div>
  );
}
