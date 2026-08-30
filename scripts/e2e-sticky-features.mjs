#!/usr/bin/env node
// 便笺新功能 e2e：徽记+时间 / 取消放弃变更 / 占位提示色 / 收合卡流体高度
// 前置：30143 dev server 运行中。执行：node scripts/e2e-sticky-features.mjs
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
const getEditor = () => page.evaluate(() => {
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
        if (v && typeof v === "object" && typeof v.setEditingShape === "function") return v;
      }
      f = f.return;
    }
    for (const c of node.children || []) stack.push(c);
  }
  return null;
});

const createNote = (id, x, y) => page.evaluate(({ id, x, y }) => {
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
          v.createShape({ id, type: "sticky-note", x, y });
          return true;
        }
      }
      f = f.return;
    }
    for (const c of node.children || []) stack.push(c);
  }
  return null;
}, { id, x, y });

const createCard = (id, props) => page.evaluate(({ id, props }) => {
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
          v.createShape({ id, type: "session-card", x: 200, y: 500, props });
          return true;
        }
      }
      f = f.return;
    }
    for (const c of node.children || []) stack.push(c);
  }
  return null;
}, { id, props });

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);

  // 进入项目看板
  const anyRow = page.locator("[data-board-row]").first();
  for (let i = 0; i < 40 && (await anyRow.count()) === 0; i++) await page.waitForTimeout(500);
  if (await anyRow.count() === 0) { check("no board row", false); throw new Error("no board"); }
  await anyRow.click();
  await page.waitForTimeout(4000);
  check("board mode entered", (await page.locator(".tl-container").count()) === 1);

  // ========== 1. 新建便笺 → 自动带徽记(蓝) + 时间 ==========
  const noteId = "shape:e2e-feat-" + Date.now();
  check("note created", !!(await createNote(noteId, 400, 200)));
  await page.waitForTimeout(1200);
  const note = page.locator(`[data-testid="sticky-note-${noteId}"]`);
  check("note rendered", (await note.count()) === 1);

  const badgeDot = note.locator("span[title^='徽记']");
  check("badge dot shown (default blue)", (await badgeDot.count()) === 1, `bg=${await badgeDot.evaluate((el) => getComputedStyle(el).backgroundColor)}`);
  const timeSpan = note.locator("span[style*='font-mono']");
  check("created time shown", (await timeSpan.count()) === 1 && (await timeSpan.innerText()).trim().length > 0, `time="${(await timeSpan.innerText()).trim()}"`);

  // ========== 2. 双击 → 编辑态 footer：徽记选择器 + 取消 + 完成 ==========
  const hint = note.locator("text=双击编辑 markdown");
  await hint.waitFor({ timeout: 5000 });
  const hb = await hint.boundingBox();
  await page.mouse.dblclick(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.waitForTimeout(600);
  const ta = note.locator("textarea");
  check("double click enters edit", (await ta.count()) === 1);
  const badgeBtns = note.locator("button[title^='徽记']");
  check("5 badge color buttons", (await badgeBtns.count()) === 5);
  check("cancel button present", (await note.locator("button:has-text('取消')").count()) === 1);
  check("finish button present", (await note.locator("button:has-text('完成')").count()) === 1);

  // ========== 3. 占位提示颜色（深白浅黑，遵循主题） ==========
  const phColor = await ta.evaluate((el) => getComputedStyle(el, "::placeholder").color);
  check("placeholder color themed", phColor !== "rgba(0, 0, 0, 0)" && phColor !== "", `color=${phColor}`);

  // ========== 4. 输入 + 换紫色徽记 + 完成 ==========
  await ta.fill("Hello **world**");
  await badgeBtns.nth(4).click(); // purple
  await note.locator("button:has-text('完成')").click();
  await page.waitForTimeout(600);
  check("edit committed", (await note.locator("textarea").count()) === 0);
  const mdText = await note.locator(".markdown-body").innerText();
  check("markdown rendered", mdText.includes("Hello") && mdText.includes("world"));
  const badgeBg = await note.locator("span[title^='徽记']").evaluate((el) => getComputedStyle(el).backgroundColor);
  check("badge changed to purple", badgeBg === "rgb(139, 92, 246)", `bg=${badgeBg}`);

  // ========== 5. 编辑 → 改内容 → 取消 → 内容不变 ==========
  const mdBox = await note.locator(".markdown-body").boundingBox();
  await page.mouse.dblclick(mdBox.x + 16, mdBox.y + 12);
  await page.waitForTimeout(600);
  const ta2 = note.locator("textarea");
  await ta2.fill("SHOULD NOT SAVE");
  await note.locator("button:has-text('取消')").click();
  await page.waitForTimeout(600);
  check("cancel exits edit", (await note.locator("textarea").count()) === 0);
  const mdAfter = await note.locator(".markdown-body").innerText();
  check("cancel discards changes", !mdAfter.includes("SHOULD NOT SAVE") && mdAfter.includes("Hello"), `text="${mdAfter.slice(0, 30)}"`);
  const badgeBg2 = await note.locator("span[title^='徽记']").evaluate((el) => getComputedStyle(el).backgroundColor);
  check("cancel keeps badge", badgeBg2 === "rgb(139, 92, 246)", `bg=${badgeBg2}`);

  // ========== 6. 收合卡中间区：流体高度 + 左上对齐（无 line-clamp） ==========
  const cardId = "shape:e2e-card-" + Date.now();
  check("card created", !!(await createCard(cardId, {
    sessionId: "e2e-fake-session", title: "E2E Card", projectName: "e2e", messageCount: 3,
    lastReply: "line1\nline2\nline3\nline4\nline5", phase: "idle", runningMs: 0, endedAt: 0,
    stale: false, expanded: false, w: 340, h: 160,
  })));
  await page.waitForTimeout(1200);
  const card = page.locator(`[data-testid="session-card-e2e-fake-session"]`);
  check("card rendered", (await card.count()) === 1);
  const mid = card.locator("div[style*='11.5px']").first();
  const midStyle = await mid.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { clamp: cs.webkitLineClamp, display: cs.display, align: cs.alignSelf ?? cs.textAlign, justifyContent: el.parentElement ? getComputedStyle(el.parentElement).justifyContent : "" };
  });
  check("no line-clamp (fluid height)", midStyle.clamp === "none", `clamp=${midStyle.clamp}`);
  check("top-left aligned", midStyle.justifyContent === "flex-start", `justify=${midStyle.justifyContent}`);

  // 清理
  await page.evaluate(({ id }) => {
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
          if (v && typeof v === "object" && typeof v.deleteShapes === "function") {
            v.deleteShapes([id]);
            return;
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
  }, { id: noteId });
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
