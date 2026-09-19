import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  membershipDropAllowed,
  orderPinnedFirst,
  parseSessionDepth,
  planSessionListItems,
  sessionRowDraggable,
} from "./session-sidebar-list.ts";
import { sessionTimeGroup } from "../lib/session-time-group.ts";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const taskAreaSource = await readFile(new URL("./TaskArea.tsx", import.meta.url), "utf8");
const boardSectionSource = await readFile(new URL("./canvas/BoardSection.tsx", import.meta.url), "utf8");
const canvasStageSource = await readFile(new URL("./canvas/CanvasStage.tsx", import.meta.url), "utf8");

/** 取 [from, to) 之间的源码片段；锚点找不到就报错（避免静默退化成整文件切片）。 */
function sliceBetween(text, from, to) {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `切片起点不存在：${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `切片终点不存在（或不在起点之后）：${to}`);
  return text.slice(start, end);
}

// SessionItem 的右边界用下一个顶层函数（不是「文件尾」）——否则上/下函数改名会让
// doesNotMatch 退化成对整文件断言（锚点丢失时静默通过）。
const sessionItemSource = sliceBetween(source, "function SessionItem(", "function loadSidebarTab(");

test("session delete opens a confirmation bubble instead of inline confirm", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?setMoreOpen\(false\);\s*setConfirmUp\([\s\S]*?\);\s*setConfirmDelete\(true\);/,
  );
  // Shift 快捷直接删除已被移除：统一走气泡确认
  assert.doesNotMatch(sessionItemSource, /e\.shiftKey/);
  // 行内确认渲染已被气泡替代
  assert.doesNotMatch(sessionItemSource, /Delete confirmation: same height, two flat buttons/);
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("refreshes are incremental and never force-reset the paginated lists", () => {
  // 聊天区恒增量合并：不再有 force=1 全量重扫 / resetChat 整体重置。
  assert.doesNotMatch(source, /force \? "\/api\/sessions\?force=1"/);
  assert.doesNotMatch(source, /loadSessions\([^)]*force[^)]*\)/);
  assert.match(source, /loadSessions\(true\)/);
  assert.match(source, /loadSessions\(false\)/);
  // 手动刷新：跳过防抖立即执行，并同步 bump refreshKey（看板等其他消费方）。
  assert.match(source, /if \(onRefresh\) \{\n\s*manualRefreshRef\.current = true;/);
  // 运行轮询触发：增量刷新，不清用户已加载的分页。
  assert.match(source, /loadSessions\(false\);\n\s*\}[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\(hovered \|\| moreOpen \|\| confirmDelete\) && !session\.transient && \(/);
});

// ── 侧栏列表规则（components/session-sidebar-list.ts）：行为断言，不看源码字符串 ──

/** 构造一棵最小的会话树节点（排序只看 id / modified / pinned）。 */
function treeNode(id, modified, pinned = false, children = []) {
  return { session: { id, modified, pinned }, children };
}

test("段内排序：运行中会话在非置顶段内浮顶，不被 modified 全量重排覆盖", () => {
  const running = treeNode("s-old", "2026-01-01T00:00:00.000Z");
  const newest = treeNode("s-new", "2026-09-18T00:00:00.000Z");
  const ordered = orderPinnedFirst([newest, running], new Set(["s-old"]));
  assert.deepEqual(
    ordered.map((n) => n.session.id),
    ["s-old", "s-new"],
    "运行中的旧会话浮到非置顶段最前",
  );
});

test("段内排序：置顶段整体仍在非置顶段之前，运行中只在自己段内浮顶", () => {
  const pinnedOld = treeNode("pinned-old", "2026-01-01T00:00:00.000Z", true);
  const runningNew = treeNode("running-new", "2026-09-18T00:00:00.000Z");
  const pinnedRunning = treeNode("pinned-running", "2026-02-01T00:00:00.000Z", true);
  const ordered = orderPinnedFirst(
    [runningNew, pinnedOld, pinnedRunning],
    new Set(["running-new", "pinned-running"]),
  );
  assert.deepEqual(
    ordered.map((n) => n.session.id),
    ["pinned-running", "pinned-old", "running-new"],
    "置顶段在前；置顶段内运行中浮顶；非置顶段内运行中仍浮顶",
  );
});

test("段内排序：不传 runningIds 时语义不变（任务区调用点）", () => {
  const older = treeNode("older", "2026-01-01T00:00:00.000Z");
  const newer = treeNode("newer", "2026-09-18T00:00:00.000Z");
  const ordered = orderPinnedFirst([older, newer]);
  assert.deepEqual(ordered.map((n) => n.session.id), ["newer", "older"]);
});

test("会话行拖拽源只看改名 / 删除确认态（不按 depth 关：关了会连看板 / 画布建卡一起丢）", () => {
  assert.equal(sessionRowDraggable({ renaming: false, confirmDelete: false }), true);
  assert.equal(sessionRowDraggable({ renaming: true, confirmDelete: false }), false);
  assert.equal(sessionRowDraggable({ renaming: false, confirmDelete: true }), false);
});

test("归属类落点：顶层行可落，子会话行（depth > 0）拒绝", () => {
  assert.equal(membershipDropAllowed(0), true, "顶层行：移出 / 加入任务都有效");
  assert.equal(membershipDropAllowed(1), false, "子会话行：会被服务端按子树归一化，拒绝落点");
  assert.equal(membershipDropAllowed(2), false);
});

test("拖拽深度载荷：十进制字符串，缺失 / 非法 / 负数一律当顶层（0）", () => {
  assert.equal(parseSessionDepth(String(0)), 0);
  assert.equal(parseSessionDepth(String(3)), 3, "拖拽源写什么就回读什么");
  assert.equal(parseSessionDepth(""), 0, "旧载荷 / 非本侧栏来源 = 顶层行");
  assert.equal(parseSessionDepth("abc"), 0);
  assert.equal(parseSessionDepth("-1"), 0);
});

// ── 聊天区行计划：时间分组角标 ──

// 用本地时间构造，避免时区把「昨天」推到「今天」（sessionTimeGroup 走本地日边界）。
const NOW = new Date(2026, 8, 18, 12, 0, 0).getTime(); // 本地 2026-09-18 12:00
const day = (offsetDays) => new Date(2026, 8, 18 + offsetDays, 9, 0, 0).toISOString();

test("时间分组角标：运行中浮顶的行不打标签、也不推进游标（不会出现「昨天 → 今天 → 昨天」）", () => {
  const nodes = [
    treeNode("running-old", day(-1)), // 运行中 → 浮到段首，但 modified 比段内其它行旧
    treeNode("today-a", day(0)),
    treeNode("today-b", day(0)),
    treeNode("yesterday", day(-1)),
    treeNode("older", day(-120)),
  ];
  const items = planSessionListItems(nodes, new Set(["running-old"]), NOW, sessionTimeGroup);
  assert.deepEqual(
    items.map((i) => i.header),
    [null, "today", null, "yesterday", "older"],
    "浮顶行不打标签；段内分组标签由近及远各出现一次",
  );
});

test("时间分组角标：置顶段不参与分组，进入非置顶段后重新分组", () => {
  const nodes = [
    treeNode("pinned-today", day(0), true),
    treeNode("pinned-old", day(-120), true),
    treeNode("today-a", day(0)),
    treeNode("today-b", day(0)),
    treeNode("yesterday", day(-1)),
  ];
  const items = planSessionListItems(nodes, new Set(), NOW, sessionTimeGroup);
  assert.deepEqual(items.map((i) => i.header), [null, null, "today", null, "yesterday"]);
  assert.deepEqual(items.map((i) => i.pinDivider), [false, false, true, false, false]);
});

test("接线：归属落点与任务看板/画布落点都按深度拒绝，手动看板不受限", () => {
  // 聊天区「移出任务」落点
  const chatDrop = sliceBetween(source, "setTempDragOver(true)", "{chatListItems.map(");
  assert.match(chatDrop, /membershipDropAllowed\(depth\)/);
  assert.match(chatDrop, /parseSessionDepth\(/);
  // 任务区「加入任务」落点
  const taskDrop = sliceBetween(
    taskAreaSource,
    "const handleDrop = useCallback",
    "const handleDragStartTask",
  );
  assert.match(taskDrop, /membershipDropAllowed\(depth\)/);
  assert.match(taskDrop, /parseSessionDepth\(/);
  // 拖拽源与 text/session-title 并列写入深度载荷
  assert.match(sessionItemSource, /setData\(SESSION_DEPTH_MIME, String\(depth\)\)/);
  // 任务看板落点（board.taskId 存在）也是归属变更 → 共享守卫必须引用；手动看板仍允许建卡。
  // 正向断言（不再反向禁止）：画布/看板行都要读深度载荷并调 membershipDropAllowed。
  const boardDrop = sliceBetween(
    boardSectionSource,
    "const handleSessionDrop = (e: React.DragEvent): boolean => {",
    "const dropActive =",
  );
  assert.match(boardDrop, /board\.taskId && !membershipDropAllowed\(parseSessionDepth\(/, "看板行：仅任务看板拒绝 depth>0");
  assert.match(boardDrop, /SESSION_DEPTH_MIME/);
  const canvasDrop = sliceBetween(
    canvasStageSource,
    "const sid = dt.getData(\"text/session-id\");",
    "const dropTitle =",
  );
  assert.match(canvasDrop, /board\.board\?\.taskId && !membershipDropAllowed\(parseSessionDepth\(/, "画布落点：仅任务看板拒绝 depth>0");
  assert.match(canvasDrop, /SESSION_DEPTH_MIME/);
  // 两处都引用共享守卫函数，而不是各写一套深度判断
  for (const [name, text] of [["BoardSection", boardSectionSource], ["CanvasStage", canvasStageSource]]) {
    assert.match(text, /import \{[^}]*membershipDropAllowed[^}]*\} from "@\/components\/session-sidebar-list"/, `${name} 必须复用共享守卫`);
  }
  // 手动看板路径上不允许出现「无条件拒绝」——守卫必须挂在 taskId 条件里
  assert.doesNotMatch(boardSectionSource, /if \(!membershipDropAllowed\(/);
  assert.doesNotMatch(canvasStageSource, /if \(!membershipDropAllowed\(/);
  // 行级 draggable 不再按任务区 / 深度关掉（I1 回归锁）
  assert.match(sessionItemSource, /draggable=\{sessionRowDraggable\(\{ renaming, confirmDelete \}\)\}/);
  assert.doesNotMatch(source, /inTaskRegion/);
});

// ── 注释与新语义同步（修复波把「任务看板落卡」归入归属变更）──
// 共享守卫的 docstring 必须与调用点的实际规则一致：任务看板落卡走服务端归属
// （add-session 路由先 assign 再落卡）→ 拒绝 depth>0；只有手动看板才是新增内容。

test("共享守卫 docstring 与调用点同语义：任务看板落卡是归属变更，手动看板不受限", async () => {
  const listSource = await readFile(new URL("./session-sidebar-list.ts", import.meta.url), "utf8");
  const doc = sliceBetween(listSource, "归属类落点是否接受该深度的行", "export function membershipDropAllowed");
  assert.match(doc, /\*\*任务看板\*\*落卡[\s\S]*?归属变更/, "docstring 必须写明任务看板落卡也受此限");
  assert.match(doc, /\*\*手动看板\*\*/);
  // 旧表述（修复波前的错误前提）不得残留在任何引用它的注释里
  const stale = /看板行 \/ 画布落卡\*\*?不是\*\*?归属变更|不是归属变更（建卡是新增内容）/;
  for (const [name, text] of [
    ["session-sidebar-list", listSource],
    ["TaskArea", taskAreaSource],
    ["SessionSidebar", source],
  ]) {
    assert.doesNotMatch(text, stale, `${name} 不应残留旧表述`);
  }
  // 拖拽源注释同步（它列的就是归属类落点）
  assert.match(sessionItemSource, /任务看板落卡）按它拒绝子会话行/);
  assert.match(taskAreaSource, /任务看板[\s\S]{0,40}归属变更/);
});

// ── 归属请求失败可见（服务端 error 文案进日志，不静默 / 不新造通知系统）──

test("聊天区归属失败把服务端 error 文案带进 console.warn（不静默）", () => {
  const assignBlock = sliceBetween(
    source,
    "const handleAssignSession = useCallback(",
    "const handleUnassignSession = useCallback(",
  );
  assert.match(assignBlock, /const res = await fetch\(`\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/assign-session`/);
  assert.match(assignBlock, /if \(!res\.ok\)[\s\S]*?console\.warn\(/, "检查 res.ok 并落日志");
  // 取值细节由 components/session-membership-feedback.ts 的**行为**测试盖（body 已消费/
  // 空 body 都回退状态码）——这里只锁「接线」：调用它，而不是自己写 text() 分支。
  assert.match(assignBlock, /await assignmentFailureDetail\(res\)/, "日志细节走共享取值函数");
  assert.ok(
    source.includes('import { assignmentFailureDetail } from "./session-membership-feedback";'),
    "必须真的 import（不是同名局部变量）",
  );
  assert.doesNotMatch(assignBlock, /toast|notify/i, "不新造通知系统");
});

test("看板落卡失败把服务端响应文本带进 console.warn", () => {
  const boardDrop = sliceBetween(
    boardSectionSource,
    "const handleSessionDrop = (e: React.DragEvent): boolean => {",
    "const dropActive =",
  );
  assert.match(boardDrop, /throw new Error\(`HTTP \$\{res\.status\}/, "错误带状态码");
  assert.match(
    boardDrop,
    /if \(!res\.ok\)[\s\S]*?await assignmentFailureDetail\(res\)/,
    "失败细节走共享取值函数（行为另测）",
  );
  assert.ok(
    boardSectionSource.includes(
      'import { assignmentFailureDetail } from "@/components/session-membership-feedback";',
    ),
    "必须真的 import（不是同名局部变量）",
  );
  assert.match(boardDrop, /catch\(\(error\) => \{[\s\S]*?console\.warn\(/, "catch 里落日志");
});
