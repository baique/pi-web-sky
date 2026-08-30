import type { SessionStatsInfo } from "@/lib/pi-types";

/**
 * 会话统计行：in | out | cache read | cache write | cost | context。
 * 普通会话顶栏 Session info 按钮 tooltip 与看板统计弹层第一行共用同一格式，避免双实现。
 */
export function formatSessionStatsLine(
  stats: SessionStatsInfo | null,
  contextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | null,
  locale?: string,
): string {
  if (!stats) return "";
  const tokens = stats.tokens;
  const cost = stats.cost ?? 0;
  const parts: string[] = [];
  parts.push(`in: ${tokens.input.toLocaleString(locale)}`);
  parts.push(`out: ${tokens.output.toLocaleString(locale)}`);
  parts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
  parts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
  if (cost > 0) parts.push(`cost: $${cost.toFixed(4)}`);
  if (contextUsage?.contextWindow) {
    const percent = contextUsage.percent;
    parts.push(`context: ${percent !== null ? percent.toFixed(1) + "%" : "unknown"} of ${contextUsage.contextWindow.toLocaleString(locale)} tokens`);
  }
  return parts.join("  |  ");
}
