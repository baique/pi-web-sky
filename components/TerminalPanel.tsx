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
  hidden,
  onClose,
}: {
  /** "top": dropdown below the topbar button. "bottombar": rises from the bottom bar item. */
  origin: TerminalOrigin;
  /** Trigger button rect — anchors the panel to its entry. */
  anchorRect?: { top: number; left: number; right: number; bottom: number } | null;
  /** cwd for new terminals: the active session's project path. */
  activeCwd: string | null;
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
  const [loadedOnce, setLoadedOnce] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef<Map<string, Attached>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  // Sessions we are in the middle of deleting client-side. Any refreshList
  // that lands before the DELETE round-trips must not resurrect the chip.
  const pendingDeleteRef = useRef<Set<string>>(new Set());

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal");
      const d = await res.json() as { terminals?: TerminalMeta[] };
      if (Array.isArray(d.terminals)) {
        const pending = pendingDeleteRef.current;
        setSessions(d.terminals.filter((t) => !pending.has(t.id)));
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
      background: v("--terminal-bg", dark ? "rgba(12, 12, 14, 0.86)" : "rgba(250, 250, 251, 0.92)"),
      foreground: v("--text", dark ? "#d4d4d4" : "#1f2328"),
      cursor: v("--accent", "#3b82f6"),
      cursorAccent: v("--bg", dark ? "#1e1e1e" : "#ffffff"),
      selectionBackground: dark ? "rgba(128, 128, 128, 0.35)" : "rgba(0, 0, 0, 0.15)",
      ...(dark ? DARK_ANSI : LIGHT_ANSI),
    };
  }, []);

  // Live theme switching: re-theme every attached terminal when the
  // theme class on <html> flips, instead of waiting for a new terminal.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const theme = buildTheme();
      for (const [, a] of attachedRef.current) {
        if (a.term) a.term.options.theme = theme;
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
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
          if (r.ok) attach(id); // session still alive → re-attach
          else { void refreshList(); } // gone → list refresh prunes the chip
        }).catch(() => {});
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
    if (attempts >= 60) { // ~2s of retries — give up until the next trigger
      if (a.fitTimer) { clearTimeout(a.fitTimer); a.fitTimer = null; }
      a.term.element?.classList.remove("terminal-attaching");
      return;
    }
    if (a.fitTimer) clearTimeout(a.fitTimer);
    a.fitTimer = setTimeout(() => fitWhenReady(id, attempts + 1), 30);
  }, [reportResize]);

  // Mount the active xterm into the DOM + keep it fitted.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeId) return;
    attach(activeId);
    const a = attachedRef.current.get(activeId);
    if (!a) return;
    if (!a.term.element) {
      a.term.open(el);
    }
    a.term.element?.classList.add("terminal-attaching");
    // Hidden (display:none) → no geometry to fit; the next show re-runs this.
    if (hidden) return;
    fitWhenReady(activeId);
    const ro = new ResizeObserver(() => {
      if (!hiddenRef.current && activeIdRef.current === activeId) fitWhenReady(activeId);
    });
    ro.observe(el);
    return () => { ro.disconnect(); };
  }, [activeId, attach, hidden, fitWhenReady]);

  // Initial load: list sessions, activate newest. Re-runs on every show —
  // the panel stays mounted while hidden, so showing is the moment to
  // re-sync the session list (states may have changed while hidden).
  useEffect(() => {
    if (hidden) return;
    void refreshList().then(() => {
      setLoadedOnce(true);
      setSessions((cur) => {
        if (!activeIdRef.current && cur.length > 0) setActiveId(cur[cur.length - 1].id);
        return cur;
      });
    });
  }, [hidden, refreshList]);

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
  }, [activeCwd, refreshList]);

  // Auto-create the first terminal when the server has none yet — opening the
  // panel should just work, not present an empty state. One attempt only;
  // failures surface via the manual create button. Setting autoCreatedRef in
  // every non-creating branch matters: if a session existed on open, deleting
  // it must NOT auto-spawn a replacement (the user asked to close it).
  // Runs on show only — the panel now lives mounted while hidden.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (hidden) return;
    if (autoCreatedRef.current) return;
    if (!loadedOnce || creating) return;
    autoCreatedRef.current = true;
    if (sessions.length > 0) return; // sessions already exist — no auto-create
    void createSession();
  }, [hidden, loadedOnce, creating, sessions.length, createSession]);

  const closeSession = useCallback(async (id: string) => {
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

  // Outside click / Escape close.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    fabRef.current = document.getElementById("terminal-bottombar-btn") as HTMLElement | null;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (fabRef.current?.contains(target)) return;
      // The topbar trigger is the sibling entry button — clicking it must be a
      // genuine toggle, not an outside-click close, or the two handlers fight
      // (close + reopen) and the collapsed panel replays its enter animation.
      if (document.getElementById("terminal-topbar-btn")?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  // Group chips by project label, preserving creation order inside groups.
  const groups = useMemo(() => {
    const map = new Map<string, TerminalMeta[]>();
    for (const s of sessions) {
      const arr = map.get(s.projectLabel) ?? [];
      arr.push(s);
      map.set(s.projectLabel, arr);
    }
    return [...map.entries()];
  }, [sessions]);

  const panelStyle: React.CSSProperties = isMobile
    ? { position: "fixed", inset: 10, zIndex: 1050 }
    : origin === "top"
      ? (() => {
          const width = Math.min(780, window.innerWidth - 48);
          const triggerCenter = anchorRect
            ? (anchorRect.left + anchorRect.right) / 2
            : window.innerWidth / 2;
          const left = Math.max(24, Math.min(
            triggerCenter - width / 2,
            window.innerWidth - width - 24,
          ));
          return {
            position: "fixed",
            top: (anchorRect?.bottom ?? anchorRect?.top ?? 46) + 2,
            left,
            width,
            height: 460,
            zIndex: 1040,
          };
        })()
      : {
          // Bottom-bar entry: rise above the trigger, right-aligned with a
          // breathing margin so the panel does not hug the viewport edge.
          position: "fixed",
          right: anchorRect ? Math.max(24, window.innerWidth - anchorRect.right) : 24,
          bottom: anchorRect ? window.innerHeight - anchorRect.top + 6 : 40,
          width: Math.min(780, window.innerWidth - 48),
          height: Math.min(460, window.innerHeight - 120),
          zIndex: 1040,
        };

  const panel = (
    <div
      ref={rootRef}
      className={`terminal-panel terminal-panel-${origin}${isMobile ? " terminal-panel-mobile" : ""}${hidden ? " terminal-panel-hidden" : ""}`}
      style={panelStyle}
      role="region"
      aria-label={t("terminal.title")}
    >
      {/* Tab strip */}
      <div className="terminal-tabs">
        <div className="terminal-tab-scroll">
          {groups.map(([label, items]) => (
            <div key={label} className="terminal-group">
              <span className="terminal-group-label">{label}</span>
              {items.map((s) => (
                <div
                  key={s.id}
                  className={`terminal-chip${s.id === activeId ? " is-active" : ""}${!s.running ? " is-dead" : ""}`}
                  onClick={() => setActiveId(s.id)}
                  role="tab"
                  aria-selected={s.id === activeId}
                >
                  <span className={`terminal-dot${s.running ? "" : " is-dead"}`} />
                  <span className="terminal-chip-cwd" title={s.cwd}>
                    {s.cwd.split("/").filter(Boolean).pop() || s.cwd}
                  </span>
                  <button
                    type="button"
                    className="terminal-chip-close"
                    title={t("terminal.close")}
                    aria-label={t("terminal.close")}
                    onClick={(e) => { e.stopPropagation(); void closeSession(s.id); }}
                  >×</button>
                </div>
              ))}
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
      </div>

      {error && <div className="terminal-error">{error}</div>}

      {/* Terminal body — one div per known session, only active visible */}
      <div className="terminal-body" ref={containerRef}>
        {sessions.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              // Move the live xterm element into place when this becomes active.
              if (el && s.id === activeId && !el.firstChild) {
                const a = attachedRef.current.get(s.id);
                if (a?.term.element) el.appendChild(a.term.element);
              }
            }}
            data-terminal-view={s.id}
            style={{ display: s.id === activeId ? "block" : "none", height: "100%" }}
          />
        ))}
        {sessions.length === 0 && (
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
