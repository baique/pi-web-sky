"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { useI18n } from "@/hooks/useI18n";
import { AnimatedDropdown } from "./AnimatedDropdown";
import { dropdownDirection } from "@/lib/dropdown-direction";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionTabs, type SidebarTab } from "./SessionTabs";
import { BoardSection } from "./canvas/BoardSection";
import { TaskArea, TASK_SESSION_PREVIEW_LIMIT, type TaskGroupUi } from "./TaskArea";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--side-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  /** 左上角「刷新」按钮：触发父级全量刷新（会话/任务/看板同源信号 refreshKey） */
  onRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone.
   *  completedIds：本次判定的后台完成会话 id 列表（供上层过滤已由看板侧播过完成音的会话）。 */
  onBackgroundTaskDone?: (completedIds?: string[]) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  /** A session should be spawned pre-assigned to this task (task row "+").
   *  projectKey lets the parent attach the new session to the task reliably
   *  even before the session has a real id / project identity (transient). */
  onNewSessionFromTask?: (taskId: string, projectKey?: string) => void;
  /** 进入看板模式（主区域替换为画布） */
  onOpenBoard?: (boardId: string) => void;
  /** 点任务行 → 打开该任务的看板（任务即看板）。 */
  onOpenTaskBoard?: (taskId: string) => void;
  /** 当前激活看板 id（看板模式下高亮） */
  activeBoardId?: string | null;
  /** 全局运行中会话数（系统看板徽标） */
  runningBoardCount?: number;
}

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

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
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



interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, onRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onNewSessionFromTask, onOpenBoard, onOpenTaskBoard, activeBoardId, runningBoardCount = 0 }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [cwdHovered, setCwdHovered] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState("");
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtTriggerHovered, setWtTriggerHovered] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  // 视图持久化状态：初始值固定为 SSR 默认。localStorage 仅客户端存在——
  // 若在 useState 初始化时读取，服务端默认值与客户端持久化值不一致会触发
  // hydration mismatch；用户偏好由下方 mount effect 统一恢复。
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("sessions");
  const [boardsCollapsed, setBoardsCollapsed] = useState(false);
  const [tasksCollapsed, setTasksCollapsed] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [tasks, setTasks] = useState<TaskGroupUi[]>([]);
  const [tempDragOver, setTempDragOver] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // 挂载后恢复上次持久化的侧边栏视图状态（tab/折叠/unread 标记）。
  // 此时 hydration 已完成，setState 走正常客户端更新，不再产生不匹配。
  useEffect(() => {
    setSidebarTab(loadSidebarTab());
    setBoardsCollapsed(loadCollapsedFlag(BOARDS_COLLAPSED_KEY));
    setTasksCollapsed(loadCollapsedFlag(TASKS_COLLAPSED_KEY));
    setChatCollapsed(loadCollapsedFlag(TEMP_COLLAPSED_KEY));
    setUnreadSessionIds(loadUnreadSessionIds());
    // 仅挂载时恢复一次（setState 为稳定引用，无需依赖）
  }, []);
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  // Snapshot of the refreshKey at mount. The mount effect — including StrictMode's
  // dev-only immediate replay — must never pass force: a second force=1 right
  // after mount invalidates the server cache and starts a second full session
  // scan, doubling the slow listing path on every page open. Only a later
  // refreshKey change (session created/ended/deleted) requests force.
  const initialRefreshKeyRef = useRef(refreshKey);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, refreshKey !== initialRefreshKeyRef.current);
  }, [loadSessions, refreshKey]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        // 相等性判断：内容没变化就不 setState（否则每 2.5s 轮询都新建 Set 触发重渲染，
        // 运行中会话条目在拖拽中被重挂 → 浏览器取消 drag）。
        setRunningSessionIds((prev) => {
          const next = new Set(data.runningSessionIds ?? []);
          if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev;
          return next;
        });
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedInBackground.length > 0) {
      onBackgroundTaskDone?.(completedInBackground);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setCustomPathValue("");
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathValue("");
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((project) => project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectFor(selectedCwd);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const filteredSessions = selectedProject
    ? sessionsForProject(allSessions, selectedProject.key)
    : allSessions;
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // Build parent-child tree within the filtered set
  const sessionTree = buildSessionTree(filteredSessions);

  // ---- Task groups (per-project) ----
  useEffect(() => {
    const key = selectedProject?.key;
    if (!key) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/tasks?projectKey=${encodeURIComponent(key)}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ tasks?: TaskGroupUi[] }>) : null))
      .then((d) => {
        if (!cancelled) setTasks(Array.isArray(d?.tasks) ? d.tasks : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedProject?.key, refreshKey]);

  const persistTasks = useCallback(async (): Promise<void> => {
    const key = selectedProject?.key;
    if (!key) return;
    const res = await fetch(`/api/tasks?projectKey=${encodeURIComponent(key)}`, { cache: "no-store" });
    const d = (await res.json().catch(() => ({}))) as { tasks?: TaskGroupUi[] };
    setTasks(Array.isArray(d.tasks) ? d.tasks : []);
  }, [selectedProject?.key]);

  // Pin / unpin a session inside its region (task group or chat). Optimistic:
  // reorder immediately, persist in the background — no full re-scan.
  const handleToggleSessionPin = useCallback((sessionId: string, nextPinned: boolean) => {
    setAllSessions((prev) => prev.map((s) => (
      s.id === sessionId ? { ...s, pinned: nextPinned ? true : undefined } : s
    )));
    // If the session belongs to a task, move it to the pinned head of that
    // task's sessionIds immediately (same order the server would return).
    setTasks((prev) => prev.map((t) => {
      if (!t.sessionIds.includes(sessionId)) return t;
      const pinnedSet = new Set(t.pinnedSessionIds ?? []);
      if (nextPinned) pinnedSet.add(sessionId); else pinnedSet.delete(sessionId);
      const pinned = new Set(t.sessionIds.filter((id) => pinnedSet.has(id)));
      const rest = t.sessionIds.filter((id) => !pinnedSet.has(id));
      return { ...t, pinnedSessionIds: [...pinnedSet], sessionIds: [...pinned, ...rest] };
    }));
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: nextPinned }),
    })
      .catch(() => {})
      .then(() => persistTasks());
  }, [persistTasks]);

  // Pin / unpin a task in the tasks region. Optimistic: flip + reorder
  // pinned-first immediately, persist in the background.
  const handleToggleTaskPin = useCallback((taskId: string) => {
    const task = tasks.find((x) => x.id === taskId);
    if (!task) return;
    const nextPinned = !task.pinned;
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === taskId ? { ...t, pinned: nextPinned } : t));
      return [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)];
    });
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: nextPinned }),
    })
      .catch(() => {})
      .then(() => persistTasks());
  }, [tasks, persistTasks]);

  // Reorder tasks within one pinned region. `orderedIds` is the full new
  // order of ALL tasks (as reported by TaskArea after a same-region drag);
  // we split it by the tasks' current pinned state and persist each region
  // separately — a drag can never move a task across regions.
  const handleReorderTasks = useCallback((orderedIds: string[]) => {
    const key = selectedProject?.key;
    if (!key) return;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pinned: string[] = [];
    const unpinned: string[] = [];
    for (const id of orderedIds) {
      const task = byId.get(id);
      if (!task) continue;
      (task.pinned ? pinned : unpinned).push(id);
    }
    // Optimistic: apply the new order locally immediately.
    setTasks((prev) => {
      const order = new Map(orderedIds.map((id, i) => [id, i]));
      return [...prev].sort((a, b) => {
        const ia = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const ib = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        // pinned 段永远在非置顶段前（跨区不可能，但防御性保持）。
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return ia - ib;
      });
    });
    // Persist each region separately (order within a region is what matters).
    if (pinned.length > 0) {
      void fetch("/api/tasks/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: key, orderedIds: pinned }),
      }).catch(() => {});
    }
    if (unpinned.length > 0) {
      void fetch("/api/tasks/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: key, orderedIds: unpinned }),
      }).catch(() => {});
    }
  }, [tasks, selectedProject?.key]);

  // 改名成功：乐观更新本地 name，立即生效。不触发 loadSessions——
  // 服务端列表扫描直接带名字，但刷新有 1-2s 延迟；本地先改，避免等。
  const handleSessionRenamed = useCallback((sessionId: string, newName: string) => {
    setAllSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, name: newName } : s)));
  }, []);

  // 看板内会话改名 → 乐观更新左侧树（与上方 handleSessionRenamed 同路径，
  // 事件桥从画布卡片广播过来；AppShell 另会 setRefreshKey 兜底全量刷新）
  useEffect(() => {
    const onBoardRenamed = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; name?: string }>).detail;
      if (!detail?.sessionId || !detail?.name) return;
      handleSessionRenamed(detail.sessionId, detail.name);
    };
    window.addEventListener("pi-web:board-session-renamed", onBoardRenamed);
    return () => window.removeEventListener("pi-web:board-session-renamed", onBoardRenamed);
  }, [handleSessionRenamed]);

  // 看板内删除会话（画布删卡）→ 走 onSessionDeleted（AppShell handleSessionDeleted：
  // 刷新左侧树 + 当前选中会话清理），与侧栏删除同路径
  useEffect(() => {
    const onBoardDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string }>).detail;
      if (!detail?.sessionId) return;
      onSessionDeleted?.(detail.sessionId);
    };
    window.addEventListener("pi-web:board-session-deleted", onBoardDeleted);
    return () => window.removeEventListener("pi-web:board-session-deleted", onBoardDeleted);
  }, [onSessionDeleted]);

  const handleCreateTask = useCallback(async (name: string) => {
    const key = selectedProject?.key;
    if (!key) return;
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectKey: key, name }),
    });
    await persistTasks();
  }, [selectedProject?.key, persistTasks]);

  const handleRenameTask = useCallback(async (taskId: string, name: string) => {
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await persistTasks();
  }, [persistTasks]);

  const handleDeleteTask = useCallback(async (taskId: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    const d = await res.json().catch(() => ({})) as { deletedSessionIds?: string[] };
    // 任务删除连带删除了会话文件：对每个被删会话同步状态（含当前激活会话的清空）。
    for (const sid of d.deletedSessionIds ?? []) onSessionDeleted?.(sid);
    await persistTasks();
  }, [persistTasks, onSessionDeleted]);

  const handleAssignSession = useCallback(async (taskId: string, sessionId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.sessionIds.includes(sessionId)) return;
    await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: [...task.sessionIds, sessionId] }),
    });
    await persistTasks();
  }, [tasks, persistTasks]);

  const handleUnassignSession = useCallback(async (sessionId: string) => {
    const task = tasks.find((t) => t.sessionIds.includes(sessionId));
    if (!task) return;
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionIds: task.sessionIds.filter((s) => s !== sessionId) }),
    });
    await persistTasks();
  }, [tasks, persistTasks]);

  // Region-internal order: pinned segment first, then the rest — both sorted
  // by the session's last-modified time (desc). Pinning never changes position
  // within a segment; it only relocates the entry to the pinned segment
  // (hairline-divided), exactly like the chat region. Sorting happens here in
  // the client so the server never double-sorts with a different key.
  function orderPinnedFirst(nodes: SessionTreeNode[]): SessionTreeNode[] {
    const byModified = (a: SessionTreeNode, b: SessionTreeNode) =>
      a.session.modified < b.session.modified
        ? 1
        : a.session.modified > b.session.modified
          ? -1
          : 0;
    return [
      ...nodes.filter((n) => n.session.pinned).sort(byModified),
      ...nodes.filter((n) => !n.session.pinned).sort(byModified),
    ];
  }

  const taskGroups = useMemo(() => {
    // Full-tree index (roots *and* descendants) so forked child sessions
    // assigned to a task render inside the group and leave the chat region.
    const byId = new Map<string, SessionTreeNode>();
    const walk = (nodes: SessionTreeNode[]) => {
      for (const n of nodes) {
        byId.set(n.session.id, n);
        walk(n.children);
      }
    };
    walk(sessionTree);
    // 任务下全部会话数（含 fork 子树）——删除确认文案用。
    const countTree = (nodes: SessionTreeNode[]): number =>
      nodes.reduce((sum, n) => sum + 1 + countTree(n.children), 0);
    return tasks.map((task) => {
      const nodes = orderPinnedFirst(
        task.sessionIds
          .map((sid) => byId.get(sid))
          .filter((n): n is SessionTreeNode => Boolean(n)),
      );
      return { task, nodes, sessionTotal: countTree(nodes) };
    });
  }, [tasks, sessionTree]);

  // Everything owned by a task group (including its descendants) leaves the
  // chat region; remaining roots form the temp/chat list.
  const tempNodes = useMemo(() => {
    const owned = new Set<string>();
    for (const g of taskGroups) {
      const walk = (nodes: SessionTreeNode[]) => {
        for (const n of nodes) {
          owned.add(n.session.id);
          walk(n.children);
        }
      };
      walk(g.nodes);
    }
    return sessionTree.filter((n) => !owned.has(n.session.id));
  }, [sessionTree, taskGroups]);

  // Chat region: pinned sessions first, then the rest (hairline between).
  const chatNodes = useMemo(
    () => [
      ...tempNodes.filter((n) => n.session.pinned),
      ...tempNodes.filter((n) => !n.session.pinned),
    ],
    [tempNodes],
  );

  // Worktree switcher — moved out of the header into the files tab.
  const worktreeSection = (
    <>
      {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 28,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: wtDropdownOpen ? "var(--side-active)" : wtTriggerHovered ? "var(--side-hover)" : "transparent",
                  border: "none",
                  borderRadius: 5,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                  transition: "background 0.12s",
                }}
                onMouseEnter={() => setWtTriggerHovered(true)}
                onMouseLeave={() => setWtTriggerHovered(false)}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                up
                style={{
                  position: "absolute",
                  top: "auto",
                  bottom: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--popover-glass)",
                  backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                  WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
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
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
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
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
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
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
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
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
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
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
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
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
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
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "transparent",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            <button
              onClick={handleNewSession}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                background: "transparent",
                border: "none",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                padding: "3px 6px",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                textDecoration: "none",
                transition: "color 0.12s",
              }}
             title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.textDecoration = "underline";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.textDecoration = "none";
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {t("sidebar.tempSessions")}
            </button>
            <button
              onClick={() => { if (onRefresh) onRefresh(); else loadSessions(false, true); }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                background: sessionRefreshDone ? "rgba(74,222,128,0.12)" : "transparent",
                border: "none",
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                padding: "3px 6px",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                textDecoration: "none",
                transition: "color 0.3s, background 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.textDecoration = "underline";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.textDecoration = "none";
              }}
               title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
              {t("sidebar.refresh")}
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: dropdownOpen
                ? "var(--side-active)"
                : cwdHovered
                  ? "var(--side-hover)"
                  : selectedCwd
                    ? "color-mix(in srgb, var(--glass-bg-strong) 55%, transparent)"
                    : "color-mix(in srgb, var(--accent) 8%, transparent)",
              border: selectedCwd
                ? "1px solid color-mix(in srgb, var(--border) 55%, transparent)"
                : "1px solid color-mix(in srgb, var(--accent) 40%, transparent)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              boxShadow: "inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent)",
              transition: "border-color 0.15s, background 0.15s",
            }}
            onMouseEnter={() => setCwdHovered(true)}
            onMouseLeave={() => setCwdHovered(false)}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  marginLeft: 6,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--popover-glass)",
              backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
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
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    onClick={() => {
                      setSelectedCwd(project.root);
                      setProjectFilter("");
                      setCustomPathOpen(false);
                      setCustomPathValue("");
                      setCustomPathError(null);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
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
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>
      </div>

      <SessionTabs
        active={sidebarTab}
        runningCount={runningSessionIds.size}
        onChange={(tab) => {
          setSidebarTab(tab);
          saveSidebarTab(tab);
        }}
      />

      {/* Sessions panel — always mounted; hidden via display when the files
          panel is active so switching tabs never tears down/rebuilds it. */}
      <div style={{ flex: 1, minHeight: 0, display: sidebarTab === "sessions" ? "flex" : "none", flexDirection: "column", overflowY: "auto", overflowX: "hidden" }}>
          {loading ? (
            <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
              {t("sidebar.loading")}
            </div>
          ) : error ? (
            <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
              {error}
            </div>
          ) : (
            <>
              {/* Boards section — sits above tasks, style matches task rows */}
              <BoardSection
                projectKey={selectedProject?.key ?? null}
                runningCount={runningBoardCount}
                activeBoardId={activeBoardId ?? null}
                collapsed={boardsCollapsed}
                refreshKey={refreshKey}
                onToggleCollapsed={() => { const next = !boardsCollapsed; setBoardsCollapsed(next); saveCollapsedFlag(BOARDS_COLLAPSED_KEY, next); }}
                onOpenBoard={(id) => onOpenBoard?.(id)}
              />

              {/* Tasks section — fluid up to a cap (GPT-style), scrolls inside
                  when it exceeds the cap so the chat section always keeps room. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  flex: tasksCollapsed ? "0 0 auto" : "0 0 auto",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px 3px 10px" }}>
                  <button
                    type="button"
                    onClick={() => { const next = !tasksCollapsed; setTasksCollapsed(next); saveCollapsedFlag(TASKS_COLLAPSED_KEY, next); }}
                    aria-expanded={!tasksCollapsed}
                    style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "var(--text-dim)" }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.02em" }}>{t("sidebar.tasks")}</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: tasksCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }} aria-hidden="true">
                      <polyline points="2 3.5 5 6.5 8 3.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewTaskOpen((v) => !v)}
                    title={t("sidebar.newTask")}
                    aria-label={t("sidebar.newTask")}
                    style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 5, color: "var(--text-dim)", cursor: "pointer" }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "var(--side-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <line x1="6" y1="1" x2="6" y2="11" />
                      <line x1="1" y1="6" x2="11" y2="6" />
                    </svg>
                  </button>
                </div>
                {!tasksCollapsed && (
                  <div style={{ overflowX: "hidden" }}>
                    <TaskArea
                      groups={taskGroups.map(({ task, nodes, sessionTotal }) => {
                        const pinnedCount = nodes.filter((n) => n.session.pinned).length;
                        return {
                          task,
                          sessionCount: nodes.length,
                          pinnedCount,
                          sessionTotal,
                          content: (showAll: boolean) => {
                            const pinnedSet = new Set(task.pinnedSessionIds ?? []);
                            // 默认只展示置顶会话 + 最近 5 个非置顶会话（nodes 已按
                            // 置顶在前、非置顶按 modified 降序排序，前段即最近）。
                            const visible = showAll
                              ? nodes
                              : nodes.slice(0, pinnedCount + TASK_SESSION_PREVIEW_LIMIT);
                            const out: ReactNode[] = [];
                            visible.forEach((node, i) => {
                              const isPin = pinnedSet.has(node.session.id);
                              if (i > 0) {
                                const prev = visible[i - 1];
                                if (prev && pinnedSet.has(prev.session.id) && !isPin) {
                                  out.push(
                                    <div key={`pin-line-${i}`} style={{ margin: "2px 6px 4px", height: 1, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />,
                                  );
                                }
                              }
                              out.push(
                                <SessionTreeItem
                                  key={node.session.id}
                                  node={node}
                                  selectedSessionId={selectedSessionId}
                                  runningSessionIds={runningSessionIds}
                                  unreadSessionIds={unreadSessionIds}
                                  onSelectSession={handleSelectSessionFromList}
                                  onRenamed={(id, name) => handleSessionRenamed(id, name)}
                                  onSessionDeleted={(id) => {
                                    onSessionDeleted?.(id);
                                    loadSessions();
                                  }}
                                  onTogglePin={handleToggleSessionPin}
                                  depth={0}
                                />,
                              );
                            });
                            return (
                              <div style={{ paddingLeft: 14, paddingBottom: 2 }}>{out}</div>
                            );
                          },
                        };
                      })}
                      selectedSessionId={selectedSessionId}
                      activeBoardId={activeBoardId}
                      runningSessionIds={runningSessionIds}
                      newTaskOpen={newTaskOpen}
                      onNewTaskOpenChange={setNewTaskOpen}
                      onNewTask={(name) => void handleCreateTask(name)}
                      onRenameTask={(id, name) => void handleRenameTask(id, name)}
                      onDeleteTask={(id) => void handleDeleteTask(id)}
                      onNewSessionFromTask={(taskId) => onNewSessionFromTask?.(taskId, selectedProject?.key ?? undefined)}
                      onToggleTaskPin={handleToggleTaskPin}
                      onOpenTaskBoard={(taskId) => onOpenTaskBoard?.(taskId)}
                      onDropSessionToTask={(taskId, sessionId) => void handleAssignSession(taskId, sessionId)}
                      onReorderTasks={handleReorderTasks}
                    />
                  </div>
                )}
              </div>

              {/* Chat section — takes remaining space when expanded, but never
                  shrinks below its content (flex-shrink 0): a tall task list
                  grows the whole panel and scrolls instead of crushing chat. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  minHeight: 0,
                  flex: chatCollapsed ? "0 0 auto" : "1 0 auto",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", padding: "5px 10px 3px" }}>
                  <button
                    type="button"
                    onClick={() => { const next = !chatCollapsed; setChatCollapsed(next); saveCollapsedFlag(TEMP_COLLAPSED_KEY, next); }}
                    aria-expanded={!chatCollapsed}
                    style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer", color: "var(--text-dim)" }}
                  >
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.02em" }}>{t("sidebar.tempSessions")}</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: chatCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s" }} aria-hidden="true">
                      <polyline points="2 3.5 5 6.5 8 3.5" />
                    </svg>
                  </button>
                </div>
                {!chatCollapsed && (
                  <div
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes("text/session-id")) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setTempDragOver(true);
                    }}
                    onDragLeave={() => setTempDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setTempDragOver(false);
                      const sid = e.dataTransfer.getData("text/session-id");
                      if (sid) void handleUnassignSession(sid);
                    }}
                    style={{
                      flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden",
                      background: tempDragOver ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "transparent",
                    }}
                  >
                    {chatNodes.map((node, i) => {
                      const isPin = Boolean(node.session.pinned);
                      const prevPin = i > 0 && Boolean(chatNodes[i - 1].session.pinned);
                      return (
                        <div key={node.session.id}>
                          {prevPin && !isPin && (
                            <div style={{ margin: "2px 6px 4px", height: 1, background: "color-mix(in srgb, var(--border) 45%, transparent)" }} />
                          )}
                          <SessionTreeItem
                            node={node}
                            selectedSessionId={selectedSessionId}
                            runningSessionIds={runningSessionIds}
                            unreadSessionIds={unreadSessionIds}
                            onSelectSession={handleSelectSessionFromList}
                            onRenamed={(id, name) => handleSessionRenamed(id, name)}
                            onSessionDeleted={(id) => {
                              onSessionDeleted?.(id);
                              loadSessions();
                            }}
                            onTogglePin={handleToggleSessionPin}
                            depth={0}
                          />
                        </div>
                      );
                    })}
                    {chatNodes.length === 0 && taskGroups.length === 0 && (
                      <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
                        {t("sidebar.noSessions")}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

      {/* Files panel — always mounted too; hidden via display when the
          sessions panel is active. */}
      <div style={{ flex: 1, display: sidebarTab === "files" ? "flex" : "none", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      {/* File Explorer section — always expanded; the file actions live in a
          toolbar at the top of the tree (FileExplorer toolbar prop) */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: "1 1 0",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* FileExplorer owns the scrolling: its search box + action row stay
              pinned while the changes / tree list scrolls inside. */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <FileExplorer
              ref={fileExplorerRef}
              cwd={selectedCwd ?? selectedCwdProp!}
              onOpenFile={onOpenFile ?? (() => {})}
              refreshKey={explorerKey}
              onAtMention={onAtMention}
              onAtMentions={onAtMentions}
              onUploadBusyChange={setExplorerUploadBusy}
              changesCollapsed={changesCollapsed}
              onChangesCountChange={setChangesCount}
              toolbar={
                <>
                  {changesCount > 0 && (
                    <ToolbarIconButton
                      onClick={() => setChangesCollapsed((v) => !v)}
                      title={t("sidebar.changedFiles", { count: changesCount })}
                      ariaPressed={!changesCollapsed}
                      color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                      background={changesCollapsed ? "none" : "var(--side-active)"}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="3" />
                        <path d="M3 12h6" />
                        <path d="M15 12h6" />
                      </svg>
                    </ToolbarIconButton>
                  )}
                  <ToolbarIconButton
                    onClick={() => fileExplorerRef.current?.openUploadPicker()}
                    disabled={explorerUploadBusy}
                    title={t("sidebar.uploadFilesTitle")}
                    color="var(--text-dim)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <path d="m17 8-5-5-5 5" />
                      <path d="M12 3v12" />
                    </svg>
                  </ToolbarIconButton>
                  <ToolbarIconButton
                    onClick={() => {
                      if (onExplorerRefresh) onExplorerRefresh();
                      else setExplorerKey((k) => k + 1);
                      setExplorerRefreshDone(true);
                      if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                      explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
                    }}
                    title={t("sidebar.refreshExplorer")}
                    skipHover={explorerRefreshDone}
                    color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
                    background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
                    marginRight={0}
                  >
                    {explorerRefreshDone ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    )}
                  </ToolbarIconButton>
                </>
              }
            />
          </div>
        </div>
      )}
          {worktreeSection}
        </div>
    </div>
  );
}
function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onTogglePin,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: (sessionId: string, newName: string) => void;
  onSessionDeleted?: (id: string) => void;
  onTogglePin?: (sessionId: string, nextPinned: boolean) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          onTogglePin={onTogglePin}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              onTogglePin={onTogglePin}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  onTogglePin,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: (sessionId: string, newName: string) => void;
  onDeleted?: (id: string) => void;
  onTogglePin?: (sessionId: string, nextPinned: boolean) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 删除确认气泡方向：下方空间不足时向上展开（防滚动容器边缘被 overflow 裁剪）。 */
  const [confirmUp, setConfirmUp] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** 更多（⋮）下拉：打开态 + 展开方向（下方空间不足时向上） */
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreUp, setMoreUp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // 菜单/删除确认气泡打开时：点击它们外任意处 / Escape 关闭（用捕获阶段监听，避免被 stopPropagation 拦掉）。
  useEffect(() => {
    if (!moreOpen && !confirmDelete) return;
    const onPointerDown = (ev: PointerEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(ev.target as Node)) {
        setMoreOpen(false);
        setConfirmDelete(false);
      }
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setMoreOpen(false);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [moreOpen, confirmDelete]);

  // 打开菜单前测可用空间：按钮下方放不下菜单则向上展开。
  const handleMoreClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (moreOpen) {
      setMoreOpen(false);
      return;
    }
    const btn = (e.currentTarget as HTMLElement).getBoundingClientRect();
    let node = (e.currentTarget as HTMLElement).parentElement;
    let container: Element | null = null;
    while (node) {
      const st = getComputedStyle(node);
      if (st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "overlay") {
        container = node;
        break;
      }
      node = node.parentElement;
    }
    const cRect = container
      ? container.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    const MENU_HEIGHT_EST = 3 * 34 + 12; // 菜单三项估算高 + 内边距
    const spaceBelow = cRect.bottom - btn.bottom;
    const spaceAbove = btn.top - cRect.top;
    const fitsBelow = spaceBelow >= MENU_HEIGHT_EST;
    const fitsAbove = spaceAbove >= MENU_HEIGHT_EST;
    setMoreUp(!fitsBelow && (fitsAbove || spaceAbove > spaceBelow));
    setMoreOpen(true);
  }, [moreOpen]);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const parsedSkill = skillExpansionToCommand(session.firstMessage);
  const displayFirstMessage = parsedSkill?.command ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setMoreOpen(false);
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.(session.id, name);
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMoreOpen(false);
    setConfirmUp(actionsRef.current ? dropdownDirection(actionsRef.current, 96) : false);
    setConfirmDelete(true);
  }, []);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(session.id, session.name ?? ""); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 36;

  return (
    <div
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      draggable={!renaming && !confirmDelete}
      onDragStart={(e) => {
        setMoreOpen(false);
        e.dataTransfer.setData("text/session-id", session.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        margin: "0 6px 1px",
        borderRadius: 6,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "color-mix(in srgb, #ef4444 7%, transparent)"
          : isSelected ? "color-mix(in srgb, var(--accent) 8%, transparent)" : hovered ? "var(--side-hover)" : "transparent",
        borderLeft: "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
      }}
    >
      {renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--side-input)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
            {session.pinned && (
              <span title={t("sidebar.pinned")} style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
              </span>
            )}
            {isRunning ? (
              <RunningSessionIndicator />
            ) : isUnread ? (
              <UnreadSessionIndicator />
            ) : null}
            {session.isWorktree && session.branch && (
              <span
                title={`Worktree: ${session.cwd}`}
                style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden", flexShrink: 0 }}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
              </span>
            )}
            <span
              title={title}
              style={{
                flex: 1, minWidth: 0,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {title}
            </span>
          </div>

          {/* Expand / collapse toggle — shown on hover, placed before the fork
              indicator so the toggle is the leftmost element. */}
          {hovered && hasChildren && !session.transient && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? "Expand forks" : "Collapse forks"}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}
          {/* Action buttons — shown on hover: 编辑 + 更多（⋮，下拉 置顶/编辑/删除） */}
          {(hovered || moreOpen || confirmDelete) && !session.transient && (
            <div ref={actionsRef} style={{ position: "relative", display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, padding: 0,
                  background: "transparent", border: "1px solid transparent",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--side-active)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleMoreClick}
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                title={t("sidebar.moreActions")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, padding: 0,
                  background: moreOpen ? "var(--side-active)" : "transparent",
                  border: "1px solid transparent",
                  borderRadius: 7,
                  color: moreOpen ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (moreOpen) return;
                  e.currentTarget.style.background = "var(--side-active)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  if (moreOpen) return;
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.4" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.4" fill="currentColor" />
                  <circle cx="12" cy="19" r="1.4" fill="currentColor" />
                </svg>
              </button>

              <AnimatedDropdown
                open={moreOpen}
                up={moreUp}
                style={{
                  position: "absolute",
                  top: moreUp ? "auto" : "calc(100% + 4px)",
                  bottom: moreUp ? "calc(100% + 4px)" : "auto",
                  right: 0,
                  zIndex: 120,
                  minWidth: 148,
                  background: "var(--popover-glass)",
                  backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                  WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                  border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                  borderRadius: 9,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  padding: 4,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }} role="menu">
                  <button
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMoreOpen(false);
                      onTogglePin?.(session.id, !session.pinned);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "7px 10px", border: "none", borderRadius: 6,
                      background: "transparent", color: session.pinned ? "var(--accent)" : "var(--text)",
                      cursor: "pointer", fontSize: 12, textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M12 17v5" />
                      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                    </svg>
                    {session.pinned ? t("sidebar.unpin") : t("sidebar.pin")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMoreOpen(false);
                      startRename(e);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "7px 10px", border: "none", borderRadius: 6,
                      background: "transparent", color: "var(--text)",
                      cursor: "pointer", fontSize: 12, textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--side-hover)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                    </svg>
                    {t("sidebar.rename")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMoreOpen(false);
                      handleDeleteClick(e);
                    }}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "7px 10px", border: "none", borderRadius: 6,
                      background: "transparent", color: "#ef4444",
                      cursor: "pointer", fontSize: 12, textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.10)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    {t("sidebar.delete")}
                  </button>
                </div>
              </AnimatedDropdown>

              {/* 删除确认气泡 —— 浮在操作区旁，不替换行内容；方向自适应防 overflow 裁剪 */}
              {confirmDelete && (
                <div
                  role="alertdialog"
                  style={{
                    position: "absolute",
                    ...(confirmUp
                      ? { bottom: "calc(100% + 4px)" }
                      : { top: "calc(100% + 4px)" }),
                    right: 0,
                    zIndex: 121,
                    width: 224,
                    boxSizing: "border-box",
                    padding: 10,
                    display: "flex", flexDirection: "column", gap: 8,
                    background: "var(--popover-glass)",
                    backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                    WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
                    border: "1px solid color-mix(in srgb, var(--border) 60%, transparent)",
                    borderRadius: 9,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                  }}
                >
                  <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text)" }}>
                    {t("sidebar.deleteSession", { title: title.slice(0, 30) + (title.length > 30 ? "…" : "") })}
                  </div>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      onClick={handleDeleteConfirm}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                        height: 26, padding: "0 10px",
                        background: "color-mix(in srgb, #ef4444 12%, transparent)",
                        border: "none", borderRadius: 5, color: "#ef4444",
                        cursor: "pointer", fontSize: 11, fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("sidebar.delete")}
                    </button>
                    <button
                      onClick={handleDeleteCancel}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "center",
                        height: 26, padding: "0 10px",
                        background: "var(--side-input)", border: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
                        borderRadius: 5, color: "var(--text-muted)",
                        cursor: "pointer", fontSize: 11, fontWeight: 500,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t("sidebar.cancel")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

        </>
      )}
    </div>
  );
}

// ============================================================================
// Sidebar view-state persistence (tabs / task area / temp list collapse).
// Mirrors the loadExplorerOpen/saveExplorerOpen pattern.
// ============================================================================

const SIDEBAR_TAB_KEY = "pi-sidebar-tab";
const BOARDS_COLLAPSED_KEY = "pi-sidebar-boards-collapsed";
const TASKS_COLLAPSED_KEY = "pi-sidebar-tasks-collapsed";
const TEMP_COLLAPSED_KEY = "pi-sidebar-chat-collapsed";

function loadSidebarTab(): SidebarTab {
  if (typeof window === "undefined") return "sessions";
  try {
    return window.localStorage.getItem(SIDEBAR_TAB_KEY) === "files" ? "files" : "sessions";
  } catch {
    return "sessions";
  }
}

function saveSidebarTab(tab: SidebarTab): void {
  try {
    window.localStorage.setItem(SIDEBAR_TAB_KEY, tab);
  } catch {
    // ignore storage errors
  }
}

function loadCollapsedFlag(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveCollapsedFlag(key: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // ignore storage errors
  }
}
