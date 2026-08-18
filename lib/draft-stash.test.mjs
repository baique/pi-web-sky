import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

// Mock localStorage before importing the module-under-test.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
};

const {
  addDraft, updateDraft, removeDraft, loadDrafts, formatRelativeTime, newDraftId,
} = await jiti.import("../lib/draft-stash.ts");

test.beforeEach(() => store.clear());

test("addDraft creates an item, persists it, and sorts newest first", () => {
  const a = addDraft("第一条", 1000);
  const b = addDraft("第二条", 2000);

  const drafts = loadDrafts();
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].id, b.id);
  assert.equal(drafts[0].content, "第二条");
  assert.equal(drafts[1].content, "第一条");
  assert.equal(typeof a.id, "string");
  assert.ok(a.id.length > 0);
});

test("updateDraft rewrites content and moves the item to the top", () => {
  const a = addDraft("原始内容", 1000);
  addDraft("另一条", 2000);

  const updated = updateDraft(a.id, "编辑后的内容", 3000);
  assert.ok(updated);
  assert.equal(updated.content, "编辑后的内容");
  assert.equal(updated.updatedAt, 3000);

  const drafts = loadDrafts();
  assert.equal(drafts[0].id, a.id);
  assert.equal(drafts[0].content, "编辑后的内容");
});

test("updateDraft returns null for an unknown id", () => {
  assert.equal(updateDraft("missing-id", "x"), null);
});

test("removeDraft deletes only the target item", () => {
  const a = addDraft("第一条", 1000);
  const b = addDraft("第二条", 2000);

  removeDraft(a.id);
  const drafts = loadDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, b.id);
});

test("loadDrafts survives corrupted storage", () => {
  store.set("pi-web.drafts.v1", "{{{not json");
  assert.deepEqual(loadDrafts(), []);
});

test("loadDrafts survives non-array / malformed entries", () => {
  store.set("pi-web.drafts.v1", JSON.stringify([{ id: 1, content: "bad" }, "junk", { id: "ok", content: "fine", updatedAt: 5 }]));
  const drafts = loadDrafts();
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, "ok");
});

test("formatRelativeTime produces compact labels", () => {
  // 本地时区构造（实现按本地时间显示，断言保持一致）
  const now = new Date(2026, 7, 18, 12, 0, 0).getTime(); // 2026-08-18 12:00 本地
  assert.equal(formatRelativeTime(now - 5_000, now), "刚刚");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5分钟前");
  assert.equal(formatRelativeTime(now - 3 * 3_600_000, now), "09:00");
  assert.equal(formatRelativeTime(now - 26 * 3_600_000, now), "昨天");
  assert.equal(formatRelativeTime(new Date(2026, 7, 3, 9, 30).getTime(), now), "8月3日");
  assert.equal(formatRelativeTime(new Date(2025, 11, 25, 9, 30).getTime(), now), "2025年12月25日");
});

test("newDraftId returns unique ids", () => {
  const ids = new Set([newDraftId(), newDraftId(), newDraftId()]);
  assert.equal(ids.size, 3);
});
