"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

// ============================================================================
// TerminalPanel — multi-session web terminal (xterm.js + server-side pty).
//
// Session lifecycle: the pty lives on the server and survives page refreshes.
// Each client attach opens an SSE stream that replays buffered output from
// the last seen byte offset, then streams live. Closing a tab chip kills the
// process; hiding the panel only detaches.
// ============================================================================

export interface TerminalMeta {
  id: string;
  name: string;
  cwd: string;
  projectLabel: string;
  running: boolean;
  exitCode: number | null;
}

/** Resolved --font-mono stack — canvas cell measurement can't resolve var(). */
function cssFontStack(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
    || "'JetBrains Mono', Consolas, monospace";
}

interface Attached {
  term: Terminal;
  fit: FitAddon;
  es: EventSource | null;
  offset: number | null; // last byte offset seen; null = never attached
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Retry handle while the renderer's cell measurement is pending (fit no-ops before it). */
  fitTimer: ReturnType<typeof setTimeout> | null;
  /** Preserve keyboard byte order: HTTP POSTs can otherwise arrive out of order. */
  inputQueue: Promise<void>;
  disposed: boolean;
}

export type TerminalOrigin = "top" | "bottombar";

/** ANSI 16-colour palette for the dark terminal bed (classic xterm). */
const DARK_ANSI = {
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
  blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
  brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
  brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
  brightCyan: "#29b8db", brightWhite: "#ffffff",
};

/** ANSI 16-colour palette tuned for a light terminal bed (VS Code Light+). */
const LIGHT_ANSI = {
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#949800",
  blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
  brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
  brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
  brightCyan: "#0598bc", brightWhite: "#a5a5a5",
};

