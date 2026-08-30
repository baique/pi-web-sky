import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
// 纯函数模块（不拉 tldraw，node 环境安全）
const { shouldRemoveEndedCard } = await jiti.import("../lib/board-utils.ts");

test("shouldRemoveEndedCard: just-ended older than 30s → remove", () => {
  const now = Date.now();
  assert.equal(shouldRemoveEndedCard("just-ended", now - 31_000, now), true);
});

test("shouldRemoveEndedCard: just-ended within 30s → keep", () => {
  const now = Date.now();
  assert.equal(shouldRemoveEndedCard("just-ended", now - 29_000, now), false);
  assert.equal(shouldRemoveEndedCard("just-ended", now - 30_000, now), false); // 边界：恰好 30s 不删
});

test("shouldRemoveEndedCard: non-just-ended → keep", () => {
  const now = Date.now();
  assert.equal(shouldRemoveEndedCard("running_tools", now - 60_000, now), false);
  assert.equal(shouldRemoveEndedCard("idle", now - 60_000, now), false);
});

test("shouldRemoveEndedCard: endedAt 0（未知）→ keep", () => {
  assert.equal(shouldRemoveEndedCard("just-ended", 0, Date.now()), false);
});

test("shouldRemoveEndedCard: 自定义窗口", () => {
  const now = Date.now();
  assert.equal(shouldRemoveEndedCard("just-ended", now - 5_000, now, 5_000), false);
  assert.equal(shouldRemoveEndedCard("just-ended", now - 5_001, now, 5_000), true);
});
