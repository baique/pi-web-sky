import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { sessionTimeGroup } = await jiti.import("./session-time-group.ts");

/** 2026-06-10 是周三；用它当"现在"可以同时覆盖昨天/本周/近一月/更久。 */
const now = new Date(2026, 5, 10, 15, 0, 0).getTime();
const at = (...args) => new Date(...args).getTime();

test("按日历天分今天/昨天，而不是按 24 小时窗口", () => {
  assert.equal(sessionTimeGroup(at(2026, 5, 10, 0, 0, 0), now), "today");
  assert.equal(sessionTimeGroup(at(2026, 5, 9, 23, 59, 0), now), "yesterday");
  // 只是 16 小时前，但已经跨过零点 → 属于昨天
  assert.equal(sessionTimeGroup(at(2026, 5, 9, 23, 0, 0), now), "yesterday");
});

test("本周从周一起算，且不吞掉昨天", () => {
  assert.equal(sessionTimeGroup(at(2026, 5, 8, 10, 0, 0), now), "thisWeek"); // 周一
  assert.equal(sessionTimeGroup(at(2026, 5, 7, 10, 0, 0), now), "thisMonth"); // 上周日
});

test("周一当天本周为空：周日的会话算昨天", () => {
  const monday = new Date(2026, 5, 8, 9, 0, 0).getTime();
  assert.equal(sessionTimeGroup(at(2026, 5, 7, 20, 0, 0), monday), "yesterday");
  assert.equal(sessionTimeGroup(at(2026, 5, 6, 20, 0, 0), monday), "thisMonth");
});

test("近一月是滚动 30 天，第 31 天落到更久之前", () => {
  assert.equal(sessionTimeGroup(at(2026, 4, 12, 9, 0, 0), now), "thisMonth"); // 29 天前
  assert.equal(sessionTimeGroup(at(2026, 4, 11, 9, 0, 0), now), "older"); // 30 天前
});

test("无法解析的时间按更久之前处理", () => {
  assert.equal(sessionTimeGroup("not-a-date", now), "older");
  assert.equal(sessionTimeGroup(new Date(2026, 5, 10, 15).toISOString(), now), "today");
});
