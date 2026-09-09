/**
 * 看板卡底栏时间展示（会话卡/任务卡/便笺统一）。
 *
 * 规则（与会话卡一致）：当天仅显示时:分，跨天显示 月/日 + 时:分。
 */

export function formatCardTime(ts: number): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
