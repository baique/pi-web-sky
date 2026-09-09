/**
 * 便笺相关时间格式化（与看板卡时间展示共用）。
 */

/** 便笺默认标题：创建日期，示例 2026-01-01 12:00:11 */
export function formatNoteDefaultTitle(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
