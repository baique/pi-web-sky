#!/usr/bin/env node
// 任务即看板 e2e：点任务行进看板 → 会话自动成卡 → 拖拽 → 刷新坐标不丢 → 手动看板区不显示任务型看板
// 前置：30143 dev server 运行中（含本功能代码）。执行：node scripts/e2e-taskboards.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wa/.npm/_npx/9833c18b2d85bc59/node_modules/playwright/index.js");

const URL = "http://127.0.0.1:30143";
const PROJECT = "/home/wa/project/pi-web-sky";

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

// playwright request.fetch 用 data 传 JSON body（body 会被当 raw text）
const apiPatch = async (p, data) => {
  const res = await page.request.fetch(`${URL}${p}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    data,
  });
  const body = await res.json().catch(() => null);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`PATCH ${p} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status(), body };
};

// 测试数据快照：开始时记录，finally 里无条件还原，杜绝污染
let originalSessionIds = [];       // 任务初始会话
let originalCanvas = null;         // 看板初始整张画布（看板原本存在时）
let boardExistedBefore = false;    // 测试前看板是否已存在
let taskId = null;

try {
  // 0. 数据准备：确认 bug 任务存在，记录其会话数
  const t0 = await api(`/api/tasks?projectKey=${encodeURIComponent(PROJECT)}`);
  const task = t0.body.tasks.find((x) => x.name === "bug") ?? t0.body.tasks[0];
  check("found a task to test", !!task, task?.name);
  if (!task) throw new Error("no task available");
  taskId = task.id;
  originalSessionIds = [...task.sessionIds];
  const beforeCount = task.sessionIds.length;
  console.log(`  task "${task.name}" (${taskId}) has ${beforeCount} sessions`);

  // 看板是否已存在（懒创建）：已存在 → 测试后还原画布；不存在 → 测试后删除
  const b0 = await api(`/api/boards/${encodeURIComponent(taskId)}`);
  boardExistedBefore = b0.status === 200 && !!b0.body?.board;

  // 1. 打开应用，进入会话 tab（默认），等待侧栏任务渲染
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // 找任务行：侧栏任务区的标题文本
  const taskRow = page.locator(`text=${task.name}`).first();
  await taskRow.waitFor({ timeout: 8000 });
  const rowBox = await taskRow.boundingBox();
  check("task row visible", !!rowBox, `${task.name}`);

  // 2. 交互：单击展开/收起会话列表；hover 操作行的「看板」按钮进入看板
  // 2a. 单击 → 展开任务内会话列表（任务内第一个会话标题出现）
  const sessionsFull = await api("/api/sessions");
  const firstSession = sessionsFull.body.sessions.find((s) => task.sessionIds.includes(s.id));
  const firstSessionTitle = (firstSession?.name ?? firstSession?.firstMessage ?? "").trim().slice(0, 15);
  const sessionNameVisible = () =>
    firstSessionTitle ? page.locator(`text=${firstSessionTitle}`).first().isVisible().catch(() => false) : Promise.resolve(false);
  const visibleBefore = await sessionNameVisible();
  await taskRow.click();
  await page.waitForTimeout(600);
  const visibleAfter = await sessionNameVisible();
  // 单击 = 切换展开/收起：可见性必须翻转（任务可能因选中会话自动展开，方向不定）
  check("single click toggles task sessions", visibleBefore !== visibleAfter, `"${firstSessionTitle}" ${visibleBefore ? "expanded→collapsed" : "collapsed→expanded"}`);

  // 2b. hover 任务行 → 点「看板」按钮 → 进入看板模式（URL ?board=<taskId>）
  await taskRow.hover();
  await page.waitForTimeout(300);
  const boardBtn = page.locator('button[title="打开看板"], button[title="Open board"]').first();
  const btnCount = await boardBtn.count();
  check("board button visible on hover", btnCount > 0, `buttons=${btnCount}`);
  await boardBtn.click();
  await page.waitForTimeout(1800);
  const rawUrl = page.url();
  const boardParam = rawUrl.includes("?board=")
    ? decodeURIComponent(rawUrl.split("?board=")[1].split("&")[0])
    : null;
  check("board button opens board mode (?board=)", boardParam === taskId, `board=${boardParam}`);

  // 看板已打开（懒创建生效）→ 记录原始画布快照，供 finally 还原
  const canvasRes = await api(`/api/boards/${encodeURIComponent(taskId)}/canvas`);
  if (canvasRes.status === 200 && canvasRes.body) {
    originalCanvas = canvasRes.body;
  }

  // 2c. 任务行选中态与看板条目一致（--side-active 背景）
  await page.waitForTimeout(500);
  const taskRowActive = await taskRow.evaluate((el) => {
    // 任务行标题的父容器 header 背景
    const header = el.closest('[style*="min-height: 38px"]') ?? el.parentElement;
    const bg = header ? getComputedStyle(header).backgroundColor : "";
    return bg;
  });
  check("task row active when board open", taskRowActive && taskRowActive !== "rgba(0, 0, 0, 0)" && taskRowActive !== "transparent", `bg=${taskRowActive}`);

  // 3. 看板内自动出现任务会话卡片（session-card）
  await page.waitForTimeout(3000); // 等摘要 + 自动补卡轮询
  const cardTitles = await page.evaluate(() => {
    const out = [];
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c.getAttribute?.("data-shape-type") === "session-card" || (c.className?.includes?.("session-card") && !c.className.includes("tl-"))) {
          out.push(c.textContent?.slice(0, 40) ?? "");
        }
        walk(c);
      }
    };
    walk(document.getElementById("__next") || document.body);
    return out;
  });
  check("session cards auto-added", cardTitles.length >= beforeCount, `${cardTitles.length} cards (task has ${beforeCount})`);
  console.log("  cards:", JSON.stringify(cardTitles.slice(0, 5), null, 0));

  // 4. 手动看板区（侧栏 UI）不显示任务型看板：DOM 里无 data-board-row=<taskId>
  await page.waitForTimeout(500);
  const taskBoardRowInDom = await page.locator(`[data-board-row="${taskId}"]`).count();
  check("task board row NOT rendered in sidebar boards", taskBoardRowInDom === 0, `rows=${taskBoardRowInDom}`);

  // 5. 坐标持久化：拖拽第一张卡片 → 刷新 → 位置保持
  //    用 editor API 读取/移动（比鼠标拖更稳定）
  const moveResult = await page.evaluate(() => {
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
          if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function" && typeof v.updateShapes === "function") {
            const cards = v.getCurrentPageShapes().filter((s) => s.type === "session-card");
            if (cards.length > 0) {
              const id = cards[0].id;
              v.updateShapes([{ id, type: "session-card", x: 800, y: 500 }]);
              return { moved: true, id, count: cards.length };
            }
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return { moved: false, count: 0 };
  });
  check("moved first card via editor", moveResult.moved, `count=${moveResult.count}`);
  await page.waitForTimeout(1200); // 等防抖保存

  // 刷新 → 重新进入任务看板
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // 刷新后 URL 仍带 ?board=，直接看卡片位置（把目标 shape id 作为参数传入 evaluate）
  const targetShapeId = moveResult.moved ? `shape:${String(moveResult.id).replace("shape:", "")}` : null;
  const posAfterReload = await page.evaluate((targetId) => {
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
          if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function") {
            const c = v.getCurrentPageShapes().find((s) => s.type === "session-card" && s.id === targetId);
            if (c) return { x: Math.round(c.x), y: Math.round(c.y) };
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return null;
  }, targetShapeId);
  check("position persisted after reload", posAfterReload && posAfterReload.x === 800 && posAfterReload.y === 500, JSON.stringify(posAfterReload));

  // 6. 新会话加入任务 → 自动补卡（走 API assign 一个新 session 到任务）
  const sessions = await api("/api/sessions");
  const someSession = sessions.body.sessions.find((s) => !task.sessionIds.includes(s.id));
  if (someSession) {
    const assignRes = await apiPatch(`/api/tasks/${taskId}`, { sessionIds: [...task.sessionIds, someSession.id] });
    check("assigned new session to task via API", assignRes.status === 200, `sid=${someSession.id.slice(0, 8)}`);
    await page.waitForTimeout(14000); // 等补卡轮询（1s 首跑 + 10s 周期）
    const countAfter = await page.evaluate(() => {
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
            if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function") {
              return v.getCurrentPageShapes().filter((s) => s.type === "session-card").length;
            }
          }
          f = f.return;
        }
        for (const c of node.children || []) stack.push(c);
      }
      return -1;
    });
    check("new session auto-added to board", countAfter >= beforeCount + 1, `cards=${countAfter} expected=${beforeCount + 1}`);
  } else {
    console.log("  (skip auto-add check: no spare session)");
  }

} catch (e) {
  console.error("FATAL", e?.message ?? e);
  fail++;
} finally {
  // ---- 无条件还原测试数据 ----
  try {
    if (taskId) {
      // 1) 任务会话还原为初始集合（幂等：assign 与否都安全）
      await apiPatch(`/api/tasks/${taskId}`, { sessionIds: originalSessionIds });
      // 2) 看板还原：原本存在 → PUT 回初始画布；原本不存在（测试懒创建）→ 删除
      if (boardExistedBefore && originalCanvas) {
        const put = await page.request.fetch(`${URL}/api/boards/${encodeURIComponent(taskId)}/canvas`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          data: {
            nodes: originalCanvas.nodes ?? [],
            edges: originalCanvas.edges ?? [],
            view: originalCanvas.view ?? null,
          },
        });
        if (!put.ok) console.warn("  (restore canvas failed:", put.status, ")");
        else console.log("  (restored canvas to pre-test state)");
      } else {
        const del = await page.request.delete(`${URL}/api/boards/${encodeURIComponent(taskId)}`);
        if (!del.ok) console.warn("  (delete test board failed:", del.status, ")");
        else console.log("  (deleted test-created board)");
      }
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
