import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanSessionFiles } = await jiti.import("./session-scanner.ts");

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  const projDir = join(root, "--home-wa-project-demo--");
  mkdirSync(projDir, { recursive: true });
  return { root, projDir };
}

test("scanSessionFiles：读取 header + 首条用户消息，忽略正文", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"aaa","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo","parentSession":"/x/bbb.jsonl"}',
      '{"type":"model_change","id":"m1","parentId":null,"provider":"p","modelId":"m","timestamp":"2026-01-01T00:00:01.000Z"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"你好，请帮我看看这个项目"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"好的，我看看"}]}}',
      '{"type":"message","id":"u2","parentId":"a1","message":{"role":"user","content":"再帮我优化一下"}}',
    ].join("\n") + "\n");

    const result = await scanSessionFiles(root);
    assert.equal(result.length, 1);
    const s = result[0];
    assert.equal(s.id, "aaa");
    assert.equal(s.cwd, "/home/wa/project/demo");
    assert.equal(s.firstMessage, "你好，请帮我看看这个项目");
    assert.equal(s.parentSessionPath, "/x/bbb.jsonl");
    assert.equal(s.created.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.ok(s.modified.getTime() > 0);
    assert.equal(typeof s.name, "undefined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：扫描读取最后一个 session_info 的自定义名", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_bbb.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"bbb","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"第一条消息"}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"旧名字","timestamp":"2026-01-01T00:00:05.000Z"}',
      '{"type":"session_info","id":"s2","parentId":"a1","name":"最终名字","timestamp":"2026-01-01T00:00:06.000Z"}',
    ].join("\n") + "\n");

    const result = await scanSessionFiles(root);
    assert.equal(result.length, 1);
    // 扫描直接读名字（反向分块），取最后一个 session_info。
    assert.equal(result[0].name, "最终名字");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：改名后大量新消息把 session_info 推远也能读到（旧 bug 场景）", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_far.jsonl");
    const lines = [
      '{"type":"session","version":3,"id":"far","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"深藏的名字","timestamp":"2026-01-01T00:00:05.000Z"}',
    ];
    const filler = "x".repeat(1024);
    for (let i = 0; i < 200; i++) {
      lines.push(`{"type":"message","id":"m${i}","parentId":"p","message":{"role":"assistant","content":"${filler}"}}`);
    }
    writeFileSync(file, lines.join("\n") + "\n");

    const result = await scanSessionFiles(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "深藏的名字");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：非会话文件（首行不是 session）跳过", async () => {
  const { root, projDir } = makeRoot();
  try {
    writeFileSync(join(projDir, "junk.jsonl"), '{"type":"message",...}\n');
    writeFileSync(join(projDir, "empty.jsonl"), "");
    const result = await scanSessionFiles(root);
    assert.equal(result.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：超大正文不影响扫描，只取首部简述", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_ccc.jsonl");
    // 中间故意放一个巨大的 assistant 消息（模拟大会话文件）。
    const hugeText = "x".repeat(1024 * 1024);
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"ccc","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"帮我写一篇文章"}}',
      `{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"${hugeText}"}]}}`,
      '{"type":"message","id":"u2","parentId":"a1","message":{"role":"user","content":"再改改"}}',
    ].join("\n") + "\n");

    const t0 = Date.now();
    const result = await scanSessionFiles(root);
    const elapsed = Date.now() - t0;
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "ccc");
    assert.equal(result[0].firstMessage, "帮我写一篇文章");
    assert.ok(elapsed < 2000, `大文件扫描应远快于读全量（实际 ${elapsed}ms）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：按 modified（文件 mtime）降序排序", async () => {
  const { root, projDir } = makeRoot();
  try {
    const old = join(projDir, "2026-01-01T00-00-00-000Z_old.jsonl");
    const fresh = join(projDir, "2026-01-02T00-00-00-000Z_new.jsonl");
    writeFileSync(old, '{"type":"session","version":3,"id":"old","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}\n');
    // 新文件 mtime 更新。
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(fresh, '{"type":"session","version":3,"id":"new","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/home/wa/project/demo"}\n');

    const result = await scanSessionFiles(root);
    assert.deepEqual(result.map((s) => s.id), ["new", "old"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFiles：缺失 timestamp 的 header 用 mtime 兜底", async () => {
  const { root, projDir } = makeRoot();
  try {
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_noTs.jsonl"), '{"type":"session","version":3,"id":"noTs","cwd":"/home/wa/project/demo"}\n');
    const result = await scanSessionFiles(root);
    assert.equal(result.length, 1);
    assert.ok(Number.isFinite(result[0].created.getTime()), "created 不可为 Invalid Date");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});