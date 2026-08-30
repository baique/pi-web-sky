#!/usr/bin/env node
// 便笺 markdown 文本选中 vs 拖拽冲突 e2e（Node + playwright）
// 前置：30143 dev server 运行中。执行：node scripts/e2e-sticky-select.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wa/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.js");

const URL = "http://127.0.0.1:30143";

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

const browser = await chromium.launch({
  headless: true,
  executablePath: "/home/wa/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// 从 React fiber 树里找 tldraw Editor 实例
const findEditor = () => page.evaluate(() => {
  const root = document.getElementById("__next") || document.body;
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    let f = node[Object.keys(node).find((k) => k.startsWith("__reactFiber"))];
    while (f && !seen.has(f)) {
      seen.add(f);
      const memo = f.memoizedProps;
      if (memo) for (const k of Object.keys(memo)) {
        const v = memo[k];
        if (v && typeof v === "object" && typeof v.setEditingShape === "function") return true;
      }
      f = f.return;
    }
    for (const c of node.children || []) stack.push(c);
  }
  return null;
});

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  // 1. 进入项目看板
  const anyRow = page.locator("[data-board-row]").first();
  for (let i = 0; i < 40 && (await anyRow.count()) === 0; i++) await page.waitForTimeout(500);
  if (await anyRow.count() === 0) { check("no board row", false); throw new Error("no board"); }
  await anyRow.click();
  await page.waitForTimeout(4000);
  check("board mode entered", (await page.locator(".tl-container").count()) === 1);
  check("editor accessible", !!(await findEditor()));

  // 2. 用 editor API 在视口中心创建便笺（等价工具栏创建，稳定可定位）
  const noteId = await page.evaluate(() => {
    const root = document.getElementById("__next") || document.body;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      let f = node[Object.keys(node).find((k) => k.startsWith("__reactFiber"))];
      while (f && !seen.has(f)) {
        seen.add(f);
        const memo = f.memoizedProps;
        if (memo) for (const k of Object.keys(memo)) {
          const v = memo[k];
          if (v && typeof v === "object" && typeof v.setEditingShape === "function") {
            const id = "shape:e2e-note-" + Date.now();
            v.createShape({ id, type: "sticky-note", x: 500, y: 250 });
            v.setEditingShape(null);
            v.selectNone();
            return id;
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return null;
  });
  check("note created", !!noteId);
  await page.waitForTimeout(1200);
  const note = page.locator(`[data-testid="sticky-note-${noteId}"]`);
  check("note rendered", (await note.count()) === 1);

  // 3. 双击占位 → 编辑态
  const hint = note.locator("text=双击编辑 markdown");
  await hint.waitFor({ timeout: 5000 });
  const hb = await hint.boundingBox();
  await page.mouse.dblclick(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForTimeout(600);
  const ta = note.locator("textarea");
  check("double click enters edit", (await ta.count()) === 1);

  // 4. 输入 markdown 内容并提交（Ctrl+Enter）
  if (await ta.count() > 0) {
    await ta.fill("Hello **world** markdown");
    await ta.press("Control+Enter");
    await page.waitForTimeout(600);
    check("edit committed", (await note.locator("textarea").count()) === 0);
    const mdText = await note.locator(".markdown-body").innerText();
    check("markdown rendered", mdText.includes("Hello") && mdText.includes("world"), `text="${mdText.slice(0, 30)}"`);
  }

  // 5. 文本拖动选字（核心回归）：便笺位置不得变化
  const md = note.locator(".markdown-body");
  const mdBox = await md.boundingBox();
  check("markdown-body visible", !!mdBox);
  const before = await note.boundingBox();
  if (mdBox) {
    await page.mouse.move(mdBox.x + 16, mdBox.y + 12);
    await page.mouse.down();
    await page.mouse.move(mdBox.x + 16 + 90, mdBox.y + 12, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const sel = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    check("text selection on drag", sel.length > 0, `sel="${sel.slice(0, 30)}"`);
    const after = await note.boundingBox();
    const dx = Math.abs(after.x - before.x), dy = Math.abs(after.y - before.y);
    check("note did not move during text drag", dx < 1 && dy < 1, `dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
  }

  // 6. 单击内容 → 选中（随后 Delete 删除成功 = 选中证据）
  if (mdBox) {
    await page.mouse.click(mdBox.x + 16, mdBox.y + 12);
    await page.waitForTimeout(300);
    const selAfter = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    check("click clears text selection", selAfter.length === 0, `sel="${selAfter.slice(0, 20)}"`);
  }

  // 7. 双击内容 → 再次进入编辑态（markdown 渲染态的双击）
  await page.mouse.dblclick(mdBox.x + 16, mdBox.y + 12);
  await page.waitForTimeout(600);
  check("double click on markdown re-enters edit", (await note.locator("textarea").count()) === 1);
  await note.locator("textarea").press("Escape");
  await page.waitForTimeout(300);

  // 8. 便笺内空白区（markdown-body 外）拖动 → 移动便笺
  const body = await note.boundingBox();
  const padX = body.x + body.width - 14;
  const padY = body.y + body.height / 2;
  await page.mouse.move(padX, padY);
  await page.mouse.down();
  await page.mouse.move(padX + 70, padY + 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const moved = await note.boundingBox();
  const ddx = Math.abs(moved.x - before.x), ddy = Math.abs(moved.y - before.y);
  check("blank-area drag moves note", ddx > 50 || ddy > 30, `dx=${ddx.toFixed(1)} dy=${ddy.toFixed(1)}`);

  // 9. 单击内容选中 → Delete 删除（清理）
  const mdBox3 = await md.boundingBox();
  await page.mouse.click(mdBox3.x + 16, mdBox3.y + 12);
  await page.waitForTimeout(300);
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
  check("note deleted via Delete", (await note.count()) === 0);
} catch (e) {
  console.error("FATAL", e?.message ?? e);
  fail++;
} finally {
  if (errors.length) {
    console.log(`\nPage errors (${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  }
  await browser.close();
  console.log(`\n=== ${pass} pass, ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
}
