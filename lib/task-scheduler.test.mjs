import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { createCard, updateCard, getCard, heartbeatOwnedCards } = await jiti.import("./task-card-store.ts");
const { createBoard } = await jiti.import("./board-store.ts");
// 只 import 纯函数/归属守卫，不触发 rpc-manager（避免拉起整个 coding-agent SDK）
const { isCardHandledByInstance, OWNER_STALE_MS } = await jiti.import("./task-scheduler.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

test("迁移后 task_cards 含 owner/heartbeat 列", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡" });
  assert.equal(c.owner, null);
  assert.equal(c.heartbeat, 0);
  const cols = getDb().prepare("PRAGMA table_info(task_cards)").all().map((r) => r.name);
  assert.ok(cols.includes("owner"));
  assert.ok(cols.includes("heartbeat"));
});

test("updateCard 可写 owner/heartbeat", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const c = createCard({ boardId: b.id, projectKey: "proj-a", name: "卡" });
  const ts = 12345;
  const updated = updateCard(c.id, { execStatus: "running", owner: "inst-a", heartbeat: ts });
  assert.equal(updated?.owner, "inst-a");
  assert.equal(updated?.heartbeat, ts);
  assert.equal(getCard(c.id)?.owner, "inst-a");
  assert.equal(getCard(c.id)?.heartbeat, ts);
});

test("heartbeatOwnedCards 只刷本实例活跃生命周期(running/review/waiting_reply)卡", () => {
  freshDb();
  const b = createBoard("proj-a", "看板A");
  const running = createCard({ boardId: b.id, projectKey: "proj-a", name: "跑" });
  const review = createCard({ boardId: b.id, projectKey: "proj-a", name: "审" });
  const waiting = createCard({ boardId: b.id, projectKey: "proj-a", name: "等" });
  const done = createCard({ boardId: b.id, projectKey: "proj-a", name: "完" });
  const other = createCard({ boardId: b.id, projectKey: "proj-a", name: "别人" });
  updateCard(running.id, { execStatus: "running", owner: "me" });
  updateCard(review.id, { execStatus: "review", owner: "me" });
  updateCard(waiting.id, { execStatus: "waiting_reply", owner: "me" });
  updateCard(done.id, { execStatus: "done", owner: "me" });
  updateCard(other.id, { execStatus: "running", owner: "them" });

  heartbeatOwnedCards("me");
  assert.ok(getCard(running.id)?.heartbeat > 0);
  assert.ok(getCard(review.id)?.heartbeat > 0);
  assert.ok(getCard(waiting.id)?.heartbeat > 0);
  assert.equal(getCard(done.id)?.heartbeat, 0);      // 结束态不刷新
  assert.equal(getCard(other.id)?.heartbeat, 0);     // 别人家不刷新
});

test("isCardHandledByInstance 归属守卫矩阵（#27 核心）", () => {
  const me = "inst-me";
  const them = "inst-them";
  const now = 1_000_000;
  const fresh = now - 5_000;            // 5s 前心跳（OWNER_STALE_MS=120s 内 → 活着）
  const stale = now - (OWNER_STALE_MS + 1_000); // 超期 → 已死

  // owner 为空（旧数据）→ 任何实例可处理
  assert.equal(isCardHandledByInstance({ owner: null, heartbeat: 0 }, me, now), true);
  // owner == 我 → 我负责
  assert.equal(isCardHandledByInstance({ owner: me, heartbeat: 0 }, me, now), true);
  // owner == 他人 且 心跳新鲜 → 跳过（← 防误翻他人正在跑的会话）
  assert.equal(isCardHandledByInstance({ owner: them, heartbeat: fresh }, me, now), false);
  // owner == 他人 但 心跳过期 → 接管
  assert.equal(isCardHandledByInstance({ owner: them, heartbeat: stale }, me, now), true);
  // 边界：正好 = OWNER_STALE_MS 视为过期（>=）
  assert.equal(isCardHandledByInstance({ owner: them, heartbeat: now - OWNER_STALE_MS }, me, now), true);
});
