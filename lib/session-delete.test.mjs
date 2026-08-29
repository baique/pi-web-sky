import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { collectSessionDescendants } = await jiti.import("./session-delete.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");

function sessionFile(dir, id, parentPath) {
  const p = join(dir, `${Date.now()}_${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: dir,
    ...(parentPath ? { parentSession: parentPath } : {}),
  };
  writeFileSync(p, JSON.stringify(header) + "\n");
  return p;
}

test("collectSessionDescendants walks the whole fork tree (multi-level)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sd-"));
  try {
    const rootPath = sessionFile(dir, "root-id");
    const child1Path = sessionFile(dir, "child1", rootPath);
    sessionFile(dir, "child2", child1Path); // 两级分叉：child1 → child2
    sessionFile(dir, "unrelated", undefined); // 无 parentSession 的无关会话
    // 注入路径缓存，resolveSessionPath 命中后不触碰真实 sessions 目录。
    cacheSessionPath("root-id", rootPath);

    const ids = await collectSessionDescendants("root-id");
    assert.deepEqual(ids.sort(), ["root-id", "child1", "child2"].sort());
    assert.ok(!ids.includes("unrelated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectSessionDescendants returns the root alone when there are no forks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sd-"));
  try {
    const rootPath = sessionFile(dir, "root-alone");
    cacheSessionPath("root-alone", rootPath);
    assert.deepEqual(await collectSessionDescendants("root-alone"), ["root-alone"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
