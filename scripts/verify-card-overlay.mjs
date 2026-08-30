#!/usr/bin/env node
// overlay 方案验证：收合卡 A 叠在展开面板 E 上
// 1. A HTMLContainer pe=all（挡下层），非激活有 overlay
// 2. 点 A → tldraw 选中 A（激活）→ 不误触下层 E
// 3. 拖 A → 移动 A，不选中 E 文字
// 4. 拖 A 路过另一张收合卡 B → 不阻断
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/baique/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js");
const URL = "http://127.0.0.1:30146";
const PROJECT = "/Users/baique/work/develop/project/pi-web-sky";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let pass = 0, fail = 0;
const check = (n, ok, d) => { if (ok) { pass++; console.log("  ✓ " + n + (d ? " — " + d : "")); } else { fail++; console.log("  ✗ " + n + (d ? " — " + d : "")); } };
const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = Date.now(), U = `ov${ts}`;
const post = async (p, data) => { const r = await page.request.fetch(`${URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, data }); return r.json(); };
const put = async (p, data) => { const r = await page.request.fetch(`${URL}${p}`, { method: "PUT", headers: { "Content-Type": "application/json" }, data }); return { s: r.status(), b: await r.json().catch(() => null) }; };
const SID_E = "01a052f1-fda9-7cdb-bd4a-836f05fa78e7"; // 有消息 → 展开面板
const SID_A = "01a0530a-9a71-72d4-affa-038a7e134a7f"; // 收合叠卡
const SID_B = "01a05306-8b47-71d6-889d-5b7c5f2e0e54"; // 收合路过
let boardId = null;
try {
  const b = await post("/api/boards", { projectKey: PROJECT, name: `ovv-${ts}` });
  boardId = b.board?.id;
  // E 展开（先 → z 下），A 叠在 E 内（中），B 收合在 A 右侧路径上（后 → z 上）
  const e = { id: `${U}e`, boardId, kind: "session", refId: SID_E, x: 400, y: 250, w: 840, h: 600, expanded: true, props: {}, created: ts, updated: ts };
  const a = { id: `${U}a`, boardId, kind: "session", refId: SID_A, x: 480, y: 330, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  const c = { id: `${U}c`, boardId, kind: "session", refId: SID_B, x: 1100, y: 360, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  await put(`/api/boards/${boardId}/canvas`, { nodes: [e, a, c], edges: [], view: null });
  await page.goto(`${URL}?board=${boardId}`, { waitUntil: "domcontentloaded" });
  await sleep(9000);

  const rect = async (tid) => page.evaluate((id) => { const el = document.querySelector(`[data-testid="${id}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, tid);
  const pe = async (tid) => page.evaluate((id) => { const el = document.querySelector(`[data-testid="${id}"]`); return el ? getComputedStyle(el).pointerEvents : "missing"; }, tid);
  const overlayInfo = async (tid) => page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    const ov = el.querySelector("div[aria-hidden='true']");
    return ov ? getComputedStyle(ov).pointerEvents : "no-overlay";
  }, tid);
  const selText = () => page.evaluate(() => window.getSelection()?.toString().slice(0, 30) ?? "");
  const cardE = `session-card-${SID_E}`, cardA = `session-card-${SID_A}`, cardC = `session-card-${SID_B}`;

  const eRect = await rect(cardE), aRect = await rect(cardA), cRect = await rect(cardC);
  console.log("E:", JSON.stringify(eRect), "A:", JSON.stringify(aRect), "C:", JSON.stringify(cRect));
  check("A HTMLContainer pe=all (挡下层)", (await pe(cardA)) === "all", await pe(cardA));
  check("A 非激活有 overlay(pe=all)", (await overlayInfo(cardA)) === "all", await overlayInfo(cardA));

  // 2. 点 A（中心，叠在 E 上）→ 应选中 A
  await page.mouse.click(aRect.x + aRect.w / 2, aRect.y + aRect.h / 2);
  await sleep(900);
  const aSel = await page.evaluate(() => {
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
          if (v && typeof v === "object" && typeof v.getSelectedShapeIds === "function" && v.store) {
            return JSON.stringify(v.getSelectedShapeIds());
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return "n/a";
  });
  check("点击叠在展开面板上的 A → 选中 A", aSel.includes("a") && !aSel.includes("c"), `sel=${aSel.slice(0, 60)}`);
  check("A 激活后 overlay 移除(pe=none)", (await overlayInfo(cardA)) === "none", await overlayInfo(cardA));
  check("点击 A 未选中下层 E 文字", (await selText()).length === 0, JSON.stringify(await selText()));

  // 3. 拖 A 移动（A 已激活）→ 应移动且不选文字
  const ax0 = aRect.x, ay0 = aRect.y;
  await page.mouse.move(aRect.x + aRect.w / 2, aRect.y + aRect.h / 2);
  await page.mouse.down();
  await page.mouse.move(aRect.x + aRect.w / 2 + 120, aRect.y + aRect.h / 2 + 100, { steps: 8 });
  await sleep(300);
  const selDuring = await selText();
  await page.mouse.up();
  await sleep(800);
  const a2 = await rect(cardA);
  const moved = Math.round(a2.x) !== Math.round(ax0) || Math.round(a2.y) !== Math.round(ay0);
  check("拖 A 移动成功", moved, `A ${Math.round(ax0)},${Math.round(ay0)} -> ${Math.round(a2.x)},${Math.round(a2.y)}`);
  check("拖 A 未选中文字", selDuring.length === 0, JSON.stringify(selDuring));

  // 4. 拖 A 从 (A中心) 到 C 右侧（路径穿过 C 收合卡）→ 不被阻断
  const a3 = await rect(cardA);
  const cRect2 = await rect(cardC);
  const sx = a3.x + a3.w / 2, sy = a3.y + a3.h / 2;
  const dx = cRect2.x + cRect2.w + 150, dy = cRect2.y + cRect2.h / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(sx + (dx - sx) * (i / 12), sy + (dy - sy) * (i / 12), { steps: 3 }); await sleep(25); }
  await page.mouse.up();
  await sleep(800);
  const a4 = await rect(cardA);
  check("拖 A 穿过 C 不阻断", Math.round(a4.x) > Math.round(dx) - 20, `A.x=${Math.round(a3.x)} -> ${Math.round(a4.x)} (target=${Math.round(dx)})`);

  await page.request.delete(`${URL}/api/boards/${boardId}`);
  boardId = null;
} catch (e) { console.error("FATAL", e?.message ?? e); fail++; }
finally { try { if (boardId) await page.request.delete(`${URL}/api/boards/${boardId}`); } catch {} await browser.close(); console.log(`\n=== ${pass} pass, ${fail} fail ===`); process.exit(fail > 0 ? 1 : 0); }
