import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { runSessionIndexScan, ensureSessionIndexReady, resetSessionIndexScannerForTests, indexSessionFileNow } = await jiti.import("./session-index-scanner.ts");

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

test("runSessionIndexScan：列表代次只在本轮真变更时自增（有变更推一次，空轮不推）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const generation = () => globalThis.__piSessionListGeneration ?? 0;
    const before = generation();

    await runSessionIndexScan(root); // 磁盘空：无变更
    assert.equal(generation(), before, "空轮不推代次（否则每 30s 白刷一次前端列表）");

    writeFileSync(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), sessionFileLines("aaa", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    assert.equal(generation(), before + 1, "外部/CLI 新建的会话入索引 → 推一次（侧栏 ≤2.5s 就能看到它）");

    const afterInsert = generation();
    await runSessionIndexScan(root); // 再扫：幂等无变更
    assert.equal(generation(), afterInsert, "幂等轮不推");

    await indexSessionFileNow(join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl"), null, null);
    assert.equal(generation(), afterInsert + 1, "单文件立即索引 → 也推一次（fork/引用分支当场进列表）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：mtime 变化刷 modified + 回填 first_message（文件是内容事实源）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // 模拟 persistNewSessionFile 建行：文件尚无消息 → first_message NULL
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, [
      `{"type":"session","version":3,"id":"aaa","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/u/project/alpha"}`,
    ].join("\n") + "\n");
    await runSessionIndexScan(root);
    assert.equal(getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='aaa'").get().first_message, null, "无消息 → NULL");
    const before = getDb().prepare("SELECT modified FROM session_meta WHERE session_id='aaa'").get().modified;

    // 用户发首条消息 → 文件 mtime 变
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(file, sessionFileLines("aaa", "/home/u/project/alpha", "你好项目") + '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":"hi"}}\n');
    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 1);
    const after = getDb().prepare("SELECT modified FROM session_meta WHERE session_id='aaa'").get().modified;
    assert.ok(after > before, "mtime 刷新");
    const row = getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='aaa'").get();
    assert.equal(row.first_message, "你好项目", "mtime 分支回填 first_message");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：first_message 历史欠账（NULL 且 mtime 未变）→ 补跑回填", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(file, sessionFileLines("aaa", "/home/u/project/alpha", "历史首条"));
    await runSessionIndexScan(root);
    // 模拟老行欠账：文件有消息但 first_message 被清成 NULL（persist 建行冻结场景）
    getDb().prepare("UPDATE session_meta SET first_message = NULL WHERE session_id='aaa'").run();

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 0);
    assert.equal(summary.updated, 1, "NULL 行补跑计入 updated");
    const row = getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='aaa'").get();
    assert.equal(row.first_message, "历史首条", "mtime 未变也回填");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：扫描回填 last_reply（存量行只读一次文件尾，无回复写 ''）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // 存量行（升级前建的）：last_reply 为 NULL → 本轮读一次文件尾回填
    const withReply = join(projDir, "2026-01-01T00-00-00-000Z_reply.jsonl");
    writeFileSync(withReply, sessionFileLines("reply", "/home/u/project/alpha") +
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"最后一条回复"}]}}\n');
    const noReply = join(projDir, "2026-01-02T00-00-00-000Z_quiet.jsonl");
    writeFileSync(noReply, sessionFileLines("quiet", "/home/u/project/alpha"));
    const insert = getDb().prepare(
      "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, created, modified) VALUES (?, NULL, 1, 0, ?, 1, ?)",
    );
    insert.run("reply", withReply, statSync(withReply).mtime.getTime());
    insert.run("quiet", noReply, statSync(noReply).mtime.getTime());

    const summary = await runSessionIndexScan(root);
    const reply = getDb().prepare("SELECT last_reply, modified FROM session_meta WHERE session_id='reply'").get();
    const quiet = getDb().prepare("SELECT last_reply FROM session_meta WHERE session_id='quiet'").get();
    assert.equal(reply.last_reply, "最后一条回复");
    assert.equal(quiet.last_reply, "", "无回复 → ''（已回填，不再读文件）");
    assert.equal(reply.modified, statSync(withReply).mtime.getTime(), "回填不碰 modified");
    assert.ok(summary.updated >= 2, "回填写入计入 updated");

    // 幂等：已回填（非 NULL）的行下一轮不再读文件尾。把文件换成「没有回复」的内容
    // （mtime 随之变化 → 走 mtime 分支 + first_message 收敛），last_reply 必须保持原值。
    writeFileSync(withReply, sessionFileLines("reply", "/home/u/project/alpha", "改过的首条"));
    await runSessionIndexScan(root);
    const after = getDb().prepare("SELECT last_reply, first_message FROM session_meta WHERE session_id='reply'").get();
    assert.equal(after.last_reply, "最后一条回复", "已回填的值不被后续扫描覆盖");
    assert.equal(after.first_message, "改过的首条", "同轮其他派生列照常收敛");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：不可读文件不中止回填（EACCES 行保持 NULL，其余行照常回填）", async (t) => {
  freshDb();
  const { root, projDir } = makeRoot();
  const openFailed = join(mkdtempSync(join(tmpdir(), "pi-sidx-unreadable-")), "2026-01-02T00-00-00-000Z_broken.jsonl");
  try {
    if (process.getuid?.() === 0) {
      t.diagnostic("以 root 运行：文件权限不生效，跳过（无法构造 open 失败）");
      return;
    }
    // aaa（可读）：回填要成功；broken（stat 能过、open EACCES）：保持 NULL，且不能让
    // 整轮扫描抛出去（否则同一行每轮都被重新命中 → 它后面的行永远得不到回填）。
    const okFile = join(projDir, "2026-01-01T00-00-00-000Z_aaa.jsonl");
    writeFileSync(okFile, sessionFileLines("aaa", "/home/u/project/alpha") +
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"回填成功"}]}}\n');
    writeFileSync(openFailed, '{"type":"session","version":3,"id":"broken","cwd":"/home/u/project/alpha"}\n');
    chmodSync(openFailed, 0o000);
    const insert = getDb().prepare(
      "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, created, modified) VALUES (?, NULL, 1, 0, ?, 1, ?)",
    );
    insert.run("aaa", okFile, statSync(okFile).mtime.getTime());
    // broken 行：path 指向不可读文件；行不在磁盘快照里（所在目录不在扫描根下）→ 不受删除分支影响
    insert.run("broken", openFailed, Date.now());

    const summary = await runSessionIndexScan(root); // 不得抛
    assert.equal(summary.scanned, 1, "只有 aaa 在扫描根内");
    const rows = getDb()
      .prepare("SELECT session_id, last_reply FROM session_meta ORDER BY session_id")
      .all()
      .map((r) => [r.session_id, r.last_reply]);
    assert.deepEqual(rows, [["aaa", "回填成功"], ["broken", null]], "可读行回填、不可读行保持 NULL（未回填）");
  } finally {
    rmSync(openFailed.slice(0, openFailed.lastIndexOf("/")), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：path 指向不存在的文件 → last_reply 保持 NULL（下一轮再试）", async () => {
  freshDb();
  const { root } = makeRoot();
  try {
    getDb()
      .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES ('ghost', NULL, ?, 0, ?)")
      .run(Date.now(), join(root, "--p--", "2026-01-01T00-00-00-000Z_ghost.jsonl"));
    const summary = await runSessionIndexScan(root);
    assert.equal(summary.deleted, 0, "年轻行保护：不删");
    assert.equal(
      getDb().prepare("SELECT last_reply FROM session_meta WHERE session_id='ghost'").get().last_reply,
      null,
      "读不出文件尾 → 保持 NULL（三态里的「未回填」）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：modified 单调——事件链路刚写的「现在就活跃」不被更旧的 mtime 拉回", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_act.jsonl");
    writeFileSync(file, sessionFileLines("act", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    // 事件链路（agent_settled/agent_start）刚把 modified 推到「现在」（> 文件 mtime）。
    // 列表读取会触发懒初始化扫描 → 这个窗口是可达路径，扫描器不能把它拉回去。
    const eventTime = Date.now() + 60_000;
    getDb().prepare("UPDATE session_meta SET modified = ?, first_message = 'hello' WHERE session_id='act'").run(eventTime);
    // 让 mtime 与库里 modified 差（改文件但把 mtime 往早调，模拟「事件写入比 mtime 新」）
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(file, past, past);

    // 「mtime 没前移」等于「没有变化」：不能再进 mtime 分支（否则每 30s 多读一次 header
    // + 记一次幻影 updated，幂等扫描不成立），所以 summary.updated 必须是 0。
    const quiet = await runSessionIndexScan(root);
    assert.equal(quiet.updated, 0, "库内 modified 更新时，更旧的 mtime 不算变化（无幻影 updated）");
    const row = getDb().prepare("SELECT modified FROM session_meta WHERE session_id='act'").get();
    assert.equal(row.modified, eventTime, "扫描不把 modified 往旧的方向拉（单调）");

    // 反向：文件 mtime 更新（会话真的又活跃了）→ 正常前移
    const future = new Date(eventTime + 3_600_000);
    utimesSync(file, future, future);
    const ahead = await runSessionIndexScan(root);
    assert.equal(ahead.updated, 1, "mtime 前移照走更新分支");
    assert.equal(
      getDb().prepare("SELECT modified FROM session_meta WHERE session_id='act'").get().modified,
      future.getTime(),
      "更新的 mtime 照常写入",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runSessionIndexScan：path 迁移走 upsert（ON CONFLICT）时也不把事件写的 modified 拉回", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // 旧行：path 指向早已不存在的旧位置（模拟文件被移动/重写），modified 由事件链路写成「现在」。
    // 这一轮走 INSERT ... ON CONFLICT 分支修正 path——modified 必须单调，不能被更旧的 mtime 覆盖。
    const movedFile = join(projDir, "2026-01-20T00-00-00-000Z_mv.jsonl");
    writeFileSync(movedFile, sessionFileLines("mv", "/home/u/project/alpha", "移动后"));
    const eventTime = Date.now() + 60_000;
    getDb()
      .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, created, modified) VALUES ('mv', NULL, 1, 0, ?, 1, ?)")
      .run(join(projDir, "2026-01-01T00-00-00-000Z_mv.jsonl"), eventTime);

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 1, "path 变化 → 走 upsert 修正");
    const row = getDb().prepare("SELECT path, modified FROM session_meta WHERE session_id='mv'").get();
    assert.equal(row.path, movedFile, "path 跟随最新文件");
    assert.equal(row.modified, eventTime, "upsert 不把事件写的 modified 拉回旧 mtime（单调）");
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
    // 行「成年」后再删文件：新建 60s 内的行有删除保护（见下文「年轻行保护」用例），
    // 这条用例只关心「文件确实被删 → 行被删」的收敛行为。
    ageRow("bbb");
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
    ageRow("oldparent"); // 同上：绕开新建 60s 内的删除保护，只验删除收敛
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

/** 把一行的时间戳推老（绕过新建 60s 内的删除保护，见「年轻行保护」用例）。 */
function ageRow(sessionId) {
  getDb().prepare("UPDATE session_meta SET updated = ? WHERE session_id = ?").run(Date.now() - 120_000, sessionId);
}

/** 带 header.parentSession 的会话文件内容（本文件既有 header 写法 + 父路径）。 */
function sessionLinesWithParent(id, cwd, parentPath) {
  return [
    `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${cwd}","parentSession":"${parentPath}"}`,
    '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"fork"}}',
  ].join("\n") + "\n";
}

test("扫描收敛：父会话归属任务、子会话 task_id 为空 → 子会话继承父归属", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidx-affil-"));
  const proj = join(dir, "--p--");
  mkdirSync(proj, { recursive: true });
  try {
    const parentPath = join(proj, "2026-01-01T00-00-00-000Z_parent.jsonl");
    const childPath = join(proj, "2026-01-01T00-01-00-000Z_child.jsonl");
    writeFileSync(parentPath, sessionFileLines("parent", "/tmp/proj"));
    writeFileSync(childPath, sessionLinesWithParent("child", "/tmp/proj", parentPath));
    const db = new DatabaseSync(":memory:");
    setDbForTesting(db);
    db.prepare("INSERT INTO tasks (id, project_key, name, created, updated) VALUES ('T','/tmp/proj','t',1,1)").run();
    db.prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES ('parent','T',1,0,?)").run(parentPath);
    await runSessionIndexScan(dir);
    assert.equal(db.prepare("SELECT task_id FROM session_meta WHERE session_id='child'").get().task_id, "T");
    assert.equal(db.prepare("SELECT parent_id FROM session_meta WHERE session_id='child'").get().parent_id, "parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫描收敛：多层脏链（A 有归属、B/C 为空）一轮扫描全部收敛", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidx-affil2-"));
  const proj = join(dir, "--p--");
  mkdirSync(proj, { recursive: true });
  try {
    const aPath = join(proj, "2026-01-01T00-00-00-000Z_A.jsonl");
    const bPath = join(proj, "2026-01-01T00-01-00-000Z_B.jsonl");
    const cPath = join(proj, "2026-01-01T00-02-00-000Z_C.jsonl");
    writeFileSync(aPath, sessionFileLines("A", "/tmp/proj"));
    writeFileSync(bPath, sessionLinesWithParent("B", "/tmp/proj", aPath));
    writeFileSync(cPath, sessionLinesWithParent("C", "/tmp/proj", bPath));
    const db = new DatabaseSync(":memory:");
    setDbForTesting(db);
    const insert = db.prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES (?,?,1,0,?)");
    insert.run("A", "T", aPath);
    insert.run("B", null, bPath);
    insert.run("C", null, cPath);
    await runSessionIndexScan(dir);
    // node:sqlite 返回 null-prototype 行对象 → 转成数组元组再断言（与 deepEqual 的严格原型比较无关）
    const rows = db.prepare("SELECT session_id, task_id FROM session_meta ORDER BY session_id").all()
      .map((r) => [r.session_id, r.task_id]);
    assert.deepEqual(rows, [["A", "T"], ["B", "T"], ["C", "T"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫描递归：forks/ 与 <session>/<run>/run-0/ 子目录里的会话同样入库，父子链正确", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidx-nested-"));
  const proj = join(dir, "--p--");
  const rootFile = join(proj, "2026-01-01T00-00-00-000Z_root.jsonl");
  const forksDir = join(proj, "2026-01-01T00-00-00-000Z_root", "forks");
  const runDir = join(proj, "2026-01-01T00-00-00-000Z_root", "run-1", "run-0");
  try {
    mkdirSync(forksDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(rootFile, sessionFileLines("root", "/tmp/proj"));
    writeFileSync(join(forksDir, "2026-01-01T00-10-00-000Z_fork1.jsonl"), sessionLinesWithParent("fork1", "/tmp/proj", rootFile));
    writeFileSync(join(runDir, "session.jsonl"), sessionLinesWithParent("run1", "/tmp/proj", rootFile));
    writeFileSync(join(proj, "transcript.jsonl"), '{"type":"message","role":"user","content":"x"}\n');
    const db = new DatabaseSync(":memory:");
    setDbForTesting(db);

    const summary = await runSessionIndexScan(dir);
    const rows = db.prepare("SELECT session_id, parent_id, task_id FROM session_meta ORDER BY session_id").all()
      .map((r) => [r.session_id, r.parent_id, r.task_id]);
    assert.equal(summary.scanned, 3, "只认 3 个会话文件（transcript.jsonl 非会话被跳过）");
    assert.deepEqual(rows, [
      ["fork1", "root", null],
      ["root", null, null],
      ["run1", "root", null],
    ], "子目录里的会话也入库，父子链按全量 path 反查");
    assert.ok(rows.every((r) => r[2] === null), "磁盘有、库无的会话＝临时会话（task_id NULL）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫描：库行按 path 精确匹配（会话文件移到子目录 → path 跟随，不另建行也不留旧行）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_mv.jsonl");
    writeFileSync(file, sessionFileLines("mv", "/home/u/project/alpha", "移动前"));
    await runSessionIndexScan(root);
    assert.equal(getDb().prepare("SELECT path FROM session_meta WHERE session_id='mv'").get().path, file);

    // 同一会话文件被搬到子目录（旧 path 消失）：path 是会话与文件的唯一绑定，
    // 新文件用 header 权威 id 认回同一行 → 修正 path，不另建行、不把旧行留下。
    const movedDir = join(projDir, "2026-01-01T00-00-00-000Z_mv", "forks");
    mkdirSync(movedDir, { recursive: true });
    const moved = join(movedDir, "2026-01-20T00-00-00-000Z_mv.jsonl");
    renameSync(file, moved);

    const summary = await runSessionIndexScan(root);
    const rows = getDb().prepare("SELECT session_id, path FROM session_meta").all().map((r) => [r.session_id, r.path]);
    assert.deepEqual(rows, [["mv", moved]], "只有一行，path 指向移动后的文件");
    assert.equal(summary.deleted, 0, "库行仍在磁盘上（换了路径）→ 不删");
    assert.equal(summary.inserted, 1, "库行 path 变 → 按 upsert 修正路径（计 inserted，与既有约定一致）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扫描：新建 60s 内的行即使磁盘上没有文件也不删（subagent 惰性落盘窗口）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // persist/subagent 建行先于文件 flush：path 指向尚未落盘的文件。
    // 此时删行会让会话在列表里闪断（再建行又丢归属），故只跳过、下一轮再判。
    const file = join(projDir, "2026-01-01T00-00-00-000Z_sg.jsonl");
    getDb().prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES ('sg', NULL, ?, 0, ?)").run(Date.now(), file);

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.deleted, 0, "年轻行跳过删除");
    assert.ok(getDb().prepare("SELECT session_id FROM session_meta WHERE session_id='sg'").get(), "行保留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扫描：upsert 不刷新 updated（否则每轮都把自己的行变『年轻』，删除分支永不生效）", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_keep.jsonl");
    writeFileSync(file, sessionFileLines("keep", "/home/u/project/alpha"));
    await runSessionIndexScan(root);
    const baseline = getDb().prepare("SELECT updated FROM session_meta WHERE session_id='keep'").get().updated;

    // ① 无变化的一轮：没有任何写入路径该碰 updated
    await runSessionIndexScan(root);
    assert.equal(getDb().prepare("SELECT updated FROM session_meta WHERE session_id='keep'").get().updated, baseline, "无变化轮不碰 updated");

    // ② 走 ON CONFLICT 分支的一轮（会话文件被移动到子目录 → path 修正）：updated 同样不变。
    // 若后人把 `updated = excluded.updated` 加进冲突分支（让行每次都变「年轻」、外部删除
    // 永不收敛），这条断言就会因 updated 被刷成新的 now 而失败（静默失败的护栏）。
    await new Promise((r) => setTimeout(r, 10)); // 保证刷新后的 now 与 baseline 至少差 1ms
    const movedDir = join(projDir, "2026-01-01T00-00-00-000Z_keep", "forks");
    mkdirSync(movedDir, { recursive: true });
    const moved = join(movedDir, "2026-01-30T00-00-00-000Z_keep.jsonl");
    renameSync(file, moved);
    const summary = await runSessionIndexScan(root);
    const after = getDb().prepare("SELECT updated, path FROM session_meta WHERE session_id='keep'").get();
    assert.equal(summary.inserted, 1, "path 修正走 upsert（ON CONFLICT 分支）");
    assert.equal(after.path, moved, "path 跟随移动后的文件");
    assert.equal(after.updated, baseline, "upsert 不刷新 updated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("扫描 upsert（ON CONFLICT）：不带首条消息的一轮不擦库内已有 first_message", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    // 文件只有 header、没有 user 消息 → head.firstMessage = "" → upsert 传 NULL。
    // 库行已有一条首条消息（历史收敛值）：path 修正的一轮不得把它擦掉。
    const file = join(projDir, "2026-01-01T00-00-00-000Z_keep.jsonl");
    writeFileSync(file, `{"type":"session","version":3,"id":"keep","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/u/project/alpha"}\n`);
    getDb()
      .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, first_message, created, modified) VALUES ('keep', NULL, 1, 0, ?, '历史首条', 1, 1)")
      .run(join(projDir, "2026-01-01T00-00-00-000Z_moved.jsonl"));

    const summary = await runSessionIndexScan(root);
    assert.equal(summary.inserted, 1, "path 变化 → 走 upsert（ON CONFLICT 分支）");
    const row = getDb().prepare("SELECT path, first_message FROM session_meta WHERE session_id='keep'").get();
    assert.equal(row.path, file, "path 照常修正");
    assert.equal(row.first_message, "历史首条", "已有首条消息不被无消息文件的 upsert 擦成 NULL（COALESCE）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("indexSessionFileNow：不带首条消息的 upsert 不擦库内已有 first_message", async () => {
  freshDb();
  const { root, projDir } = makeRoot();
  try {
    const file = join(projDir, "2026-01-01T00-00-00-000Z_ifn.jsonl");
    writeFileSync(file, `{"type":"session","version":3,"id":"ifn","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/u/project/alpha"}\n`);
    getDb()
      .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, first_message, created, modified) VALUES ('ifn', NULL, 1, 0, ?, '历史首条', 1, 1)")
      .run(join(projDir, "2026-01-01T00-00-00-000Z_old.jsonl"));

    await indexSessionFileNow(file, null, null);
    const row = getDb().prepare("SELECT path, first_message FROM session_meta WHERE session_id='ifn'").get();
    assert.equal(row.path, file, "path 修正到新文件");
    assert.equal(row.first_message, "历史首条", "fork_branch 单文件索引不得擦掉已有首条消息");
  } finally {
    rmSync(root, { recursive: true, force: true });
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
