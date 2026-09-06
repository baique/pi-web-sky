import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { runSessionIndexScan, ensureSessionIndexReady, resetSessionIndexScannerForTests } = await jiti.import("./session-index-scanner.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-sidx-"));
  // 非 git 目录：resolveProject 走 catch → project_key = projectIdentityKey(cwd)
  const projDir = join(root, "--home-u-project-alpha--");
  mkdirSync(projDir, { recursive: true });
  return { root, projDir };
}

function sessionFileLines(id, cwd, firstUser = "hello", timestamp = "2026-01-01T00:00:00.000Z") {
  return [
    `{"type":"session","version":3,"id":"${id}","timestamp":"${timestamp}","cwd":"${cwd}"}`,
    `{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"${firstUser}"}}`,
  ].join("\n") + "\n";
}

test("runSessionIndexScan：新会话建行（header 读 first_message + mtime）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, sessionFileLines("aaa", "/home/u/project/alpha", "你好项目"));

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.inserted, 1);

    const row = getDb().prepare("SELECT * FROM session_meta WHERE session_id='aaa'").get();
    assert.equal(row.path, file);
    assert.equal(row.cwd, "/home/u/project/alpha");
    assert.equal(row.first_message, "你好项目");
    assert.equal(row.title, null);
    assert.ok(row.project_key, "project_key 已解析");
    assert.ok(row.modified > 0, "modified = 文件 mtime");
    assert.ok(row.created > 0, "created = header timestamp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：幂等（重复扫描不重复建行）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 0);
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM session_meta").get().n;
    assert.equal(n, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：mtime 变化只刷 modified，不重读", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, sessionFileLines("aaa", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    const before = getDb().prepare("SELECT modified FROM session_meta WHERE session_id='aaa'").get().modified;

    // 追加内容 → mtime 变
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(file, sessionFileLines("aaa", "/home/u/project/alpha", "hello") + '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":"hi"}}\n');
    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 1);
    const after = getDb().prepare("SELECT modified FROM session_meta WHERE session_id='aaa'").get().modified;
    assert.ok(after > before, "mtime 刷新");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：磁盘文件删除 → 删行", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));
    writeFileSync(join(projDir, "2026-01-02T00-00-00-000Z_bbb.jsonl"), sessionFileLines("bbb", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM session_meta").get().n, 2);

    rmSync(join(projDir, "2026-01-02T00-00-00-000Z_bbb.jsonl"));
    const summary = await runSessionIndexScan(root);
    assert.equal(summary.deleted, 1);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM session_meta").get().n, 1);
    assert.equal(getDb().prepare("SELECT session_id FROM session_meta").get().session_id, "aaa");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：parent 路径反查 parent_id", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const parentFile = join(projDir, "2026-01-01T00-00-00-000Z_parent.jsonl");
    const childFile = join(projDir, "2026-01-02T00-00-00-000Z_child.jsonl");
    writeFileSync(parentFile, sessionFileLines("parent", "/home/u/project/alpha"));
    writeFileSync(childFile, [
      `{"type":"session","version":3,"id":"child","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/home/u/project/alpha","parentSession":"${parentFile}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"fork 继续"}}',
    ].join("\n") + "\n");

    await runSessionIndexScan(root);
    const child = getDb().prepare("SELECT * FROM session_meta WHERE session_id='child'").get();
    assert.equal(child.parent_id, "parent");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：跨目录会话各自独立 project_key", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  const otherDir = join(root, "--home-u-project-beta--");
  mkdirSync(otherDir, { recursive: true });
  try {
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));
    writeFileSync(join(otherDir, "2026-01-01T00-00-00-000Z_bbb.jsonl"), sessionFileLines("bbb", "/home/u/project/beta"));
    await runSessionIndexScan(root);
    const rows = getDb().prepare("SELECT session_id, project_key FROM session_meta ORDER BY session_id").all();
    assert.equal(rows.length, 2);
    const keyOf = (sid) => rows.find((r) => r.session_id === sid).project_key;
    assert.notEqual(keyOf("aaa"), keyOf("bbb"), "不同 cwd → 不同 project_key");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSessionIndexReady：首轮后 ready，重复调用不重复扫", async () => {
  freshDb();
  resetSessionIndexScannerForTests();
  const { root, projDir } = makeRoot();
  try {
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));
    await ensureSessionIndexReady(root);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM session_meta").get().n, 1);
    // 第二次：已 ready，跳过扫描
    writeFileSync(join(projDir, "2026-01-03T00-00-00-000Z_ccc.jsonl"), sessionFileLines("ccc", "/home/u/project/alpha"));
    await ensureSessionIndexReady(root);
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM session_meta").get().n, 1, "ready 后不再扫");
    resetSessionIndexScannerForTests();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
