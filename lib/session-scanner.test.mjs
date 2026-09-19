import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanOneSessionFile, readSessionTail } = await jiti.import("./session-scanner.ts");

/** 单文件详情扫描（旧 scanSessionFiles 的全量入口已删：读取路径不再扫盘）。 */
function scanFile(file) {
  return scanOneSessionFile(file);
}

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "pi-scan-"));
  const projDir = join(root, "--home-wa-project-demo--");
  mkdirSync(projDir, { recursive: true });
  return { root, projDir };
}

test("scanSessionFileMeta：阶段一只解析文件名 id+mtime，不读内容", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"aaa","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"你好"}}',
    ].join("\n") + "\n");
    // 非会话 jsonl（首行不是 session）也应被列出——阶段一只认文件名，
    // 内容合法性由阶段二（scanOneSessionFile）把关。
    await new Promise((resolve) => setTimeout(resolve, 30));
    writeFileSync(join(projDir, "2026-01-02T00-00-00-000Z_junk.jsonl"), '{"type":"message"}\n');
    const result = await (await jiti.import("./session-scanner.ts")).scanSessionFileMeta(root);
    assert.equal(result.length, 2);
    const aaa = result.find((m) => m.id === "aaa");
    assert.ok(aaa, "文件名 UUID 段应解析为 id");
    assert.ok(aaa.modified instanceof Date && aaa.modified.getTime() > 0, "mtime 来自 stat");
    // 按 mtime 降序（junk 后写，mtime 更新，排前面）
    assert.equal(result[0].id, "junk");
    assert.equal(result[1].id, "aaa");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile：读取 header + 首条用户消息，忽略正文", async () => {
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

    const s = scanFile(file);
    assert.ok(s, "会话文件可扫描");
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

