#!/usr/bin/env node
// 看板搜索定位 e2e：进看板 → Ctrl+F 聚焦搜索框 → 输入命中词 → 下拉出现 →
// 点击命中 → zoomToBounds 被调用 + 卡片 accent 高亮 → 无命中空态 → Esc 关闭
// 前置：30143 dev server 运行中（含本功能代码）。执行：node scripts/e2e-board-search.mjs
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

const api = async (p, init) => {
  const res = await page.request.fetch(`${URL}${p}`, init ?? {});
  return { status: res.status(), body: await res.json().catch(() => null) };
};

let taskId = null;
let boardExistedBefore = false;

try {
  // 0. 数据准备：找一个有会话的任务（看板懒创建，测试后删除）
  const t0 = await api("/api/tasks?projectKey=" + encodeURIComponent("/home/wa/project/pi-web-sky"));
  const tasks = t0.body.tasks ?? [];
  const task = tasks.find((x) => (x.sessionIds?.length ?? 0) > 0) ?? tasks[0];
  check("found a task with sessions", !!task, task?.name);
  if (!task) throw new Error("no task available");
  taskId = task.id;
  const b0 = await api(`/api/boards/${encodeURIComponent(taskId)}`);
  boardExistedBefore = b0.status === 200 && !!b0.body?.board;

  // 1. 打开应用，进入任务看板
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const taskRow = page.locator(`text=${task.name}`).first();
  await taskRow.waitFor({ timeout: 8000 });
  await taskRow.hover();
  await page.waitForTimeout(300);
  const boardBtn = page.locator('button[title="打开看板"], button[title="Open board"]').first();
  await boardBtn.click();
  await page.waitForTimeout(2000);

  // 2. 搜索框常驻渲染 + 画布出现会话卡
  const searchBox = page.locator("[data-testid=board-search] input");
  await searchBox.waitFor({ timeout: 8000 });
  check("search box rendered (top of canvas)", await searchBox.count() > 0);
  await page.waitForTimeout(2500); // 等摘要 + 自动补卡

  // 3. Ctrl+F 聚焦搜索框（仅看板模式）
  await page.keyboard.press("Control+f");
  await page.waitForTimeout(200);
  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
  check("Ctrl+F focuses search input", activeTag === "INPUT", `active=${activeTag}`);

  // 4. 浏览器端一次性：找 editor → 数卡片 → 拿第一张卡标题 + 包装 zoomToBounds spy
  const probe = await page.evaluate(() => {
    const root = document.getElementById("__next") || document.body;
    const stack = [root];
    const seen = new Set();
    let editor = null;
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      let f = node[Object.keys(node).find((k) => k.startsWith("__reactFiber"))];
      while (f && !seen.has(f)) {
        seen.add(f);
        const memo = f.memoizedProps;
        if (memo) for (const k of Object.keys(memo)) {
          const v = memo[k];
          if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function" && typeof v.zoomToBounds === "function") {
            editor = v;
            break;
          }
        }
        if (editor) break;
        f = f.return;
      }
      if (editor) break;
      for (const c of node.children || []) stack.push(c);
    }
    if (!editor) return { found: false };
    const cards = editor.getCurrentPageShapes().filter((s) => s.type === "session-card");
    window.__zoomCalls = 0;
    const orig = editor.zoomToBounds.bind(editor);
    editor.zoomToBounds = (...args) => { window.__zoomCalls++; return orig(...args); };
    return {
      found: true,
      cardCount: cards.length,
      firstTitle: cards[0]?.props?.title ?? "",
      cam: editor.getCamera(),
    };
  });
  check("found editor + session cards", probe.found && probe.cardCount > 0, `cards=${probe.cardCount}`);
  if (!probe.found || probe.cardCount <= 0) throw new Error("no cards to search");
  check("got a card title to search", !!probe.firstTitle, `"${probe.firstTitle.slice(0, 24)}"`);

  // 5. 输入命中词 → 下拉出现命中
  await searchBox.fill(probe.firstTitle);
  await page.waitForTimeout(300);
  const dropdown = page.locator("[data-testid=board-search-dropdown]");
  const ddVisible = await dropdown.isVisible().catch(() => false);
  check("dropdown shows on query", ddVisible);
  const itemCount = ddVisible ? await dropdown.locator("button").count() : 0;
  check("dropdown lists >=1 hit", itemCount >= 1, `hits=${itemCount}`);

  // 6. 点击第一个命中 → zoomToBounds 被调用 + 卡片 accent 高亮
  if (itemCount > 0) {
    await dropdown.locator("button").first().click();
    await page.waitForTimeout(250);
    const zoomCalls = await page.evaluate(() => window.__zoomCalls ?? 0);
    check("click hit calls zoomToBounds", zoomCalls >= 1, `calls=${zoomCalls}`);
    const highlight = await page.evaluate(() => {
      // 高亮描边挂在 HTMLContainer 渲染层（.tl-html-container）：border + box-shadow + 动画
      const els = Array.from(document.querySelectorAll('.tl-html-container'));
      for (const el of els) {
        const bs = getComputedStyle(el).boxShadow;
        if (bs.includes("0px 0px 0px 3px")) return { found: true, bs: bs.slice(0, 60), anim: getComputedStyle(el).animationName };
      }
      return { found: false, count: els.length };
    });
    check("highlight ring on matched card", highlight.found, highlight.bs ?? `containers=${highlight.count}`);
    if (highlight.found) check("glow animation running", highlight.anim === "board-search-glow", highlight.anim);
  }

  // 7. Enter 循环下一个命中（多命中时）——至少不报错且再触发一次 zoom
  if (itemCount > 1) {
    await searchBox.press("Enter");
    await page.waitForTimeout(250);
    const zoomCalls2 = await page.evaluate(() => window.__zoomCalls ?? 0);
    check("Enter cycles to next hit", zoomCalls2 >= 2, `calls=${zoomCalls2}`);
  }

  // 8. 无命中 → 空态
  await searchBox.fill("zzzz_not_exist_zzzz");
  await page.waitForTimeout(300);
  const emptyText = await dropdown.isVisible().then((v) => v ? dropdown.innerText() : "").catch(() => "");
  check("no-match shows empty state", emptyText.includes("没有匹配的节点") || /No matching/i.test(emptyText), `"${emptyText.trim()}"`);

  // 9. Esc 两步关闭：先关下拉，再清空 + 失焦
  await searchBox.press("Escape");
  await page.waitForTimeout(150);
  const ddAfterEsc1 = await dropdown.isVisible().catch(() => false);
  check("Esc first closes dropdown", !ddAfterEsc1);
  await searchBox.press("Escape");
  await page.waitForTimeout(150);
  const inputVal = await searchBox.inputValue();
  const activeAfter = await page.evaluate(() => document.activeElement?.tagName ?? "");
  check("Esc second clears + blurs", inputVal === "" && activeAfter !== "INPUT", `val="${inputVal}" active=${activeAfter}`);

} catch (e) {
  console.error("FATAL", e?.message ?? e);
  fail++;
} finally {
  // ---- 无条件还原：测试懒创建的任务看板删除 ----
  try {
    if (taskId && !boardExistedBefore) {
      const del = await page.request.delete(`${URL}/api/boards/${encodeURIComponent(taskId)}`);
      if (!del.ok) console.warn("  (delete test board failed:", del.status, ")");
      else console.log("  (deleted test-created board)");
    }
  } catch (e) {
    console.warn("  (cleanup error:", e?.message ?? e, ")");
  }
  if (errors.length) {
    console.log(`\nPage errors (${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  }
  await browser.close();
  console.log(`\n=== ${pass} pass, ${fail} fail ===`);
  process.exit(fail > 0 ? 1 : 0);
}
