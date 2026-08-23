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
  /** Preserve keyboard byte order: HTTP POSTs can otherwise arrive out of order. */
  inputQueue: Promise<void>;
  disposed: boolean;
}

export type TerminalOrigin = "top" | "bottombar";

export function TerminalPanel({
  origin,
  anchorRect,
  activeCwd,
  onClose,
}: {
  /** "top": dropdown below the topbar button. "bottombar": rises from the bottom bar item. */
  origin: TerminalOrigin;
  /** Trigger button rect — anchors the panel to its entry. */
  anchorRect?: { top: number; left: number; right: number; bottom: number } | null;
  /** cwd for new terminals: the active session's project path. */
  activeCwd: string | null;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [sessions, setSessions] = useState<TerminalMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef<Map<string, Attached>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal");
      const d = await res.json() as { terminals?: TerminalMeta[] };
      if (Array.isArray(d.terminals)) setSessions(d.terminals);
    } catch { /* transient */ }
  }, []);

  // ── xterm theme from CSS variables (re-derived per terminal creation) ──────
  // ponytail: captured at terminal creation; mid-session theme switches apply
  // to newly created terminals only.
  const buildTheme = useMemo(() => () => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      background: "rgba(0, 0, 0, 0)",
      foreground: v("--text", "#d4d4d4"),
      cursor: v("--accent", "#3b82f6"),
      cursorAccent: v("--bg", "#1e1e1e"),
      selectionBackground: "rgba(128, 128, 128, 0.35)",
      black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
      blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
      brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
      brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
      brightCyan: "#29b8db", brightWhite: "#ffffff",
    };
  }, []);

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
      a = { term, fit, es: null, offset: null, reconnectTimer: null, inputQueue: Promise.resolve(), disposed: false };
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

  // Mount the active xterm into the DOM + keep it fitted.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeId) return;
    attach(activeId);
    const a = attachedRef.current.get(activeId);
    if (!a) return;
    if (!a.term.element) {
      a.term.open(el);
      a.term.focus();
    }
    const doFit = () => {
      try {
        a!.fit.fit();
        const { cols, rows } = a!.term;
        void fetch(`/api/terminal/${activeId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "resize", cols, rows }),
        });
      } catch { /* panel hidden mid-fit */ }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId, attach, sessions.length]);

  // Initial load: list sessions, activate newest.
  useEffect(() => {
    void refreshList().then(() => {
      setSessions((cur) => {
        if (!activeIdRef.current && cur.length > 0) setActiveId(cur[cur.length - 1].id);
        return cur;
      });
    });
  }, [refreshList]);

  // Light poll while open — keeps running/exit state honest without extra SSE.
  useEffect(() => {
    const iv = setInterval(() => void refreshList(), 5000);
    return () => clearInterval(iv);
  }, [refreshList]);

  // Prune client attachments for sessions the server no longer knows.
  useEffect(() => {
    const live = new Set(sessions.map((s) => s.id));
    for (const [id, a] of attachedRef.current) {
      if (live.has(id)) continue;
      a.disposed = true;
      if (a.reconnectTimer) clearTimeout(a.reconnectTimer);
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

  const closeSession = useCallback(async (id: string) => {
    await fetch(`/api/terminal/${id}`, { method: "DELETE" });
    await refreshList(); // prune effect disposes the attachment
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
      className={`terminal-panel terminal-panel-${origin}${isMobile ? " terminal-panel-mobile" : ""}`}
      style={panelStyle}
      role="region"
      aria-label={t("terminal.title")}
    >
      {/* Tab strip */}
      <div className="terminal-tabs">
        <div className="terminal-tab-scroll">
          {groups.length === 0 && (
            <span className="terminal-tab-empty">{t("terminal.empty")}</span>
          )}
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
