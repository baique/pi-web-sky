import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// board-events 只在调用时碰 window；用一个 EventTarget 顶替，验证「改名入口 → 各节点」这一条路由。
globalThis.window = new EventTarget();

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { dispatchBoardRenameNode, onBoardRenameNode } = await jiti.import("./board-events.ts");

test("dispatches the target node id to subscribers", () => {
  const seen = [];
  const off = onBoardRenameNode((nodeId) => seen.push(nodeId));

  dispatchBoardRenameNode("session-abc");
  dispatchBoardRenameNode("sticky-xyz");

  // 事件只有一个通道：每个订阅者都收到所有 id，自行判断是不是自己（节点内 if (nodeId === id)）
  assert.deepEqual(seen, ["session-abc", "sticky-xyz"]);

  off();
  dispatchBoardRenameNode("session-abc");
  assert.deepEqual(seen, ["session-abc", "sticky-xyz"], "unsubscribe must stop delivery");
});

test("each subscriber unsubscribes independently", () => {
  const a = [];
  const b = [];
  const offA = onBoardRenameNode((id) => a.push(id));
  const offB = onBoardRenameNode((id) => b.push(id));

  dispatchBoardRenameNode("n1");
  offA();
  dispatchBoardRenameNode("n2");

  assert.deepEqual(a, ["n1"]);
  assert.deepEqual(b, ["n1", "n2"]);
  offB();
});
