import assert from "node:assert/strict";
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
