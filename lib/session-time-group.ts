/**
 * 会话列表的时间分组（今天 / 昨天 / 本周 / 近一月 / 更久之前）。
 *
 * 只做分类，不排序：调用方（侧栏聊天区）已按 modified 倒序排好，
 * 这里只负责给每条会话贴上它属于哪一段。
 */
export type SessionTimeGroup = "today" | "yesterday" | "thisWeek" | "thisMonth" | "older";

/** 分组展示顺序（由近及远）。 */
export const SESSION_TIME_GROUP_ORDER: readonly SessionTimeGroup[] = [
  "today",
  "yesterday",
  "thisWeek",
  "thisMonth",
  "older",
];

/** 近一月的窗口长度（含今天），滚动 30 天而非自然月。 */
const RECENT_MONTH_DAYS = 30;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 加减自然日（走 Date，跨夏令时不会少/多一小时）。 */
function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** 本周起始（周一 00:00），与中文习惯一致。 */
function startOfWeek(ms: number): number {
  const day = new Date(ms).getDay(); // 0 = 周日
  return addDays(startOfDay(ms), -((day + 6) % 7));
}

/**
 * 判断一条会话的修改时间落在哪个时间分组。
 * @param modified 会话修改时间（ISO 字符串或毫秒时间戳）
 * @param now 当前时间（毫秒），用于测试注入
 * @returns 时间分组；时间不可解析时按「更久之前」处理
 */
export function sessionTimeGroup(modified: string | number, now: number = Date.now()): SessionTimeGroup {
  const ms = typeof modified === "number" ? modified : Date.parse(modified);
  if (!Number.isFinite(ms)) return "older";
  // 未来时间（客户端与服务端时钟漂移）归今天，别把刚写的会话沉到底部。
  if (ms >= startOfDay(now)) return "today";
  if (ms >= addDays(startOfDay(now), -1)) return "yesterday";
  if (ms >= startOfWeek(now)) return "thisWeek";
  if (ms >= addDays(startOfDay(now), -(RECENT_MONTH_DAYS - 1))) return "thisMonth";
  return "older";
}
