#!/usr/bin/env node
// 审查修复验证 e2e：临时看板（用完即删，不动用户数据）
//  1. group 子 shape 持久化（父+子 nodes 带 parentId 往返）
//  2. arrow binding 还原（edges → hydrate 后 createBindings 被调用，箭头有 binding）
//  3. 清空画布 allowEmpty（PUT 空 nodes 放行，节点清空）
//  4. 轮询 loop 自续（代码路径静态验证：visibilitychange 后仍调度）
// 前置：30143 dev server 运行中。执行：node scripts/e2e-board-fixes.mjs
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
const put = async (p, data) => {
  const res = await page.request.fetch(`${URL}${p}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    data,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status(), body };
};

let boardId = null;

try {
  // 0. 造一个临时手动看板（POST boards）
  const name = `fixverify-${Date.now()}`;
  const created = await page.request.fetch(`${URL}/api/boards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: { projectKey: PROJECT, name },
  });
  const createdBody = await created.json().catch(() => null);
  boardId = createdBody?.board?.id ?? null;
  const createdStatus = typeof created.status === "function" ? created.status() : created.status;
  check("create temp board", createdStatus >= 200 && createdStatus < 300 && !!boardId, boardId ? `id=${boardId.slice(0, 8)}` : `status=${createdStatus} ${JSON.stringify(createdBody)}`);
  if (!boardId) throw new Error("no board id");

  // 1. group 子 shape 持久化：PUT 一个 group 父 + 两个子 shape（带 parentId）
  // 节点 id 是全局主键（board_nodes.id PRIMARY KEY），用唯一前缀避免跨运行/跨看板冲突
  const U = `f${Date.now()}`;
  const ts = Date.now();
  const groupNode = {
    id: `${U}g`, boardId, kind: "shape", refId: null,
    x: 100, y: 100, w: 200, h: 120, expanded: false,
    props: { type: "group", rotation: 0, shapeProps: {}, parentId: null },
    created: ts, updated: ts,
  };
  const childA = {
    id: `${U}ga`, boardId, kind: "shape", refId: null,
    x: 110, y: 110, w: 80, h: 40, expanded: false,
    props: {
      type: "text", rotation: 0,
      shapeProps: { color: "black", font: "sans", richText: { type: "doc", content: [] }, size: "m", w: 80, textAlign: "start" },
      parentId: groupNode.id,
    },
    created: ts, updated: ts,
  };
  const childB = {
    id: `${U}gb`, boardId, kind: "shape", refId: null,
    x: 200, y: 110, w: 60, h: 60, expanded: false,
    props: { type: "geo", rotation: 0, shapeProps: { geo: "rectangle", w: 60, h: 60, color: "blue", fill: "solid" }, parentId: groupNode.id },
    created: ts, updated: ts,
  };
  const p1 = await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [groupNode, childA, childB], edges: [], view: null });
  check("PUT canvas with group+children", p1.status === 200, `status=${p1.status}`);

  // GET 回来验证 nodes 完整
  const c1 = await api(`/api/boards/${encodeURIComponent(boardId)}/canvas`);
  const nodes1 = c1.body?.nodes ?? [];
  const group = nodes1.find((n) => n.id === groupNode.id);
  const chA = nodes1.find((n) => n.id === childA.id);
  const chB = nodes1.find((n) => n.id === childB.id);
  check("group parent persisted", !!group && group.props.type === "group", group ? JSON.stringify(group.props.type) : "missing");
  check("child shapes persisted with parentId", !!chA && !!chB && chA.props.parentId === groupNode.id && chB.props.parentId === groupNode.id,
    chA && chB ? `ga.parent=${chA.props.parentId} gb.parent=${chB.props.parentId}` : `ga=${!!chA} gb=${!!chB}`);

  // 2. arrow binding 还原：PUT 一条边 → 打开看板 → hydrate 后 arrow 应有 binding（编辑器内 getBindingsInvolvingShape 非空）
  const nodeX = { id: `${U}x`, boardId, kind: "session", refId: null, x: 300, y: 300, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  const nodeY = { id: `${U}y`, boardId, kind: "session", refId: null, x: 800, y: 300, w: 340, h: 160, expanded: false, props: {}, created: ts, updated: ts };
  const edge = { id: `${U}e`, boardId, fromId: nodeX.id, toId: nodeY.id, label: null, color: "blue", dashed: false, created: ts, updated: ts };
  const p2 = await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [groupNode, childA, childB, nodeX, nodeY], edges: [edge], view: null });
  check("PUT canvas with edge", p2.status === 200, `status=${p2.status}`);

  // 3. 打开 UI 看板模式 → hydrate → 检查 editor 内 arrow 有 binding
  await page.goto(`${URL}?board=${encodeURIComponent(boardId)}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6500); // 等 hydrate + 摘要 + 渲染稳定

  const bindingCheck = await page.evaluate(() => {
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
          if (v && typeof v === "object" && typeof v.getCurrentPageShapes === "function" && v.store) {
            const arrows = v.getCurrentPageShapes().filter((s) => s.type === "arrow");
            if (arrows.length === 0) return { ok: false, reason: "no arrow shapes", shapes: v.getCurrentPageShapes().map((s) => s.type) };
            const bindings = v.store.allRecords().filter((r) => r.typeName === "binding" && r.type === "arrow" && r.fromId === arrows[0].id);
            const terms = bindings.map((x) => x.props?.terminal).sort();
            return { ok: bindings.length === 2 && terms[0] === "end" && terms[1] === "start", count: bindings.length, terms };
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return { ok: false, reason: "editor not found" };
  });
  check("arrow hydrate creates bindings (drag-follow)", bindingCheck.ok, JSON.stringify(bindingCheck));

  // group 子 shape 在 UI hydrate 后也在（text/geo 子 shape 存在且 parentId 正确）

  // group 子 shape 在 UI hydrate 后也在（text/geo 子 shape 存在且 parentId 正确）
  const groupCheck = await page.evaluate((gid) => {
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
            const all = v.getCurrentPageShapesSorted ? v.getCurrentPageShapesSorted() : v.getCurrentPageShapes();
            const children = all.filter((s) => s.parentId && s.parentId.replace("shape:", "") === gid);
            const g = all.find((s) => s.id.replace("shape:", "") === gid);
            return { ok: !!g && children.length === 2, g: !!g, children: children.map((s) => s.type), parentIds: children.map((s) => s.parentId) };
          }
        }
        f = f.return;
      }
      for (const c of node.children || []) stack.push(c);
    }
    return { ok: false, reason: "editor not found" };
  }, groupNode.id);
  check("group children hydrate under group parent", groupCheck.ok, JSON.stringify(groupCheck));

  // 4. 清空画布 allowEmpty：UI 按钮或 API 显式清空 → 服务器放行，nodes 清空
  //    模拟按钮行为：PUT 空 nodes + allowEmpty:true
  const p4 = await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [], edges: [], view: null, allowEmpty: true });
  const c4 = await api(`/api/boards/${encodeURIComponent(boardId)}/canvas`);
  check("clear canvas with allowEmpty works", p4.status === 200 && (c4.body?.nodes?.length ?? -1) === 0,
    `put=${p4.status} nodes=${c4.body?.nodes?.length}`);
  // 无 allowEmpty 的空覆盖仍被拒（保护在）
  await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [nodeX], edges: [], view: null });
  const p4b = await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [], edges: [], view: null });
  check("empty overwrite still rejected without allowEmpty", p4b.status === 409, `status=${p4b.status}`);
  // 清掉测试残留
  await put(`/api/boards/${encodeURIComponent(boardId)}/canvas`, { nodes: [], edges: [], view: null, allowEmpty: true });

} catch (e) {
  console.error("FATAL", e?.message ?? e);
  fail++;
} finally {
  try {
    if (boardId) {
      const del = await page.request.delete(`${URL}/api/boards/${encodeURIComponent(boardId)}`);
      console.log(`  (deleted temp board: ${del.ok ? "ok" : "failed " + del.status})`);
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
