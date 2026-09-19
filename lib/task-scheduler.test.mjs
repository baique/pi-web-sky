import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const {
  tryBecomeLeader,
  getLeaderInstanceId,
  clearSchedulerLeaderForTesting,
  getInstanceId,
  LEADER_STALE_MS,
} = await jiti.import("./scheduler-leader.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

test("迁移后存在 scheduler_leader 表（单调度者注册）", () => {
  freshDb();
  const cols = getDb().prepare("PRAGMA table_info(scheduler_leader)").all().map((r) => r.name);
  assert.ok(cols.includes("instance_id"));
  assert.ok(cols.includes("registered_at"));
  assert.ok(cols.includes("heartbeat"));
});

test("先注册者成为 leader，后到者注册失败", () => {
  freshDb();
  assert.equal(tryBecomeLeader("inst-a"), true);
  assert.equal(tryBecomeLeader("inst-b"), false);
  assert.equal(getLeaderInstanceId(), "inst-a");
});

test("leader 心跳续期：同一实例重复注册续期成功", () => {
  freshDb();
  tryBecomeLeader("inst-a");
  // 心跳未过期 → 续期成功
  assert.equal(tryBecomeLeader("inst-a"), true);
  assert.equal(getLeaderInstanceId(), "inst-a");
});

test("leader 心跳过期后其他实例可接管", () => {
  freshDb();
  tryBecomeLeader("inst-a");
  // 人为把心跳拨老（模拟 leader 挂掉没续期）
  getDb()
    .prepare("UPDATE scheduler_leader SET heartbeat = ? WHERE instance_id = 'inst-a'")
    .run(Date.now() - LEADER_STALE_MS - 5_000);
  // 心跳未过期判断的 getLeaderInstanceId 应返回 null（视同无 leader）
  assert.equal(getLeaderInstanceId(), null);
  // 后到者可接管
  assert.equal(tryBecomeLeader("inst-b"), true);
  assert.equal(getLeaderInstanceId(), "inst-b");
});

test("leader 存活时其他实例不能抢", () => {
  freshDb();
  tryBecomeLeader("inst-a");
  // 心跳新鲜（刚注册）→ b 抢不到
  assert.equal(tryBecomeLeader("inst-b"), false);
  assert.equal(getLeaderInstanceId(), "inst-a");
});

test("getInstanceId 同一进程内稳定", () => {
  const a = getInstanceId();
  const b = getInstanceId();
  assert.equal(a, b);
  assert.ok(a.length > 0);
});

test("clearSchedulerLeaderForTesting 清空后可重新注册", () => {
  freshDb();
  tryBecomeLeader("inst-a");
  clearSchedulerLeaderForTesting();
  assert.equal(getLeaderInstanceId(), null);
  assert.equal(tryBecomeLeader("inst-b"), true);
});

// ── 派发时的归属失败不能静默 ──
// assignSessionToTask 会拒绝（返回 false）：祖先属别的任务 / 会话解析不出。丢了返回值的话
// 「派发了但会话没进任务区」在日志里毫无痕迹（reconcile 会把它当孤儿卡）。

const schedulerSource = await readFile(new URL("./task-scheduler.ts", import.meta.url), "utf8");

/** 取 [from, to) 之间的源码片段；锚点找不到就报错（避免静默退化成整文件切片）。 */
function sliceBetween(text, from, to) {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `切片起点不存在：${from}`);
  const end = text.indexOf(to, start);
  assert.ok(end > start, `切片终点不存在（或不在起点之后）：${to}`);
  return text.slice(start, end);
}

test("派发会话归属失败不静默：检查 assignSessionToTask 返回值并 console.warn", () => {
  const assignBlock = sliceBetween(
    schedulerSource,
    "const board = getBoard(card.boardId);",
    "if (session.session.isRunning())",
  );
  assert.match(assignBlock, /const assigned = await assignSessionToTask\(/, "返回值必须接住");
  assert.match(assignBlock, /if \(!assigned\)[\s\S]*?console\.warn\(/, "失败必须可见（console.warn）");
  assert.match(assignBlock, /派发的会话未能归属任务/);
});
