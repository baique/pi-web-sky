import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { DEFAULT_EMOJI, RANDOM_EMOJIS, randomEmoji, resolveEmoji } = await jiti.import("./card-emoji.ts");

test("类别默认：会话/任务/便笺固定初始值", () => {
  assert.equal(DEFAULT_EMOJI.session, "💬");
  assert.equal(DEFAULT_EMOJI.task, "✅");
  assert.equal(DEFAULT_EMOJI.note, "📝");
});

test("resolveEmoji：用户设置优先于类别默认", () => {
  assert.equal(resolveEmoji("session", "🐱"), "🐱");
  assert.equal(resolveEmoji("task", undefined, "idle"), "✅");
  assert.equal(resolveEmoji("note", "", null), "📝");
});

test("resolveEmoji：状态跟随覆盖用户设置（会话）", () => {
  assert.equal(resolveEmoji("session", "🐱", "waiting_model"), "🤔");
  assert.equal(resolveEmoji("session", "🐱", "running_tools"), "🚀");
  assert.equal(resolveEmoji("session", "🐱", "running_command"), "🚀");
  assert.equal(resolveEmoji("session", "🐱", "waiting_input"), "⏳");
});

test("resolveEmoji：平静/终态回落用户值（会话）", () => {
  assert.equal(resolveEmoji("session", "🐱", "idle"), "🐱");
  assert.equal(resolveEmoji("session", "🐱", "just-ended"), "🐱");
  assert.equal(resolveEmoji("session", undefined, "just-ended"), "💬");
});

test("resolveEmoji：状态跟随覆盖用户设置（任务）", () => {
  assert.equal(resolveEmoji("task", "🐱", "running"), "🚀");
  assert.equal(resolveEmoji("task", "🐱", "review"), "🤔");
  assert.equal(resolveEmoji("task", "🐱", "waiting_reply"), "⏳");
  assert.equal(resolveEmoji("task", "🐱", "failed"), "😱");
});

test("resolveEmoji：任务终态回落用户值", () => {
  assert.equal(resolveEmoji("task", "🐱", "done"), "🐱");
  assert.equal(resolveEmoji("task", "🐱", "abandoned"), "🐱");
  assert.equal(resolveEmoji("task", "🐱", "not_started"), "🐱");
});

test("resolveEmoji：便笺无状态，恒用户值", () => {
  assert.equal(resolveEmoji("note", "🐱", "anything"), "🐱");
  assert.equal(resolveEmoji("note", undefined, "anything"), "📝");
});

test("随机集合：非空、元素唯一、随机结果属于集合", () => {
  assert.ok(RANDOM_EMOJIS.length >= 30, "随机集合应至少 30 个");
  assert.equal(new Set(RANDOM_EMOJIS).size, RANDOM_EMOJIS.length, "随机集合不应有重复");
  for (let i = 0; i < 50; i++) {
    assert.ok(RANDOM_EMOJIS.includes(randomEmoji()), "随机结果应在集合内");
  }
});

test("randomEmoji：排除当前值", () => {
  for (const cur of ["🚀", "🤔", "💡", "🎯"]) {
    const next = randomEmoji(cur);
    assert.notEqual(next, cur);
    assert.ok(RANDOM_EMOJIS.includes(next));
  }
});