export function TerminalPanel({
  origin,
  anchorRect,
  activeCwd,
  activeProjectLabel,
  hidden,
  onClose,
}: {
  /** "top": dropdown below the topbar button. "bottombar": rises from the bottom bar item. */
  origin: TerminalOrigin;
  /** Trigger button rect — anchors the panel to its entry. */
  anchorRect?: { top: number; left: number; right: number; bottom: number } | null;
  /** cwd for new terminals: the active session's project path. */
  activeCwd: string | null;
  /** 当前项目名（服务端终端会话的 projectLabel 同格式）。左侧栏只展示该项目终端。 */
  activeProjectLabel: string | null;
  /** Panel stays mounted while hidden (show/hide, no teardown) — xterm instances and SSE survive. */
  hidden: boolean;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<TerminalMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** SSE 断开且服务端探活失败（后台重启/断网）的会话 id —— 芯片显示“失联”状态，可一键批量清理。 */
  const [disconnectedIds, setDisconnectedIds] = useState<Set<string>>(new Set());
  // 「等待新鲜同步」门闩：每次成功的列表同步（refreshList 落地）会解除并推进 syncTick，
  // 按项目评估只在解除后执行，避免用隐藏/加载期的陈旧 sessions 误自动创建重复终端。
  const resyncNeededRef = useRef(true);
  const syncVersionRef = useRef(0);
  const [syncTick, setSyncTick] = useState(0);
  // 自动创建护栏：用户手动关闭过某项目的终端（×）→ 该项目不再自动补建；
  // autoCreateRequested 避免同一可见时段内重复发起；切换项目/重新打开面板后重新评估。
  const userClosedLabelsRef = useRef<Set<string>>(new Set());

  // ── 面板自由定位（拖拽）与自由缩放（右下角手柄）──────────────────────
  // 拖拽位置/尺寸保存在组件内 state：面板常驻挂载（hidden 只是 display:none），
  // 所以关闭再打开仍保持用户调好的位置与大小；页面刷新后回到锚定默认。
  const [dragPos, setDragPos] = useState<{ left: number; top: number } | null>(null);
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    capturing: boolean;
  } | null>(null);
  const resizeStateRef = useRef<{ pointerId: number; startX: number; startY: number; startW: number; startH: number } | null>(null);
  const MIN_TERMINAL_W = 320;
  const MIN_TERMINAL_H = 200;
  const clampNum = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  /** 拖拽开始判定阈值：超过它才真正进入拖拽（否则 chip 的 click 仍正常触发）。 */
  const DRAG_THRESHOLD = 4;
  const autoCreateRequestedRef = useRef<string | null>(null);
  const lastAutoEvaluateLabelRef = useRef<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const attachedRef = useRef<Map<string, Attached>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // Sessions we are in the middle of deleting client-side. Any refreshList
  // that lands before the DELETE round-trips must not resurrect the chip.
  const pendingDeleteRef = useRef<Set<string>>(new Set());

  // 左侧栏：只展示当前项目（按 projectLabel 匹配）的终端；下拉选展示全部。
  const visibleSessions = useMemo(() => {
    if (!activeProjectLabel) return [];
    return sessions.filter((s) => s.projectLabel === activeProjectLabel);
  }, [sessions, activeProjectLabel]);

  // 全部终端按项目名分组 —— 喂给最右侧的下拉选。
  const groups = useMemo(() => {
    const map = new Map<string, TerminalMeta[]>();
    for (const s of sessions) {
      const arr = map.get(s.projectLabel) ?? [];
      arr.push(s);
      map.set(s.projectLabel, arr);
    }
    return [...map.entries()];
  }, [sessions]);

  // 左侧 chips：当前项目终端；若经下拉选切到了其它项目的终端，则把它也钉在最前面并
  // 高亮 —— 保证“当前终端”在 tab 区始终有可辨识的代表，切换时名称随之更新。
  const chipSessions = useMemo(() => {
    if (!activeId || !visibleSessions.some((s) => s.id === activeId)) {
      const active = activeId ? sessions.find((s) => s.id === activeId) : undefined;
      return active ? [active, ...visibleSessions] : visibleSessions;
    }
    return visibleSessions;
  }, [visibleSessions, sessions, activeId]);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal");
      const d = await res.json() as { terminals?: TerminalMeta[] };
      if (Array.isArray(d.terminals)) {
        const pending = pendingDeleteRef.current;
        setSessions(d.terminals.filter((t) => !pending.has(t.id)));
        // 一次成功的同步落地：解除“等待新鲜同步”门闩，允许按项目评估/聚焦。
        resyncNeededRef.current = false;
        syncVersionRef.current += 1;
        setSyncTick((n) => n + 1);
      }
    } catch { /* transient */ }
  }, []);

  // ── xterm theme from CSS variables (re-derived per terminal creation) ──────
  // ANSI palettes follow the current theme: dark bed + light text, or a
  // light bed + dark text set tuned for readability on a light backdrop.
  const buildTheme = useMemo(() => () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const dark = document.documentElement.classList.contains("dark");
    return {
      // The tiny black-canvas trap: xterm fills its surface with
      // theme.background, and an unparsable "transparent" falls back to
      // solid black that CSS can't wash off. Feed it the exact bubble-glass
      // color the panel uses (--assistant-bg-rgb over --bubble-alpha), so
      // the terminal paints the same frosted surface in both themes and
      // follows the bubble alpha/blur sliders.
      background: `rgba(${v("--assistant-bg-rgb", dark ? "36, 36, 39" : "252, 252, 253")}, ${v("--bubble-alpha", dark ? "0.55" : "0.44")})`,
      foreground: v("--text", dark ? "#d4d4d4" : "#1f2328"),
      cursor: v("--accent", "#3b82f6"),
      cursorAccent: v("--bg", dark ? "#1e1e1e" : "#ffffff"),
      selectionBackground: dark ? "rgba(128, 128, 128, 0.35)" : "rgba(0, 0, 0, 0.15)",
      ...(dark ? DARK_ANSI : LIGHT_ANSI),
    };
  }, []);

  // Live theme switching: re-theme every attached terminal when the theme
  // class on <html> flips or the bubble-glass sliders rewrite the inline
  // style variables, instead of waiting for a new terminal.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = buildTheme();
      for (const [, a] of attachedRef.current) {
        if (a.term) a.term.options.theme = theme;
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    return () => observer.disconnect();
  }, [buildTheme]);

  // ── SSE attach / reconnect with offset resume ─────────────────────────────
  const attach = useCallback((id: string) => {
    let a = attachedRef.current.get(id);
    if (a?.es) return; // already streaming
    if (!a) {
      const term = new Terminal({
        convertEol: false,
        fontSize: 12.5,
        fontFamily: cssFontStack(),
        cursorBlink: true,
        scrollback: 5000,
        theme: buildTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.onData((data) => {
        const current = a!;
        // POST requests are independent; serialize them or fast typing can be
        // delivered to the pty as e.g. `prinft` instead of `printf`.
        current.inputQueue = current.inputQueue
          .catch(() => {})
          .then(async () => {
            await fetch(`/api/terminal/${id}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "input", data }),
            });
          })
          .catch(() => {});
      });
      a = { term, fit, es: null, offset: null, reconnectTimer: null, fitTimer: null, inputQueue: Promise.resolve(), disposed: false };
      attachedRef.current.set(id, a);
    }

    const since = a.offset !== null ? `?since=${a.offset}` : "";
    const es = new EventSource(`/api/terminal/${id}/events${since}`);
    a.es = es;
    es.onopen = () => {
      // 成功（重）连 —— 清除“失联”标记。
      setDisconnectedIds((cur) => {
        if (!cur.has(id)) return cur;
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    };
    es.addEventListener("output", (ev) => {
      const { d, o } = JSON.parse((ev as MessageEvent).data) as { d: string; o: number };
      a!.offset = o;
      a!.term.write(d);
    });
    es.addEventListener("gone", () => {
      es.close();
      a!.es = null;
      void refreshList();
    });
    es.onerror = () => {
      // Server restart / network blip — drop and retry with backoff.
      es.close();
      if (!a! || a!.disposed) return;
      a!.es = null;
      if (a!.reconnectTimer) clearTimeout(a!.reconnectTimer);
      a!.reconnectTimer = setTimeout(() => {
        fetch(`/api/terminal/${id}`).then((r) => {
          if (r.ok) attach(id); // session still alive → re-attach (onopen clears the disconnected mark)
          else { void refreshList(); } // gone → list refresh prunes the chip
        }).catch(() => {
          // Server unreachable (restart / network) — mark the chip disconnected so
          // it can still be removed directly; the visible poll refreshList() prunes
          // it once the server returns.
          setDisconnectedIds((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
        });
      }, 1500);
    };
  }, [buildTheme, refreshList]);

  // Report the client's current cols/rows to the pty (idempotent POST).
  const reportResize = useCallback((id: string) => {
    const a = attachedRef.current.get(id);
    if (!a) return;
    void fetch(`/api/terminal/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "resize", cols: a.term.cols, rows: a.term.rows }),
    });
  }, []);

  // Fit once the renderer's cell measurement is ready. Right after open(),
  // proposeDimensions() returns undefined (cell size is still 0 mid async
  // measure), so fit() silently no-ops and the terminal stays at its 80x24
  // defaults — stretched across the panel with the cursor near the bottom,
  // only fixed once a later resize lands. Retry on a short timer, and keep
  // the surface opacity-hidden until the first successful fit so that frame
  // is never painted. Hidden panels have no geometry (display:none → 0px),
  // so bail — the show effect re-fits.
  const fitWhenReady = useCallback((id: string, attempts = 0): void => {
    const a = attachedRef.current.get(id);
    const el = containerRef.current;
    if (!a || !el || hiddenRef.current || a.disposed) return;
    let prop: { cols: number; rows: number } | undefined;
    try { prop = a.fit.proposeDimensions(); } catch { /* not rendered yet */ }
    if (prop && prop.cols > 2 && prop.rows > 1) {
      if (a.fitTimer) { clearTimeout(a.fitTimer); a.fitTimer = null; }
      try { a.fit.fit(); } catch { /* panel hidden mid-fit */ }
      reportResize(id);
      a.term.element?.classList.remove("terminal-attaching");
      a.term.focus();
      // One more pass on the next frame: pixel rounding can leave the first
      // fit a column short; the follow-up keeps cols/rows exact.
      requestAnimationFrame(() => {
        if (a.disposed || hiddenRef.current) return;
        try { a.fit.fit(); } catch { /* panel hidden mid-frame */ }
      });
      return;
    }
    // Keep retrying instead of giving up: bailing out shows the unfitted
    // 80x24 first frame (cursor pinned near the bottom) until some later
    // pass fixes it — the "jumps up after ~1-2s" symptom on slow first
    // measures. Only surface after a long stall as a last resort.
    if (attempts >= 300) { // ~9s of retries
      if (a.fitTimer) { clearTimeout(a.fitTimer); a.fitTimer = null; }
      a.term.element?.classList.remove("terminal-attaching");
      console.warn(`[terminal] fit did not settle for ${id} after ~9s; showing as-is`);
      return;
    }
    if (a.fitTimer) clearTimeout(a.fitTimer);
    a.fitTimer = setTimeout(() => fitWhenReady(id, attempts + 1), 30);
  }, [reportResize]);

  // Attach the active xterm to its own stable host and keep it fitted. Do not
  // open into terminal-body and move it later: React's dev/prod commit timing
  // differs, and that reparenting race is what lets a new release terminal
  // paint at the bottom before it settles at the top.
  useEffect(() => {
    const el = containerRef.current;
    const host = activeId ? viewRefs.current.get(activeId) : undefined;
    if (!el || !host || !activeId) return;
    attach(activeId);
    const a = attachedRef.current.get(activeId);
    if (!a) return;
    // While hidden we pre-create Terminal + SSE, but deliberately do not open
    // xterm into a display:none host: character measurement needs visibility.
    if (hidden) return;
    if (!a.term.element) {
      a.term.open(host);
    } else if (a.term.element.parentElement !== host) {
      // Recovery for a hot-reloaded/legacy attachment; steady state never
      // reparents because each session owns one permanent host.
      host.appendChild(a.term.element);
    }
    a.term.element?.classList.add("terminal-attaching");
    // 立即聚焦（不等 fit 完成）——否则打开面板瞬间按 Ctrl+W 等，焦点还在触发按钮上，
    // 浏览器级快捷键会直接透传（关标签页）。
    a.term.focus();
    fitWhenReady(activeId);
    const ro = new ResizeObserver(() => {
      if (!hiddenRef.current && activeIdRef.current === activeId) fitWhenReady(activeId);
    });
    ro.observe(host);
    return () => { ro.disconnect(); };
  }, [activeId, attach, hidden, fitWhenReady]);

  // 面板可见 / 切换项目时触发一次同步：标记“需要新鲜数据”，并在可见时拉取最新列表。
  // 自动创建/聚焦必须等这次同步落地（resyncNeeded=false）后再评估，否则会用隐藏期或
  // 加载期的陈旧 sessions 误判“当前项目没有终端”而重复自动创建（见测试中的 dup 场景）。
  useEffect(() => {
    lastAutoEvaluateLabelRef.current = null;
    autoCreateRequestedRef.current = null; // 每次显示/切换项目都重新评估一次
    resyncNeededRef.current = true;
    if (hidden) return; // 隐藏时只标记，显示时再由本 effect 触发拉取
    void refreshList();
  }, [hidden, activeProjectLabel, refreshList]);

  // Light poll while VISIBLE — keeps running/exit state honest without
  // extra SSE. Paused while hidden (panel itself is the only consumer).
  useEffect(() => {
    if (hidden) return;
    const iv = setInterval(() => void refreshList(), 5000);
    return () => clearInterval(iv);
  }, [refreshList, hidden]);

  // Prune client attachments for sessions the server no longer knows.
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    for (const [id, a] of attachedRef.current) {
      if (live.has(id)) continue;
      a.disposed = true;
      if (a.reconnectTimer) clearTimeout(a.reconnectTimer);
      if (a.fitTimer) clearTimeout(a.fitTimer);
      a.es?.close();
      a.term.dispose();
      attachedRef.current.delete(id);
      setDisconnectedIds((cur) => {
        if (!cur.has(id)) return cur;
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
      if (activeIdRef.current === id) {
        setActiveId(sessions.find((s) => s.id !== id)?.id ?? null);
      }
    }
  }, [sessions]);

  // Cleanup all on unmount (detach only — server sessions survive).
  useEffect(() => () => {
    for (const [, a] of attachedRef.current) {
      a.disposed = true;
      if (a.reconnectTimer) clearTimeout(a.reconnectTimer);
      if (a.fitTimer) clearTimeout(a.fitTimer);
      a.es?.close();
      a.term.dispose();
    }
    attachedRef.current.clear();
  }, []);

  const createSession = useCallback(async () => {
    setCreating(true);
    setError(null);
    // 手动新建说明用户想要该项目的终端 —— 解除该项目此前的自动补建封禁。
    if (activeProjectLabel) userClosedLabelsRef.current.delete(activeProjectLabel);
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: activeCwd || "~" }),
      });
      const d = await res.json() as { terminal?: TerminalMeta; error?: string };
      if (!res.ok || !d.terminal) throw new Error(d.error ?? `HTTP ${res.status}`);
      await refreshList();
      setActiveId(d.terminal.id);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setCreating(false);
    }
  }, [activeCwd, activeProjectLabel, refreshList]);

  // 按项目聚焦 + 自动创建：仅在“一次新鲜同步落地后”（resyncNeeded=false，syncTick 驱动重跑）
  // 评估一次，避免与同步拉取竞态。逻辑：
  //  - 当前项目已有终端 → 聚焦最近一个；
  //  - 没有且未被用户手动关闭过 → 自动补开一个（cwd = 当前会话路径）；
  //  - 无当前项目 → 不自动创建，聚焦最近一个总终端（下拉可任选）。
  useEffect(() => {
    if (resyncNeededRef.current) return; // 还在等新鲜同步，先不评估
    if (creating) return;
    const label = activeProjectLabel;
    if (!label) {
      // 无当前项目：不自动创建；若还未选中任何终端，聚焦最近一个（下拉可任选）。
      if (!activeIdRef.current && sessions.length > 0) {
        setActiveId(sessions[sessions.length - 1].id);
      }
      return;
    }
    if (hidden) return;
    if (lastAutoEvaluateLabelRef.current === label) return; // 本项目已评估过
    lastAutoEvaluateLabelRef.current = label;
    if (visibleSessions.length > 0) {
      // 当前项目已有终端 —— 聚焦最近一个（若尚未聚焦在本项目上）。
      if (!activeIdRef.current || !visibleSessions.some((s) => s.id === activeIdRef.current)) {
        setActiveId(visibleSessions[visibleSessions.length - 1].id);
      }
      return;
    }
    if (userClosedLabelsRef.current.has(label)) return; // 用户手动关闭过 —— 尊重
    if (autoCreateRequestedRef.current === label) return; // 本时段已尝试过
    autoCreateRequestedRef.current = label;
    void createSession();
  }, [creating, activeProjectLabel, visibleSessions, sessions, hidden, syncTick, createSession]);

  const closeSession = useCallback(async (id: string, projectLabel: string) => {
    // 手动关闭 = “我不想要这里的终端” —— 按项目封禁自动补建（切换项目后重置）。
    userClosedLabelsRef.current.add(projectLabel);
    // Optimistic removal: drop the chip immediately so one click always
    // closes it — the prune effect disposes the attachment right away,
    // which also stops stale resize/SSE requests to the dying session.
    // The id stays in pendingDeleteRef so a late refreshList (SSE gone /
    // poll) cannot resurrect the chip before the DELETE round-trips.
    pendingDeleteRef.current.add(id);
    setSessions((cur) => cur.filter((s) => s.id !== id));
    try {
      const res = await fetch(`/api/terminal/${id}`, { method: "DELETE" });
      if (!res.ok) {
        // Server still has it — the kill didn't happen; lift the guard so
        // the next list refresh shows it again.
        pendingDeleteRef.current.delete(id);
        void refreshList();
      }
    } catch {
      pendingDeleteRef.current.delete(id);
      void refreshList();
    }
  }, [refreshList]);

  // 批量清理失联终端（后台重启/断网后 SSE 探活失败的那些）：本地立即移除并
  // 释放客户端资源（prune effect 会 dispose xterm/SSE/定时器），服务端 DELETE
  // 尽力而为 —— 重启后这些会话本就不存在；若服务端仍持有则会由后续刷新恢复。
  const cleanupDisconnected = useCallback(async () => {
    const targets = [...disconnectedIds];
    if (targets.length === 0) return;
    for (const id of targets) {
      pendingDeleteRef.current.add(id);
      void fetch(`/api/terminal/${id}`, { method: "DELETE" })
        .finally(() => { pendingDeleteRef.current.delete(id); });
    }
    setDisconnectedIds(new Set());
    setSessions((cur) => cur.filter((s) => !targets.includes(s.id)));
    void refreshList();
  }, [disconnectedIds, refreshList]);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // 拖拽：从面板 tab 条空白区（非 chips/按钮/select 处）按下并移动。
  const endDrag = useCallback((pointerId: number) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== pointerId) return;
    dragStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);
  const onPanelPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (!target.closest(".terminal-tabs")) return; // 只从 tab 条区域拖
    // 明确控件不拖（按钮/下拉/文本区）；chip 是 div，按下后若移动则拖面板，
    // 不移动则 click 照常切换会话（浏览器会区分 click 与 drag）。
    if (target.closest("button, select, input, textarea, a")) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    // 先不 capture：超过阈值进入拖拽态后才 capture，避免吞掉 chip 的 click。
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      capturing: false,
    };
    event.preventDefault();
  }, [isMobile]);
  const onPanelPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { endDrag(event.pointerId); return; }
    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    if (!d.capturing) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return; // 还没超过阈值，等 click
      d.capturing = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = "move";
      document.body.style.userSelect = "none";
    }
    event.preventDefault();
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setDragPos({
      left: clampNum(d.startLeft + dx, 0, Math.max(0, vw - rect.width)),
      top: clampNum(d.startTop + dy, 0, Math.max(0, vh - rect.height)),
    });
  }, [endDrag]);
  const onPanelPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    endDrag(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, [endDrag]);
  const onPanelPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    endDrag(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, [endDrag]);

  // 缩放：右下角手柄（透明，不破坏玻璃）。
  const endResize = useCallback((pointerId: number) => {
    const r = resizeStateRef.current;
    if (!r || r.pointerId !== pointerId) return;
    resizeStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);
  const onResizePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startW: rect.width,
      startH: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
  }, [isMobile]);
  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeStateRef.current;
    if (!r || r.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) { endResize(event.pointerId); return; }
    event.preventDefault();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPanelSize({
      width: clampNum(r.startW + (event.clientX - r.startX), MIN_TERMINAL_W, vw - 24),
      height: clampNum(r.startH + (event.clientY - r.startY), MIN_TERMINAL_H, vh - 24),
    });
  }, [endResize]);
  const onResizePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    endResize(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, [endResize]);
  const onResizePointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    endResize(event.pointerId);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }, [endResize]);

  // 终端键盘优先：焦点保护 + 浏览器级 Ctrl 快捷键兜底。
  // 根因：点击面板 tab 条/空白等非 xterm 区域后，焦点会掉到 body（Chrome 对不可聚焦
  // div 的清焦行为），此时 Ctrl+W 等浏览器级快捷键不再被 xterm 拦截，直接关标签页。
  // 修复：① 点击面板非交互区把焦点还给 xterm（用 click，pointerdown 聚焦会被默认清焦覆盖）；
  // ② document 级兜底——面板可见且焦点不在文本输入控件时，纯 Ctrl+A-Z 转发给 pty。
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const focusActiveTerm = () => {
      if (hiddenRef.current) return;
      const id = activeIdRef.current;
      const a = id ? attachedRef.current.get(id) : undefined;
      a?.term.focus();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("button, select, input, textarea, a")) return;
      focusActiveTerm();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (hiddenRef.current) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("input, textarea, [contenteditable='true']")) return; // 文本输入框自己处理
      const id = activeIdRef.current;
      const a = id ? attachedRef.current.get(id) : undefined;
      // Esc：面板可见时一律进终端（\x1b），不再关闭面板。
      if (event.key === "Escape") {
        if (!a) return;
        event.preventDefault();
        event.stopPropagation();
        a.term.input("\x1b");
        return;
      }
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      if (event.key.length !== 1) return;
      const code = event.key.toLowerCase().charCodeAt(0);
      if (code < 97 || code > 122) return; // 只转发纯 Ctrl+A-Z
      if (active?.classList?.contains("xterm-helper-textarea")) return; // xterm 原生处理
      if (!a) return;
      event.preventDefault();
      event.stopPropagation();
      a.term.input(String.fromCharCode(code - 96));
    };
    el.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      el.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const panelStyle: React.CSSProperties = isMobile
    ? { position: "fixed", inset: 10, zIndex: 1050 }
    : (() => {
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const vh = window.innerHeight;
        // 缩放：用户调过的尺寸优先，否则用锚定默认（拖拽/缩放后仍钳制在视口内）。
        const width = panelSize
          ? clampNum(panelSize.width, MIN_TERMINAL_W, vw - 24)
          : Math.min(780, vw - 48);
        const height = panelSize
          ? clampNum(panelSize.height, MIN_TERMINAL_H, vh - 24)
          : origin === "top" ? 465 : Math.min(465, vh - 120);
        const base: React.CSSProperties = { position: "fixed", width, height, zIndex: 1040 };
        if (dragPos) {
          // 拖拽过：完全脱离锚定，用用户位置（钳制在视口内）。
          base.left = clampNum(dragPos.left, 0, Math.max(0, vw - width));
          base.top = clampNum(dragPos.top, 0, Math.max(0, vh - height));
        } else if (origin === "top") {
          // Left-align with the trigger button (topbar terminal entry).
          base.top = anchorRect?.bottom ?? anchorRect?.top ?? 46;
          base.left = anchorRect
            ? Math.max(24, Math.min(anchorRect.left, vw - width - 24))
            : vw - width - 24;
        } else {
          // Bottom-bar entry: rise above the trigger, flush with the bottom
          // bar top. bottom = 底栏顶到视口底.
          base.right = anchorRect ? Math.max(24, vw - anchorRect.right) : 24;
          base.bottom = anchorRect ? vh - anchorRect.top : 35;
        }
        return base;
      })();

  const panel = (
    <div
      ref={rootRef}
      className={`terminal-panel terminal-panel-${origin}${isMobile ? " terminal-panel-mobile" : ""}${hidden ? " terminal-panel-hidden" : ""}`}
      style={{
        ...panelStyle,
        // L-panel 玻璃：终端面板（见 --panel-glass / --glass-blur-panel）
        background: "var(--panel-glass)",
        backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
        WebkitBackdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))",
      }}
      onPointerDown={onPanelPointerDown}
      onPointerMove={onPanelPointerMove}
      onPointerUp={onPanelPointerUp}
      onPointerCancel={onPanelPointerCancel}
      role="region"
      aria-label={t("terminal.title")}
    >
      {/* Tab strip: 左侧只放当前项目的终端；最右侧下拉选放全部（按项目分组） */}
      <div className="terminal-tabs">
        <div className="terminal-tab-scroll">
          {chipSessions.map((s) => (
            <div
              key={s.id}
              className={`terminal-chip${s.id === activeId ? " is-active" : ""}${!s.running ? " is-dead" : ""}${disconnectedIds.has(s.id) ? " is-disconnected" : ""}`}
              onClick={() => setActiveId(s.id)}
              role="tab"
              aria-selected={s.id === activeId}
              title={`${s.projectLabel} — ${s.cwd}`}
            >
              <span className={`terminal-dot${!s.running ? " is-dead" : disconnectedIds.has(s.id) ? " is-disconnected" : ""}`} />
              <span className="terminal-chip-cwd" title={s.cwd}>
                {s.name || s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd}
              </span>
              <button
                type="button"
                className="terminal-chip-close"
                title={t("terminal.close")}
                aria-label={t("terminal.close")}
                onClick={(e) => { e.stopPropagation(); void closeSession(s.id, s.projectLabel); }}
              >×</button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="terminal-new"
          onClick={() => void createSession()}
          disabled={creating}
          title={t("terminal.new")}
          aria-label={t("terminal.new")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        {disconnectedIds.size > 0 && (
          <button
            type="button"
            className="terminal-cleanup"
            onClick={() => void cleanupDisconnected()}
            title={t("terminal.cleanupDisconnected")}
            aria-label={t("terminal.cleanupDisconnected")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        )}
        {!isMobile && (
          <button
            type="button"
            className="terminal-close"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
            </svg>
          </button>
        )}
        <select
          className="terminal-all-select"
          value={activeId ?? ""}
          onChange={(e) => { const id = e.target.value; if (id) setActiveId(id); }}
          title={t("terminal.all")}
          aria-label={t("terminal.all")}
        >
          <option value="" disabled>{t("terminal.all")}</option>
          {groups.map(([label, items]) => (
            <optgroup key={label} label={label}>
              {items.map((s) => (
                <option key={s.id} value={s.id} title={`${s.projectLabel} — ${s.cwd}`}>
                  {s.name || s.cwd.split(/[\\/]/).filter(Boolean).pop() || s.cwd}{!s.running ? ` · ${t("terminal.exited")}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {error && <div className="terminal-error">{error}</div>}

      {/* Terminal body — one div per known session, only active visible */}
      {!isMobile && (
        <div
          className="terminal-resize-handle"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerCancel}
          title={t("terminal.resize")}
          aria-label={t("terminal.resize")}
          role="separator"
          aria-orientation="horizontal"
          tabIndex={-1}
        />
      )}
      <div className="terminal-body" ref={containerRef}>
        {sessions.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              if (el) viewRefs.current.set(s.id, el);
              else viewRefs.current.delete(s.id);
            }}
            data-terminal-view={s.id}
            style={{ display: s.id === activeId ? "block" : "none", height: "100%" }}
          />
        ))}
        {!activeId && (
          <div className="terminal-placeholder">
            <button type="button" onClick={() => void createSession()} disabled={creating}>
              {creating ? "…" : t("terminal.createFirst")}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // Portal to <body>: topbar glass backdrop-filter makes fixed-position
  // descendants relative to the topbar otherwise (see NOTES.md / todo panel).
  return createPortal(panel, document.body);
}
