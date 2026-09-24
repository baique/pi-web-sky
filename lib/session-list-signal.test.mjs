import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { markSessionListChanged, getSessionListGeneration } = await jiti.import("./session-list-signal.ts");

const routeSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("../components/SessionSidebar.tsx", import.meta.url), "utf8");
const readerSource = await readFile(new URL("./session-reader.ts", import.meta.url), "utf8");
const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");

test("mark 自增代次，get 读同一处（globalThis：热重载后仍是同一个计数器）", () => {
  const before = getSessionListGeneration();
  markSessionListChanged();
  markSessionListChanged();
  assert.equal(getSessionListGeneration(), before + 2);
  assert.equal(globalThis.__piSessionListGeneration, before + 2);
});

test("接线：写路径 invalidateSessionListCache 委托 mark（改名/pin/新建/事件写库都算列表变更）", () => {
  assert.match(
    readerSource,
    /export function invalidateSessionListCache\(\): void \{\n  markSessionListChanged\(\);/,
  );
  assert.match(readerSource, /from "\.\/session-list-signal"/);
});

test("接线：running 快照把代次带给前端（侧栏本来就在轮询它，不新增请求）", () => {
  assert.match(routeSource, /listGeneration: getSessionListGeneration\(\)/);
  assert.match(routeSource, /from "@\/lib\/session-list-signal"/);
});

test("接线：侧栏轮询见代次变化就全量刷新；首个快照只做种子（挂载时已拉过列表，不空刷）", () => {
  assert.match(
    sidebarSource,
    /if \(shouldRefreshForListGeneration\(listGenerationRef\.current, generation\)\) \{\n\s+onRefreshRef\.current\?\.\(\);/,
  );
  // 列表响应把自己的代次记下来（不靠轮询的「首个快照」去猜）。
  assert.match(sidebarSource, /if \(typeof data\.listGeneration === "number"\) listGenerationRef\.current = data\.listGeneration;/);
});

test("接线：/api/sessions 两份列表响应都带上自己的代次（作为「我的列表对应哪个代次」的种子）", () => {
  assert.match(sessionsRouteSource, /sessions: \[\.\.\.persisted, \.\.\.extraRuntime\],[\s\S]*?listGeneration: getSessionListGeneration\(\),/);
  assert.match(
    sessionsRouteSource,
    /\{ sessions, runningSessionIds: getRunningRpcSessionIds\(\), listGeneration: getSessionListGeneration\(\) \}/,
  );
});
