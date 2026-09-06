import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

test("runSessionIndexScan：已存在归属行（task_id）的会话被 upsert 不丢归属", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // 预置一行：已归属任务的旧会话（模拟 T1 前 session_meta 里的行）
    getDb().prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned) VALUES ('aaa', 'task-9', 100, 1)").run();
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 1, "老行补全索引列计为 insert（幂等内自洽）");
    const row = getDb().prepare("SELECT * FROM session_meta WHERE session_id='aaa'").get();
    assert.equal(row.task_id, "task-9", "upsert 不覆盖已有 task_id");
    assert.equal(row.pinned, 1, "upsert 不覆盖已有 pinned");
    assert.ok(row.path && row.project_key, "upsert 补全索引列");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：mtime 变化时重挂（header.parentSession 变）→ parent_id 收敛", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const oldParent = join(projDir, "2026-01-01T00-00-00-000Z_oldparent.jsonl");
    const newParent = join(projDir, "2026-01-03T00-00-00-000Z_newparent.jsonl");
    const childFile = join(projDir, "2026-01-02T00-00-00-000Z_child.jsonl");
    writeFileSync(oldParent, sessionFileLines("oldparent", "/home/u/project/alpha"));
    writeFileSync(newParent, sessionFileLines("newparent", "/home/u/project/alpha"));
    writeFileSync(childFile, [
      `{"type":"session","version":3,"id":"child","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/home/u/project/alpha","parentSession":"${oldParent}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"fork"}}',
    ].join("\n") + "\n");
    await runSessionIndexScan(root);
    assert.equal(getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='child'").get().parent_id, "oldparent");

    // 删除 oldparent + 重挂 child 到 newparent（DELETE API 行为：header 重写 → mtime 变）
    rmSync(oldParent);
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(childFile, [
      `{"type":"session","version":3,"id":"child","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/home/u/project/alpha","parentSession":"${newParent}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"fork"}}',
    ].join("\n") + "\n");

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.deleted, 1, "oldparent 文件没了 → 删行");
    const row = getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='child'").get();
    assert.equal(row.parent_id, "newparent", "重挂后 parent_id 收敛到新父");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：库有行 + path 文件存在（扫描快照外新建）→ 不误删", async () => {
  freshDb();
  const { root } = makeRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "pi-sidx-out-"));
  try {
    // 模拟 persist 刚建行 + 文件落盘，但落在扫描根之外（本轮磁盘快照不含该 id）
    const file = join(outsideDir, "2026-01-01T00-00-00-000Z_zzz.jsonl");
    writeFileSync(file, sessionFileLines("zzz", "/home/u/project/alpha"));
    getDb().prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES ('zzz', NULL, 1, 0, ?)").run(file);

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.deleted, 0, "文件存在 → 不删（等下一轮快照收敛）");
    assert.ok(getDb().prepare("SELECT session_id FROM session_meta WHERE session_id='zzz'").get(), "行保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：同 id 多历史文件 → 只认最新 mtime，path 指向最新", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const oldFile = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(oldFile, sessionFileLines("aaa", "/home/u/project/alpha", "旧"));
    await new Promise((r) => setTimeout(r, 10));
    const newFile = join(projDir, "2026-01-02T00-00-00-000Z_aaa.jsonl");
    writeFileSync(newFile, sessionFileLines("aaa", "/home/u/project/alpha", "新"));

    const s1 = await runSessionIndexScan(root);
    assert.equal(s1.inserted, 1, "同 id 只建一行");
    assert.equal(s1.scanned, 1, "扫描数按去重后的 id 计");
    const row = getDb().prepare("SELECT path, first_message FROM session_meta WHERE session_id='aaa'").get();
    assert.equal(row.path, newFile, "path 指向最新文件");
    assert.equal(row.first_message, "新", "first_message 来自最新文件");

    // 幂等：第二遍无变化
    const s2 = await runSessionIndexScan(root);
    assert.equal(s2.inserted, 0);
    assert.equal(s2.updated, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
