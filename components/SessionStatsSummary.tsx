"use client";

import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 会话统计紧凑摘要：in⬆ 9k | out⬇ 9k | cache↻ 8.7M | $0.07 | 容器 27% / 1.0M。
 * 完全复刻 AppShell 顶栏 Session info 按钮的紧凑内容格式（图标 + 简化数字）。
 * 纯展示（不含 button），供统计弹层第一行等复用。tokens/cost 取 stats，context 取独立状态。
 */
export function SessionStatsSummary({
  stats,
  contextUsage,
}: {
  stats: SessionStatsInfo | null;
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null;
}) {
  if (!stats) return null;
  const tokens = stats.tokens;
  const cost = stats.cost ?? 0;

  const formatCompact = (value: number) => value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(0)}k`
      : String(value);
  const costText = cost > 0 ? (cost >= 0.01 ? `$${cost.toFixed(2)}` : `<$0.01`) : null;

  let contextColor = "var(--text-muted)";
  let desktopContextText: string | null = null;
  if (contextUsage?.contextWindow) {
    const percent = contextUsage.percent;
    if (percent !== null && percent > 90) contextColor = "#ef4444";
    else if (percent !== null && percent > 70) contextColor = "rgba(234,179,8,0.95)";
    desktopContextText = percent !== null
      ? `${percent.toFixed(0)}% / ${formatCompact(contextUsage.contextWindow)}`
      : `? / ${formatCompact(contextUsage.contextWindow)}`;
  }

  const style: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    fontSize: 11,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  };
  const spanStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 };

  return (
    <div style={style}>
      {tokens.input > 0 && (
        <span style={spanStyle}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="8.5" x2="5" y2="1.5" /><polyline points="2 4 5 1.5 8 4" />
          </svg>
          {formatCompact(tokens.input)}
        </span>
      )}
      {tokens.output > 0 && (
        <span style={spanStyle}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="5" y1="1.5" x2="5" y2="8.5" /><polyline points="2 6 5 8.5 8 6" />
          </svg>
          {formatCompact(tokens.output)}
        </span>
      )}
      {tokens.cacheRead > 0 && (
        <span style={spanStyle}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8.5 5a3.5 3.5 0 1 1-1-2.45" /><polyline points="6.5 1.5 8.5 2.5 7.5 4.5" />
          </svg>
          {formatCompact(tokens.cacheRead)}
        </span>
      )}
      {costText && (
        <span style={{ display: "flex", alignItems: "center", color: "var(--text)", fontWeight: 500, flexShrink: 0 }}>
          {costText}
        </span>
      )}
      {desktopContextText && (
        <span style={{ display: "flex", alignItems: "center", gap: 4, color: contextColor, flexShrink: 0 }}>
          <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 9 L1 5 Q1 1 5 1 Q9 1 9 5 L9 9" /><line x1="1" y1="9" x2="9" y2="9" />
          </svg>
          {desktopContextText}
        </span>
      )}
    </div>
  );
}