test("scanOneSessionFile：扫描读取最后一个 session_info 的自定义名", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_bbb.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"bbb","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"第一条消息"}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"旧名字","timestamp":"2026-01-01T00:00:05.000Z"}',
      '{"type":"session_info","id":"s2","parentId":"a1","name":"最终名字","timestamp":"2026-01-01T00:00:06.000Z"}',
    ].join("\n") + "\n");

    // 扫描直接读名字（反向分块），取最后一个 session_info。
    assert.equal(scanFile(file).name, "最终名字");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile：改名后大量新消息把 session_info 推远也能读到（旧 bug 场景）", async () => {
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

    assert.equal(scanFile(file).name, "深藏的名字");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile：非会话文件（首行不是 session）与空文件跳过", async () => {
  const { root, projDir } = makeRoot();
  try {
    const junk = join(projDir, "junk.jsonl");
    const empty = join(projDir, "empty.jsonl");
    writeFileSync(junk, '{"type":"message",...}\n');
    writeFileSync(empty, "");
    assert.equal(scanFile(junk), null, "首行不是 session → null");
    assert.equal(scanFile(empty), null, "空文件 → null");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile：超大正文不影响扫描，只取首部简述", async () => {
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
    const scanned = scanFile(file);
    const elapsed = Date.now() - t0;
    assert.equal(scanned.id, "ccc");
    assert.equal(scanned.firstMessage, "帮我写一篇文章");
    assert.ok(elapsed < 2000, `大文件扫描应远快于读全量（实际 ${elapsed}ms）`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSessionTail：文件尾一次反向分块同时拿自定义名与最后一条 assistant 回复", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_tail.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"tail","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"问题"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"第一条回复"}]}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"我的会话"}',
      '{"type":"message","id":"a2","parentId":"s1","message":{"role":"assistant","content":[{"type":"text","text":"最后一条回复"}]}}',
    ].join("\n") + "\n");

    assert.deepEqual(readSessionTail(file), { name: "我的会话", lastReply: "最后一条回复" });

    // 只有用户消息（没有回复）→ lastReply 为空串（调用方据此写 ''，与「读不出来」区分）
    const noReply = join(projDir, "2026-01-02T00-00-00-000Z_noreply.jsonl");
    writeFileSync(noReply, [
      '{"type":"session","version":3,"id":"noreply","timestamp":"2026-01-02T00:00:00.000Z","cwd":"/home/wa/project/demo"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"只有提问"}}',
    ].join("\n") + "\n");
    assert.deepEqual(readSessionTail(noReply), { name: undefined, lastReply: "" });

    // 文件不存在/为空 → null（调用方保持「未回填」，下一轮再试）
    assert.equal(readSessionTail(join(projDir, "missing.jsonl")), null);
    const empty = join(projDir, "empty-tail.jsonl");
    writeFileSync(empty, "");
    assert.equal(readSessionTail(empty), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readSessionTail 永不抛错：stat 能过但 open 失败（EACCES）/路径是目录 → null", async (t) => {
  const { root, projDir } = makeRoot();
  try {
    // 路径是目录：stat 成功、不是文件 → null（不需要 open）
    const dir = join(projDir, "a-directory.jsonl");
    mkdirSync(dir, { recursive: true });
    assert.equal(readSessionTail(dir), null, "目录不当会话文件");

    if (process.getuid?.() === 0) {
      t.diagnostic("以 root 运行：文件权限不生效，跳过「stat 可过但 open 失败」用例");
      return;
    }
    // stat 能过、openSync 抛 EACCES：readSessionTail 必须吞掉（它是回填循环里的逐行调用，
    // 抛出去会中止整轮扫描）。
    const noRead = join(projDir, "2026-01-03T00-00-00-000Z_noread.jsonl");
    writeFileSync(noRead, '{"type":"session","version":3,"id":"noread","cwd":"/x"}\n');
    chmodSync(noRead, 0o000);
    try {
      assert.equal(readSessionTail(noRead), null, "不可读文件 → null，不抛");
      assert.ok(statSync(noRead).size > 0, "stat 本身仍能过（确实是 stat 通过/open 失败）");
    } finally {
      chmodSync(noRead, 0o644);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile / scanOneSessionHead 永不抛错：stat 能过但 open 失败（EACCES）→ null", async (t) => {
  const { root, projDir } = makeRoot();
  try {
    const mod = await jiti.import("./session-scanner.ts");
    // 目录路径：stat 成功但 isFile() 为 false → null（不用 open）
    const dir = join(projDir, "2026-01-04T00-00-00-000Z_a-dir.jsonl");
    mkdirSync(dir, { recursive: true });
    assert.equal(mod.scanOneSessionFile(dir), null, "目录不当会话文件");
    assert.equal(mod.scanOneSessionHead(dir), null);

    if (process.getuid?.() === 0) {
      t.diagnostic("以 root 运行：文件权限不生效，跳过「stat 可过但 open 失败」用例");
      return;
    }
    // stat 能过、openSync 抛 EACCES：详情读取路径不能把异常抛给调用方
    // （/api/sessions/summary 的「库内无行」回退——旧 bug 会让接口 500）。
    const noRead = join(projDir, "2026-01-03T00-00-00-000Z_noread.jsonl");
    writeFileSync(noRead, '{"type":"session","version":3,"id":"noread","cwd":"/x"}\n');
    chmodSync(noRead, 0o000);
    try {
      assert.ok(statSync(noRead).size > 0, "stat 本身仍能过（确实是 stat 通过/open 失败）");
      assert.equal(mod.scanOneSessionFile(noRead), null, "详情读取：open 失败 → null，不抛");
      assert.equal(mod.scanOneSessionHead(noRead), null, "头部读取：open 失败 → null，不抛");
    } finally {
      chmodSync(noRead, 0o644);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionFile：缺失 timestamp 的 header 用 mtime 兜底", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_noTs.jsonl");
    writeFileSync(file, '{"type":"session","version":3,"id":"noTs","cwd":"/home/wa/project/demo"}\n');
    assert.ok(Number.isFinite(scanFile(file).created.getTime()), "created 不可为 Invalid Date");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scanSessionFileMeta：递归进子目录（forks/、<session>/<run>/run-0/），隐藏目录不扫", async () => {
  const { root, projDir } = makeRoot();
  try {
    const sessionDir = join(projDir, "2026-01-01T00-00-00-000Z_aaa");
    const forksDir = join(sessionDir, "forks");
    const runDir = join(sessionDir, "run-1", "run-0");
    const hiddenDir = join(projDir, ".hidden");
    mkdirSync(forksDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), '{"type":"session","version":3,"id":"aaa","cwd":"/x"}\n');
    writeFileSync(join(forksDir, "2026-01-01T00-10-00-000Z_fork1.jsonl"), '{"type":"session","version":3,"id":"fork1","cwd":"/x"}\n');
    writeFileSync(join(runDir, "session.jsonl"), '{"type":"session","version":3,"id":"run1","cwd":"/x"}\n');
    writeFileSync(join(hiddenDir, "2026-01-01T00-00-00-000Z_hidden.jsonl"), '{"type":"session","version":3,"id":"hidden","cwd":"/x"}\n');

    const mod = await jiti.import("./session-scanner.ts");
    const result = await mod.scanSessionFileMeta(root);
    assert.deepEqual(result.map((m) => m.id).sort(), ["", "aaa", "fork1"], "三个会话文件（含子目录）；隐藏目录不算");
    const nameless = result.find((m) => m.path.endsWith("session.jsonl"));
    assert.equal(nameless.id, "", "没有 `<timestamp>_<id>` 前缀的名字返回空串提示，id 交给 header");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanSessionFileMeta：超深目录不扫（深度上限护住每轮扫描成本）", async () => {
  const { root, projDir } = makeRoot();
  try {
    let deep = projDir;
    for (let i = 0; i < 10; i += 1) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "2026-01-01T00-00-00-000Z_deep.jsonl"), '{"type":"session","version":3,"id":"deep"}\n');
    const mod = await jiti.import("./session-scanner.ts");
    assert.deepEqual(await mod.scanSessionFileMeta(root), [], "超出深度上限的目录不进入扫描");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanOneSessionHead：只读 header + 首条消息，不含自定义名/lastReply", async () => {
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, [
      '{"type":"session","version":3,"id":"aaa","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/wa/project/demo","parentSession":"/x/bbb.jsonl"}',
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"你好项目"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"回复"}]}}',
      '{"type":"session_info","id":"s1","parentId":"a1","name":"自定义名"}',
    ].join("\n") + "\n");
    const mod = await jiti.import("./session-scanner.ts");
    const head = mod.scanOneSessionHead(file);
    assert.ok(head);
    assert.equal(head.id, "aaa");
    assert.equal(head.cwd, "/home/wa/project/demo");
    assert.equal(head.firstMessage, "你好项目");
    assert.equal(head.parentSessionPath, "/x/bbb.jsonl");
    // 不含尾部字段（区别于 scanOneSessionFile）
    assert.ok(!("name" in head));
    assert.ok(!("lastReply" in head));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
