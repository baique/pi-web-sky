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

test("renders nothing when there are no drafts", () => {
  const html = renderToStaticMarkup(
    React.createElement(DraftStashList, {
      items: [],
      activeItem: null,
      onPick: () => {},
      onDelete: () => {},
      onCancelActive: () => {},
    }),
  );
  assert.equal(html, "");
});

test("renders one row per draft in given order", () => {
  const html = renderToStaticMarkup(
    React.createElement(DraftStashList, {
      items: sampleItems,
      activeItem: null,
      onPick: () => {},
      onDelete: () => {},
      onCancelActive: () => {},
    }),
  );
  assert.ok(html.includes("第一条草稿"));
  assert.ok(html.includes("第二条草稿"));
  // 每条都有回填与删除按钮（aria-label）
  assert.equal((html.match(/aria-label="回填到输入框"/g) ?? []).length, 2);
  assert.equal((html.match(/aria-label="删除草稿"/g) ?? []).length, 2);
  // 区域标注
  assert.ok(html.includes("草稿暂存区"));
});

test("renders the active-draft bar only when editing a draft", () => {
  const withoutActive = renderToStaticMarkup(
    React.createElement(DraftStashList, {
      items: sampleItems,
      activeItem: null,
      onPick: () => {},
      onDelete: () => {},
      onCancelActive: () => {},
    }),
  );
  assert.ok(!withoutActive.includes("正在编辑草稿"));

  const withActive = renderToStaticMarkup(
    React.createElement(DraftStashList, {
      items: sampleItems,
      activeItem: sampleItems[0],
      onPick: () => {},
      onDelete: () => {},
      onCancelActive: () => {},
    }),
  );
  assert.ok(withActive.includes("正在编辑草稿"));
  assert.ok(withActive.includes("取消草稿关联"));
});
