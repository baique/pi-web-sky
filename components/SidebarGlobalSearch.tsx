"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionInfo } from "@/lib/types";

interface SearchHit {
  session: SessionInfo;
  titleMatch: boolean;
  snippet: string;
}

interface Props {
  onSelectSession: (session: SessionInfo) => void;
}

const DEBOUNCE_MS = 350;

/** Split an FTS snippet's [ … ] markers into highlightable pieces. */
function renderSnippet(snippet: string): React.ReactNode {
  if (!snippet) return null;
  const parts = snippet.split(/([\[\]])/g);
  let highlight = false;
  return parts.map((part, i) => {
    if (part === "[") {
      highlight = true;
      return null;
    }
    if (part === "]") {
      highlight = false;
      return null;
    }
    if (!part) return null;
    return highlight
      ? <mark key={i} style={{ background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "var(--text)", borderRadius: 2 }}>{part}</mark>
      : <span key={i}>{part}</span>;
  });
}

/**
 * Global session search in the top bar. Desktop: inline input + popover
 * results. Mobile: icon button that expands a full-width overlay input.
 * Carries the trailing divider that separates it from the buttons on its right.
 */
export function SidebarGlobalSearch({ onSelectSession }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [open, setOpen] = useState(false);
  const [mobileOverlay, setMobileOverlay] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Anchor the popover to the input (portal to <body> — the topbar's
  // backdrop-filter is a containing block for fixed descendants, see NOTES.md).
  useEffect(() => {
    if (!open || !inputRef.current || isMobile) return;
    const update = () => {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(320, rect.width) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(document.documentElement);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, isMobile]);

  // Debounced search with abort (desktop + mobile share one pipeline).
  useEffect(() => {
    if (!query.trim()) return;
    const q = query.trim();
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setOpen(true);
      setIndexing(true);
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`, { signal: controller.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ results: SearchHit[]; indexing: boolean }>) : null))
        .then((d) => {
          if (d) {
            setResults(d.results ?? []);
            setIndexing(d.indexing);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (controller.signal.aborted) return;
          setIndexing(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, isMobile]);

  // Focus the mobile overlay input once expanded.
  useEffect(() => {
    if (mobileOverlay) setTimeout(() => mobileInputRef.current?.focus(), 0);
  }, [mobileOverlay]);

  const close = useCallback(() => {
    setOpen(false);
    setMobileOverlay(false);
    setQuery("");
    setResults(null);
  }, []);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open && !mobileOverlay) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      if (mobileInputRef.current?.closest("[data-mobile-search]")?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, mobileOverlay, close]);

  const handlePick = useCallback((session: SessionInfo) => {
    close();
    onSelectSession(session);
  }, [close, onSelectSession]);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    padding: "0 8px",
    border: "none",
    outline: "none",
    background: "var(--glass-bg-input)",
    color: "var(--text)",
    fontSize: 12,
  };

  const resultsPanel = (results: SearchHit[] | null, indexing: boolean) => (
    <div
      ref={panelRef}
      className="glass-top-panel"
      style={{
        overflow: "hidden",
        maxHeight: "min(420px, 60vh)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {indexing ? (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
          {t("search.indexing")}
        </div>
      ) : results === null || results.length === 0 ? (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--text-muted)" }}>
          {query.trim() ? t("search.noResults") : t("search.empty")}
        </div>
      ) : (
        <div style={{ overflowY: "auto" }}>
          {results.map((hit) => {
            const s = hit.session;
            const title = s.name || s.firstMessage.slice(0, 50) || s.id.slice(0, 12);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handlePick(s)}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "8px 12px",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {hit.titleMatch && (
                    <span
                      style={{
                        flexShrink: 0, fontSize: 9, fontFamily: "var(--font-mono)",
                        color: "var(--accent)", background: "var(--side-selected)",
                        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
                        borderRadius: 3, padding: "0 4px", lineHeight: "15px",
                      }}
                    >
                      {t("search.title")}
                    </span>
                  )}
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500 }}>
                    {title}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {s.cwd.split(/[\\/]/).filter(Boolean).pop()}
                  </span>
                </div>
                {hit.snippet && (
                  <div style={{ marginTop: 3, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {renderSnippet(hit.snippet)}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div data-mobile-search style={{ height: "100%", display: "flex", alignItems: "stretch", position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setMobileOverlay((v) => !v)}
          title={t("search.placeholder")}
          aria-label={t("search.placeholder")}
          aria-expanded={mobileOverlay}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: "100%", padding: 0,
            background: mobileOverlay ? "var(--bg-selected)" : "none",
            border: "none", borderRight: "1px solid var(--border)",
            color: mobileOverlay ? "var(--text)" : "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
        {mobileOverlay && createPortal(
          <div
            style={{
              position: "fixed",
              top: 0, left: 0, right: 0,
              zIndex: 480,
              background: "var(--frame-glass)",
              backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              WebkitBackdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))",
              borderBottom: "1px solid var(--border)",
              boxShadow: "0 10px 28px rgba(0,0,0,0.14)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={mobileInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("search.placeholder")}
                style={{ ...inputStyle, flex: 1, background: "transparent" }}
              />
              <button
                type="button"
                onClick={close}
                style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "4px 6px" }}
              >
                {t("sidebar.cancel")}
              </button>
            </div>
            {query.trim() && resultsPanel(results, indexing)}
          </div>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <>
      <div
        ref={inputRef}
      onMouseEnter={(e) => {
        if (!open) {
          e.currentTarget.style.background = "var(--bg-hover)";
          e.currentTarget.style.color = "var(--text)";
        }
      }}
      onMouseLeave={(e) => {
        if (!open) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-muted)";
        }
      }}
      style={{
        position: "relative",
        height: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexShrink: 0,
        width: 190,
        padding: "0 12px",
        borderRight: "1px solid var(--border)",
        background: open ? "var(--bg-selected)" : "transparent",
        color: open ? "var(--text)" : "var(--text-muted)",
        cursor: "text",
        transition: "background 0.12s, color 0.12s",
      }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        value={query}
        onChange={(e) => { setQuery(e.target.value); setResults(null); }}
        onFocus={() => setOpen(true)}
        placeholder={t("search.placeholder")}
        style={{ flex: 1, minWidth: 0, height: "100%", padding: 0, border: "none", outline: "none", background: "transparent", color: "inherit", fontSize: 12 }}
      />
      </div>
      {open && pos && createPortal(
        <div style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, zIndex: 520 }}>
          {resultsPanel(results, indexing)}
        </div>,
        document.body,
      )}
    </>
  );
}