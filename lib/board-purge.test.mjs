import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { createBoard, addNode, getBoardCanvas } = await jiti.import("./board-store.ts");
const { purgeOrphanBoardCards } = await jiti.import("./board-purge.ts");

const PROJECT = "test-project";
let db;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  setDbForTesting(db);
});

afterEach(() => {
  db.close();
});

test("purgeOrphanBoardCards: 删孤儿卡片（会话不存在）+ 保留 draft 卡 + 幂等", async () => {
  const b = createBoard(PROJECT, "b");
  // 孤儿卡：refId 指向不存在的会话（随机 UUID，文件系统必无）
  const orphanId = randomUUID();
  const orphan = addNode(b.id, { x: 0, y: 0, refId: orphanId });
  assert.ok(orphan);
  // draft 卡：refId 为空，不删
  const draft = addNode(b.id, { x: 100, y: 0, refId: null });
  assert.ok(draft);

  const r = await purgeOrphanBoardCards();
  assert.equal(r.deletedNodes, 1);
  assert.deepEqual(r.boards, [b.id]);

  const canvas = getBoardCanvas(b.id);
  assert.equal(canvas?.nodes.length, 1);
  assert.equal(canvas?.nodes[0].id, draft.id); // draft 保留

  // 幂等：再次清理全 0
  const r2 = await purgeOrphanBoardCards();
  assert.equal(r2.deletedNodes, 0);
  assert.equal(r2.deletedEdges, 0);
  assert.deepEqual(r2.boards, []);
});

test("purgeOrphanBoardCards: 级联删连线", async () => {
  const b = createBoard(PROJECT, "b");
  const orphanId = randomUUID();
  const orphan = addNode(b.id, { x: 0, y: 0, refId: orphanId });
  const keep = addNode(b.id, { x: 100, y: 0, refId: null }); // draft 卡（不删）
  const { addEdge } = await jiti.import("./board-store.ts");
  assert.ok(orphan && keep);
  // 孤儿卡 ←→ draft 卡的连线
  assert.ok(addEdge(b.id, { fromId: orphan.id, toId: keep.id, label: "x" }));

  const r = await purgeOrphanBoardCards();
  assert.equal(r.deletedNodes, 1);
  assert.equal(r.deletedEdges, 1); // 指向孤儿卡的边被级联删
  const canvas = getBoardCanvas(b.id);
  assert.equal(canvas?.nodes.length, 1);
  assert.equal(canvas?.nodes[0].id, keep.id); // draft 保留
  assert.equal(canvas?.edges.length, 0); // 连线已清
});
