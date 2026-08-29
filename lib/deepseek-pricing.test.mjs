import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { isDeepSeekPeak, nextDeepSeekSwitch, beijingTime } = await jiti.import("./deepseek-pricing.ts");

/** 用北京时间构造 UTC 时刻：北京 2026-08-26 09:30 → 传对应 UTC 的 Date */
function beijingDate(y, mo, d, h, mi = 0) {
  const utc = Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600_000;
  return new Date(utc);
}

// 2026-08-24 是周一，08-30 是周日
test("工作日高峰时段判峰", () => {
  // 周一 09:00 边界：峰窗开始
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 9, 0)), true);
  // 周一 10:00 峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 10, 0)), true);
  // 周一 11:59 峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 11, 59)), true);
  // 周一 12:00 边界：峰窗结束，转谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 12, 0)), false);
  // 周一 14:00 第二峰窗开始
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 14, 0)), true);
  // 周一 17:59 峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 17, 59)), true);
  // 周一 18:00 转谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 18, 0)), false);
  // 周一 00:00 谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 0, 0)), false);
  // 周一 08:00 谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 8, 0)), false);
  // 周一 23:00 谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 23, 0)), false);
});

test("周末全天谷价（含原本 UTC 峰窗时刻）", () => {
  // 周六 10:00 —— 旧逻辑（UTC 02:00 峰窗内）会误判峰，现在必须为谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 29, 10, 0)), false);
  // 周六 16:00 —— 旧逻辑（UTC 08:00 峰窗内）误判峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 29, 16, 0)), false);
  // 周日 09:30 —— 旧逻辑（UTC 01:30 峰窗内）误判峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 30, 9, 30)), false);
  // 周日 23:00 谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 30, 23, 0)), false);
  // 周六 00:00 谷
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 29, 0, 0)), false);
});

test("UTC 周末边界不错位（北京时刻与 UTC 星期可能不一致）", () => {
  // 北京周六 08:00，对应 UTC 周六 00:00（day 6）：必须判谷
  const saturdayEarly = beijingDate(2026, 8, 29, 8, 0);
  assert.equal(saturdayEarly.getUTCDay(), 6); // 确认 UTC 星期六
  assert.equal(isDeepSeekPeak(saturdayEarly), false);
  // 北京周六 00:00，对应 UTC 周五 16:00（day 5）：UTC 是周五傍晚，但北京已是周六，必须判谷
  const utcFridayEvening = beijingDate(2026, 8, 29, 0, 0);
  assert.equal(utcFridayEvening.getUTCDay(), 5); // 确认 UTC 星期五
  assert.equal(isDeepSeekPeak(utcFridayEvening), false);
  // 北京周一 01:00，对应 UTC 周日 17:00：必须判谷（UTC 周日，非工作日）
  const mondayEarly = beijingDate(2026, 8, 24, 1, 0);
  assert.equal(mondayEarly.getUTCDay(), 0); // UTC 周日
  assert.equal(isDeepSeekPeak(mondayEarly), false);
  // 北京周一 09:00 对应 UTC 周一 01:00：峰
  assert.equal(isDeepSeekPeak(beijingDate(2026, 8, 24, 9, 0)), true);
});

test("工作日 nextSwitch：峰时 → 峰窗结束转谷", () => {
  // 周一 10:00 峰 → 12:00 转谷
  const s1 = nextDeepSeekSwitch(beijingDate(2026, 8, 24, 10, 0));
  assert.equal(beijingTime(s1).getUTCDate(), 24);
  assert.equal(beijingTime(s1).getUTCHours(), 12);
  // 周一 13:00 谷 → 14:00 转峰
  const s2 = nextDeepSeekSwitch(beijingDate(2026, 8, 24, 13, 0));
  assert.equal(beijingTime(s2).getUTCHours(), 14);
  // 周一 17:59 峰 → 18:00 转谷
  const s3 = nextDeepSeekSwitch(beijingDate(2026, 8, 24, 17, 59));
  assert.equal(beijingTime(s3).getUTCHours(), 18);
  // 周一 23:00 谷 → 周二 09:00 转峰
  const s4 = nextDeepSeekSwitch(beijingDate(2026, 8, 24, 23, 0));
  assert.equal(beijingTime(s4).getUTCDate(), 25);
  assert.equal(beijingTime(s4).getUTCHours(), 9);
});

test("跨周末 nextSwitch：周五晚起全程谷，跳到周一 09:00 转峰", () => {
  // 周五 17:00 峰 → 当天 18:00 转谷
  const fridayPeak = nextDeepSeekSwitch(beijingDate(2026, 8, 28, 17, 0));
  assert.equal(beijingTime(fridayPeak).getUTCDate(), 28);
  assert.equal(beijingTime(fridayPeak).getUTCHours(), 18);
  // 周五 20:00 谷 → 跳过周六周日 → 周一(8/31) 09:00 转峰
  const fridayNight = nextDeepSeekSwitch(beijingDate(2026, 8, 28, 20, 0));
  assert.equal(beijingTime(fridayNight).getUTCDate(), 31);
  assert.equal(beijingTime(fridayNight).getUTCDay(), 1); // 周一
  assert.equal(beijingTime(fridayNight).getUTCHours(), 9);
  // 周六 10:00 谷 → 周一 09:00 转峰（旧实现会错误返回周六 09:00 或 14:00 转峰）
  const saturday = nextDeepSeekSwitch(beijingDate(2026, 8, 29, 10, 0));
  assert.equal(beijingTime(saturday).getUTCDate(), 31);
  assert.equal(beijingTime(saturday).getUTCHours(), 9);
  // 周日 15:00 谷 → 周一 09:00 转峰
  const sunday = nextDeepSeekSwitch(beijingDate(2026, 8, 30, 15, 0));
  assert.equal(beijingTime(sunday).getUTCDate(), 31);
  assert.equal(beijingTime(sunday).getUTCHours(), 9);
  // 周日 23:00 谷 → 周一 09:00 转峰
  const sundayLate = nextDeepSeekSwitch(beijingDate(2026, 8, 30, 23, 0));
  assert.equal(beijingTime(sundayLate).getUTCDate(), 31);
  assert.equal(beijingTime(sundayLate).getUTCHours(), 9);
});

test("周五晚上正是峰时与谷时边界（北京 18:00 整点翻转）", () => {
  // 周五 17:59:59 → 18:00 转谷
  const before = nextDeepSeekSwitch(beijingDate(2026, 8, 28, 17, 59));
  assert.equal(beijingTime(before).getUTCHours(), 18);
  // 周五 18:00:00 整 → 已转谷，下一个切换是周一 09:00
  const onBoundary = nextDeepSeekSwitch(beijingDate(2026, 8, 28, 18, 0));
  assert.equal(beijingTime(onBoundary).getUTCDate(), 31);
  assert.equal(beijingTime(onBoundary).getUTCHours(), 9);
});
