"use client";

import { useI18n } from "@/hooks/useI18n";

export type SidebarTab = "sessions" | "files";

interface Props {
  active: SidebarTab;
  onChange: (tab: SidebarTab) => void;
}

/**
 * Segmented pill switch between the sidebar's two views (sessions / files),
 * sitting directly below the path selector.
 */
export function SessionTabs({ active, onChange }: Props) {
  const { t } = useI18n();
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
        gap: 2,
        padding: 2,
        background: "var(--side-input)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        margin: "0 10px 8px",
        flexShrink: 0,
      }}
    >
      {tabs.map(({ key, label, icon }) => {
        const selected = active === key;
        return (
          <button
            key={key}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(key)}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              height: 26,
              padding: 0,
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: selected ? 600 : 400,
              color: selected ? "var(--accent)" : "var(--text-muted)",
              background: selected ? "var(--side-selected)" : "transparent",
              transition: "background 0.12s, color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (!selected) {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text)";
              }
            }}
            onMouseLeave={(e) => {
              if (!selected) {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "var(--text-muted)";
              }
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