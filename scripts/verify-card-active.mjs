#!/usr/bin/env node
// 会话卡激活态（pointer-events none/all）验证 e2e：
//  1. 非激活收合卡 pointer-events none（事件让位画布）
//  2. 点击卡片 → tldraw 选中 → 该卡 pointer-events all（激活）且被选中
//  3. 点击空白 → 取消选中 → 全部回到 none
//  4. 拖拽 A 卡移动，路径穿过 B 卡（B 非激活 none）→ A 移动不被阻断（x 变化）
// 前置：dev server 运行中（30146）。执行：node scripts/verify-card-active.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/baique/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js");

const URL = "http://127.0.0.1:30146";
const PROJECT = "/Users/baique/work/develop/project/pi-web-sky";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
};

const browser = await chromium.launch({
  headless: true,
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const api = async (p, init) => {
  const res = await page.request.fetch(`${URL}${p}`, init ?? {});
  return { status: res.status(), body: await res.json().catch(() => null) };
};
const put = async (p, data) => {
  const res = await page.request.fetch(`${URL}${p}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    data,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
};
const post = async (p, data) => {
  const res = await page.request.fetch(`${URL}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
};

let boardId = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 0. 造临时手动看板 + 两个 session 节点（假 sessionId 也能渲染收合卡）
  const ts = Date.now();
  const U = `v${ts}`;
  const name = `cardactive-${ts}`;
  const created = await post("/api/boards", { projectKey: PROJECT, name });
  boardId = created.body?.board?.id ?? null;
  check("create temp board", !!boardId, boardId ? `id=${boardId.slice(0, 8)}` : JSON.stringify(created.body));

  // A 卡在左(300,300)，B 卡在右(900,300)，A 往右拖穿过 B
  const nodeA = { id: `${U}a`, boardId, kind: "session", refId: `fake-a-${ts}`, x: 300, y: 300, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  const nodeB = { id: `${U}b`, boardId, kind: "session", refId: `fake-b-${ts}`, x: 900, y: 300, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  const p1 = await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [nodeA, nodeB], edges: [], view: null });
  check("PUT canvas 2 session nodes", p1.status === 200, `status=${p1.status}`);

  // 1. 打开看板 → hydrate
  await page.goto(`${URL}?board=${encodeURIComponent(boardId)}`, { waitUntil: "domcontentloaded" });
  await sleep(7000);
  const cardTestIdA = `session-card-fake-a-${ts}`;
  const cardTestIdB = `session-card-fake-b-${ts}`;

  const peOf = async (testid) => page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`);
    if (!el) return { found: false };
    const cs = getComputedStyle(el);
    return { found: true, pointerEvents: cs.pointerEvents, rect: el.getBoundingClientRect().toJSON() };
  }, testid);

  const pa = await peOf(cardTestIdA);
  const pb = await peOf(cardTestIdB);
  check("both cards rendered", pa.found && pb.found, pa.found && pb.found ? `A@(${Math.round(pa.rect.x)},${Math.round(pa.rect.y)}) B@(${Math.round(pb.rect.x)},${Math.round(pb.rect.y)})` : `A=${pa.found} B=${pb.found}`);
  check("initial pointer-events none (both inactive)", pa.found && pa.pointerEvents === "none" && pb.pointerEvents === "none", `A=${pa.pointerEvents} B=${pb.pointerEvents}`);

  // 2. 点击 A 卡中心 → 选中 → A 变 all、B 仍 none
  const ax = pa.rect.x + pa.rect.width / 2, ay = pa.rect.y + pa.rect.height / 2;
  await page.mouse.click(ax, ay);
  await sleep(800);
  const pa2 = await peOf(cardTestIdA);
  const pb2 = await peOf(cardTestIdB);
  check("click A activates A (all), B stays none", pa2.pointerEvents === "all" && pb2.pointerEvents === "none", `A=${pa2.pointerEvents} B=${pb2.pointerEvents}`);

  // 3. 点击画布空白（A 卡上方空旷区域，避开顶栏/工具条）→ 取消选中 → A 回 none
  await page.mouse.click(200, 150);
  await sleep(800);
  const dbg = await page.evaluate(() => {
    const el = document.elementFromPoint(200, 150);
    const cls = (el?.className ?? "").toString().slice(0, 80);
    // 拿 editor 实例检查 selection
    const root = document.getElementById("__next") || document.body;
    const stack = [root];
    let sel = "n/a";
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      let f = node[Object.keys(node).find((k) => k.startsWith("__reactFiber"))];
      const seen = new Set();
      while (f && !seen.has(f)) {
        seen.add(f);
        const memo = f.memoizedProps;
        if (memo) for (const k of Object.keys(memo)) {
          const v = memo[k];
          if (v && typeof v === "object" && typeof v.getSelectedShapeIds === "function" && v.store) {
            sel = JSON.stringify(v.getSelectedShapeIds());
            break;
          }
        }
        if (sel !== "n/a") break;
        f = f.return;
      }
      if (sel !== "n/a") break;
      for (const c of node.children || []) stack.push(c);
    }
    return { elClass: cls, selection: sel };
  });
  console.log("    [dbg] blank-click target:", dbg.elClass, "| selection:", dbg.selection);
  // 3b. 用编辑器 API 直接清除选中 → 验证响应式链路（selected→none）
  const desel = await page.evaluate(() => {
    const root = document.getElementById("__next") || document.body;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      let f = node[Object.keys(node).find((k) => k.startsWith("__reactFiber"))];
      const seen = new Set();
      while (f && !seen.has(f)) {
        seen.add(f);
        const memo = f.memoizedProps;
        if (memo) for (const k of Object.keys(memo)) {
          const v = memo[k];
          if (v && typeof v === "object" && typeof v.selectNone === "function" && v.store) {
            v.selectNone();
            return true;
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return false;
  });
  console.log("    [dbg] selectNone called:", desel);
  await sleep(800);
  const pa3 = await peOf(cardTestIdA);
  check("click blank deactivates A (none)", pa3.pointerEvents === "none", `A=${pa3.pointerEvents}`);

  // 4. 拖拽 A 卡移动，路径穿过 B 卡：A 从 (ax,ay) 拖到 B 卡右侧
  //    非激活 B 是 none → 事件穿透，A 拖拽不被阻断
  const ax2 = ax, ay2 = ay;
  const bx = pb.rect.x, by = pb.rect.y + pb.rect.height / 2;
  const dx = bx + 200, dy = by;
  await page.mouse.move(ax2, ay2);
  await page.mouse.down();
  // 分多步移动，让中间路径经过 B 卡上方（B 卡区域 y 范围要覆盖拖拽 y）
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(ax2 + (dx - ax2) * (i / 12), ay2 + (dy - ay2) * (i / 12), { steps: 4 });
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(1000);

  const pa4 = await peOf(cardTestIdA);
  const moved = Math.round(pa4.rect.x);
  check("drag A across B succeeds (x moved right)", moved > ax + 100, `A.x=${ax} -> ${moved} (target≈${Math.round(dx)})`);

  // 清理：删看板
} catch (e) {
  console.error("FATAL", e?.message ?? e);
  fail++;
} finally {
  try {
    if (boardId) {
      const del = await page.request.delete(`${URL}/api/boards/${encodeURIComponent(boardId)}`);
      console.log(`  (deleted temp board: ${del.ok() ? "ok" : "failed " + del.status()})`);
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
