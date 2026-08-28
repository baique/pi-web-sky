"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

export type SidebarTab = "sessions" | "files";

interface Props {
  active: SidebarTab;
  onChange: (tab: SidebarTab) => void;
}

/**
 * Underline tabs between the path selector and the sidebar content. No
 * floating container: one hairline runs across the row and the active tab
 * paints its own 2px accent line over it. Hover is React-state driven (no
 * manual style writes — those survive re-renders and leak stale colors).
 */
export function SessionTabs({ active, onChange }: Props) {
  const { t } = useI18n();
  const [hoveredTab, setHoveredTab] = useState<SidebarTab | null>(null);
  const tabs: { key: SidebarTab; label: string; icon: React.ReactNode }[] = [
    {
      key: "sessions",
      label: t("sidebar.sessionTab"),
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
    },
    {
      key: "files",
      label: t("sidebar.filesTab"),
      icon: (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      ),
    },
  ];

  return (
    <div
      role="tablist"
      aria-label={t("sidebar.views")}
      style={{
        display: "flex",
        flex: "0 0 auto",
        minWidth: 0,
        borderBottom: "1px solid color-mix(in srgb, var(--border) 55%, transparent)",
      }}
    >
      {tabs.map(({ key, label, icon }) => {
        const selected = active === key;
        const hovered = !selected && hoveredTab === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(key)}
            onMouseEnter={() => setHoveredTab(key)}
            onMouseLeave={() => setHoveredTab(null)}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: 32,
              padding: 0,
              border: "none",
              borderBottom: selected ? "2px solid var(--accent)" : "2px solid transparent",
              marginBottom: -1,
              background: hovered ? "var(--side-hover)" : "transparent",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: selected ? 600 : 400,
              color: selected ? "var(--accent)" : hovered ? "var(--text)" : "var(--text-muted)",
              transition: "color 0.12s, background 0.12s",
            }}
          >
            {icon}
            {label}
          </button>
        );
      })}
    </div>
  );
}