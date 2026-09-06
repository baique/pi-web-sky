import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

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
