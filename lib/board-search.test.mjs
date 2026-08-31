import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { collectSearchable, filterMatches, makeSnippet } = await jiti.import("./board-search.ts");

/** 构造 fake tldraw editor（单测只依赖 getCurrentPageShapes/getShape/getShapePageBounds） */
function fakeEditor(shapes) {
  return {
    getCurrentPageShapes: () => shapes,
    getShape: (id) => shapes.find((s) => s.id === id),
    getShapePageBounds: (id) => {
      const s = shapes.find((x) => x.id === id);
      return s ? { x: s.x ?? 0, y: s.y ?? 0, w: s.w ?? 100, h: s.h ?? 100 } : undefined;
    },
  };
}

const shape = (id, type, props) => ({ id, type, props });

test("collectSearchable 收集会话卡标题 + 便笺正文，跳过空文本与无关 shape", () => {
  const editor = fakeEditor([
    shape("shape:a", "session-card", { title: "登录重构", sessionId: "s1" }),
    shape("shape:b", "session-card", { title: "   ", sessionId: "s2" }), // 空标题跳过
    shape("shape:c", "sticky-note", { text: "便笺：token 校验" }),
    shape("shape:d", "sticky-note", { text: "" }), // 空便笺跳过
    shape("shape:e", "arrow", { label: "不能搜连线" }), // 无关 type 跳过
    shape("shape:f", "text", { text: "普通文本不搜" }), // 无关 type 跳过
  ]);
  const items = collectSearchable(editor);
  assert.deepEqual(items.map((i) => i.field), ["title", "note"]);
  assert.deepEqual(items.map((i) => i.text), ["登录重构", "便笺：token 校验"]);
  assert.deepEqual(items.map((i) => i.kind), ["session-card", "sticky-note"]);
});

test("filterMatches 中文子串命中", () => {
  const editor = fakeEditor([
    shape("a", "session-card", { title: "修复登录接口的 bug" }),
    shape("b", "sticky-note", { text: "记录 token 过期逻辑" }),
  ]);
  const items = collectSearchable(editor);
  const hits = filterMatches(items, "登录");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].item.shapeId, "a");
});

test("filterMatches 大小写不敏感（英文）", () => {
  const editor = fakeEditor([
    shape("a", "session-card", { title: "Refactor Token Logic" }),
    shape("b", "sticky-note", { text: "another note" }),
  ]);
  const items = collectSearchable(editor);
  assert.equal(filterMatches(items, "token").length, 1);
  assert.equal(filterMatches(items, "TOKEN").length, 1);
  assert.equal(filterMatches(items, "Token").length, 1);
  assert.equal(filterMatches(items, "tokenz").length, 0);
});

test("filterMatches 空 query 返回空", () => {
  const editor = fakeEditor([shape("a", "session-card", { title: "anything" })]);
  const items = collectSearchable(editor);
  assert.equal(filterMatches(items, "").length, 0);
  assert.equal(filterMatches(items, "   ").length, 0);
});

test("filterMatches 多命中保持画布遍历顺序", () => {
  const editor = fakeEditor([
    shape("a", "sticky-note", { text: "zzz 搜索 zzz" }),
    shape("b", "session-card", { title: "aaa 搜索 bbb" }),
    shape("c", "sticky-note", { text: "搜索收尾" }),
  ]);
  const items = collectSearchable(editor);
  const hits = filterMatches(items, "搜索");
  assert.deepEqual(hits.map((h) => h.item.shapeId), ["a", "b", "c"]);
});

test("makeSnippet 命中居中截断 + 两端省略号", () => {
  const long = "这是一段很长的便笺文本，中间藏着关键词，后面还有更多内容需要被截断显示以便下拉列表保持整洁。";
  const s = makeSnippet(long, "关键词", 20);
  assert.ok(s.includes("关键词"), `snippet should contain the hit: ${s}`);
  assert.ok(s.startsWith("…"), "head ellipsis");
  assert.ok(s.endsWith("…"), "tail ellipsis");
  assert.ok(s.length <= 24, `bounded length: ${s.length}`);
});

test("makeSnippet 无命中时首段截断", () => {
  const short = "hello";
  assert.equal(makeSnippet(short, "zzz"), "hello");
  const long = "x".repeat(100);
  const s = makeSnippet(long, "zzz");
  assert.equal(s, `${"x".repeat(44)}…`);
});
