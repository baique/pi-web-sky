import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionWorkbench.tsx", import.meta.url), "utf8");

// wheel 拦截是本组件里唯一的手写手势判定：无条件 stopPropagation（ctrl/meta 除外）。
// 曾经的「目标在可滚动容器内才拦」判定，让输入框内容不足（无滚动条）时滚轮漏给画布缩放。
const stopHandler = source.match(/const stop = \(e: WheelEvent\) => \{[\s\S]*?\n    \};/)?.[0];

test("stops wheel at the workbench root without an inner-scrollability condition", () => {
  assert.ok(stopHandler, "wheel handler not found");
  assert.match(stopHandler, /e\.stopPropagation\(\);/);
  assert.doesNotMatch(stopHandler, /scrollHeight|hasScrollableAncestor/);
  assert.doesNotMatch(source, /hasScrollableAncestor/);
});

test("keeps ctrl/meta+wheel for canvas zoom", () => {
  assert.match(stopHandler, /if \(e\.ctrlKey \|\| e\.metaKey\) return;/);
});
