import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { collectSessionDescendants } = await jiti.import("./session-delete.ts");
const { setDbForTesting, getDb } = await jiti.import("./sqlite-db.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

/** 建一行会话索引。collectSessionDescendants 只读 session_meta.parent_id：
 *  盘上有没有文件、文件在哪个目录都不影响（旧实现靠 readdirSync 平铺目录 + 读每个
 *  文件 header 推父链，所以那时必须有文件且必须同目录——见下面「跨目录」用例）。 */
function seed(id, parentId = null, path = `/nonexistent/${id}.jsonl`) {
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, parent_id) VALUES (?, NULL, 1, 0, ?, ?)")
    .run(id, path, parentId);
}

test("collectSessionDescendants walks the whole fork tree by DB parent_id (multi-level)", async () => {
  freshDb();
  seed("root-id");
  seed("child1", "root-id");
  seed("child2", "child1"); // 两级分叉：child1 → child2
  seed("unrelated");

  const ids = await collectSessionDescendants("root-id");
  assert.deepEqual(ids.sort(), ["root-id", "child1", "child2"].sort());
  assert.ok(!ids.includes("unrelated"));
});

test("collectSessionDescendants returns the root alone when there are no forks", async () => {
  freshDb();
  seed("root-alone");
  assert.deepEqual(await collectSessionDescendants("root-alone"), ["root-alone"]);
});

test("collectSessionDescendants 跨目录：子目录里的 fork 也要一起删（旧实现只 readdir 平铺目录会漏）", async () => {
  freshDb();
  // 外部 pi 系工具的布局：`<proj>/<session>/forks/<ts>_<id>.jsonl`。库里 parent_id 已含
  // 全部副本，所以父子的 path 在不同目录、甚至文件早就不在盘上，一样整棵返回。
  seed("root", null, "/proj/2026-01-01T00-00-00Z_root.jsonl");
  seed("fork1", "root", "/proj/2026-01-01T00-00-00Z_root/forks/2026-01-01T00-10-00-000Z_fork1.jsonl");
  seed("fork2", "fork1", "/nonexistent/fork2.jsonl"); // 文件已不在盘上：库里仍要删

  assert.deepEqual((await collectSessionDescendants("root")).sort(), ["fork1", "fork2", "root"]);
});

test("collectSessionDescendants 防环：脏 parent_id 环不会死循环", async () => {
  freshDb();
  seed("a", "b");
  seed("b", "a");
  assert.deepEqual((await collectSessionDescendants("a")).sort(), ["a", "b"]);
});
