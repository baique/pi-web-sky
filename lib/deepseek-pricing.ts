/**
 * DeepSeek 峰谷计价规则（服务端额度展示用）。
 *
 * 官方依据：
 * - 定价页：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - 峰谷计费自 2026-08-17（北京时间 00:00）起生效；
 *   2026-08-23 起周末（周六、周日）全天按低谷价计费（官方更新日志）。
 *
 * 规则（北京时间 UTC+8）：
 * - 工作日（周一~周五）：高峰 09:00–12:00、14:00–18:00（左闭右开），其余时段谷（半价）
 * - 周末（周六~周日）：全天谷价，无峰谷切换
 *
 * 注意：判定必须统一换算到北京时间再取星期与时刻，不能用 UTC 直接判——
 * 例如北京周六 08:00 对应 UTC 周五 24:00，按 UTC 星期会被误判为工作日峰时。
 * 规则如有变动，改这里一处即可（并同步设计文档 .agent/spec/2026-08-26-quota-display-design.md）。
 */

/** 北京时区相对 UTC 的毫秒偏移（无夏令时） */
export const DS_BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 工作日高峰时段（北京时间小时，左闭右开） */
export const DS_PEAK_HOURS: readonly [number, number][] = [
  [9, 12],
  [14, 18],
];

/** 将 UTC 时刻平移为"北京时刻"：用它的 UTC getter 读取即得北京时间 */
export function beijingTime(now: Date): Date {
  return new Date(now.getTime() + DS_BEIJING_OFFSET_MS);
}

/** 北京时刻是否工作日（周一~周五）；周末返回 false（全天谷价） */
function isBeijingWeekday(bj: Date): boolean {
  const day = bj.getUTCDay(); // 0=周日 … 6=周六
  return day >= 1 && day <= 5;
}

/** 当前是否为 DeepSeek 高峰时段（周末恒为谷，返回 false） */
export function isDeepSeekPeak(now: Date): boolean {
  const bj = beijingTime(now);
  if (!isBeijingWeekday(bj)) return false;
  const h = bj.getUTCHours();
  return DS_PEAK_HOURS.some(([start, end]) => h >= start && h < end);
}

/**
 * 下一次峰谷切换时刻（切换恒发生在北京时间整点）。
 * 周末全天谷无边界：跨周末时直接跳到下一个工作日首个峰窗开始（周一 09:00）。
 */
export function nextDeepSeekSwitch(now: Date): Date {
  const candidates: number[] = [];
  // 北京视角向后看 8 天：连续两个周末最多 5 天无边界，8 天保证至少命中一个工作日
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const bj = beijingTime(now);
    bj.setUTCDate(bj.getUTCDate() + dayOffset);
    if (!isBeijingWeekday(bj)) continue;
    for (const [start, end] of DS_PEAK_HOURS) {
      for (const hour of [start, end]) {
        const bjBoundary = new Date(bj);
        bjBoundary.setUTCHours(hour, 0, 0, 0);
        const utcMs = bjBoundary.getTime() - DS_BEIJING_OFFSET_MS;
        if (utcMs > now.getTime()) candidates.push(utcMs);
      }
    }
  }
  if (candidates.length === 0) {
    // 兜底：8 天内必有工作日，正常走不到这里
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  return new Date(Math.min(...candidates));
}
