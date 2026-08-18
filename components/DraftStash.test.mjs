import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { DraftStashList } = await jiti.import("./DraftStash.tsx");

const sampleItems = [
  { id: "a", content: "第一条草稿", updatedAt: 3000 },
  { id: "b", content: "第二条草稿", updatedAt: 1000 },
];

const baseProps = {
  onPick: () => {},
  onDelete: () => {},
  onCancelActive: () => {},
  onToggle: () => {},
};

test("renders nothing when there are no drafts", () => {
  const html = renderToStaticMarkup(
    React.createElement(DraftStashList, { items: [], expanded: false, activeItem: null, ...baseProps }),
  );
  assert.equal(html, "");
});

test("collapsed: shows only the count bar, no rows", () => {
  const html = renderToStaticMarkup(
    React.createElement(DraftStashList, { items: sampleItems, expanded: false, activeItem: null, ...baseProps }),
  );
  assert.ok(html.includes("2 条草稿"));
  assert.ok(html.includes("aria-expanded=\"false\""));
  // 折叠态不渲染行内回填/删除按钮
  assert.ok(!html.includes("aria-label=\"回填到输入框\""));
  assert.ok(!html.includes("第一条草稿"));
});

test("expanded: renders one row per draft with both action buttons", () => {
  const html = renderToStaticMarkup(
    React.createElement(DraftStashList, { items: sampleItems, expanded: true, activeItem: null, ...baseProps }),
  );
  assert.ok(html.includes("2 条草稿"));
  assert.ok(html.includes("aria-expanded=\"true\""));
  assert.ok(html.includes("第一条草稿"));
  assert.ok(html.includes("第二条草稿"));
  assert.equal((html.match(/aria-label="回填到输入框"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="删除草稿"/g) ?? []).length, 2);
  assert.ok(html.includes("草稿暂存区"));
});

test("renders the active-draft bar only when editing a draft", () => {
  const withoutActive = renderToStaticMarkup(
    React.createElement(DraftStashList, { items: sampleItems, expanded: true, activeItem: null, ...baseProps }),
  );
  assert.ok(!withoutActive.includes("正在编辑草稿"));

  const withActive = renderToStaticMarkup(
    React.createElement(DraftStashList, { items: sampleItems, expanded: true, activeItem: sampleItems[0], ...baseProps }),
  );
  assert.ok(withActive.includes("正在编辑草稿"));
  assert.ok(withActive.includes("取消草稿关联"));
});
