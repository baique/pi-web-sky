import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { extractSessionText, ensureSearchIndex, searchSessions, fuzzyQueryForTerm } =
  await jiti.import("./session-search.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
}

function makeSession(id, path, opts = {}) {
  return {
    path,
    id,
    cwd: "/tmp/proj",
    name: opts.name,
    created: "2026-08-27T00:00:00.000Z",
    modified: opts.modified ?? "2026-08-27T01:00:00.000Z",
    messageCount: 1,
    firstMessage: opts.firstMessage ?? "",
  };
}

const SAMPLE_LINES = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-08-27T00:00:00.000Z","cwd":"/tmp/proj"}',
  '{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-27T00:00:01.000Z","message":{"role":"user","content":"修复登录接口的 bug"}}',
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-27T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"我先改了 Token 逻辑"},{"type":"toolCall","id":"tc1","toolName":"read","input":{"path":"a.ts"}}]}}',
  '{"type":"message","id":"r1","parentId":"a1","timestamp":"2026-08-27T00:00:03.000Z","message":{"role":"toolResult","toolCallId":"tc1","content":[{"type":"text","text":"文件内容 ok"},{"type":"image","source":{"type":"base64","data":"QUFBQUFBQUFB"}}]}}',
  '{"type":"message","id":"b1","parentId":"r1","timestamp":"2026-08-27T00:00:04.000Z","message":{"role":"bashExecution","command":"npm test","output":"12 passed","excludeFromContext":true}}',
  '{"type":"compaction","id":"c1","parentId":"b1","timestamp":"2026-08-27T00:00:05.000Z","summary":"跳过早期讨论","firstKeptEntryId":"u1","tokensBefore":100}',
];

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-search-test-"));
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(dir, name), lines.join("\n"));
  }
  return dir;
}

test("extractSessionText pulls title, messages, tools, bash, compaction; skips base64", () => {
  const dir = fixtureDir({ "s1.jsonl": SAMPLE_LINES });
  try {
    const { title, body } = extractSessionText(makeSession("s1", join(dir, "s1.jsonl"), { name: "登录重构" }));
    assert.equal(title, "登录重构");
    assert.ok(body.includes("修复登录接口"), "user message");
    assert.ok(body.includes("Token 逻辑"), "assistant text");
    assert.ok(body.includes("[tool:read]"), "tool call name");
    assert.ok(body.includes('"path":"a.ts"'), "tool call input");
    assert.ok(body.includes("npm test"), "bash command");
    assert.ok(body.includes("12 passed"), "bash output");
    assert.ok(body.includes("跳过早期讨论"), "compaction summary");
    assert.ok(!body.includes("QUFBQUFBQUFB"), "base64 image data must be dropped");
    assert.ok(!body.includes("[image]"), "toolResult images must be omitted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSearchIndex re-indexes on mtime change, drops vanished sessions", async () => {
  freshDb();
  const dir = fixtureDir({ "s1.jsonl": SAMPLE_LINES });
  try {
    const session = makeSession("s1", join(dir, "s1.jsonl"), { name: "登录重构" });
    const first = await ensureSearchIndex([session]);
    assert.equal(first.indexing, true);
    const again = await ensureSearchIndex([session]);
    assert.equal(again.indexing, false, "unchanged mtime must be a no-op");

    const modified = { ...session, modified: "2026-08-27T02:00:00.000Z" };
    const reindexed = await ensureSearchIndex([modified]);
    assert.equal(reindexed.indexing, true, "mtime change must re-index");

    const dropped = await ensureSearchIndex([]);
    assert.equal(dropped.indexing, true);
    const results = await searchSessions("登录接口", 10, []);
    assert.equal(results.length, 0, "index must drop vanished sessions");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchSessions matches Chinese substring, 2-char LIKE fallback, English, titleMatch", async () => {
  freshDb();
  const dir = fixtureDir({ "s1.jsonl": SAMPLE_LINES });
  try {
    const s1 = makeSession("s1", join(dir, "s1.jsonl"), { name: "登录重构" });
    const s2 = {
      ...makeSession("s2", join(dir, "missing.jsonl"), {}),
      name: "SQLite FTS index",
    };
    const sessions = [s1, s2];

    // 4-char Chinese substring in body — title "登录重构" does NOT contain it,
    // so this is a pure body hit.
    const m1 = await searchSessions("登录接口", 10, sessions);
    assert.deepEqual(m1.map((r) => r.session.id), ["s1"]);
    assert.equal(m1[0].titleMatch, false);
    assert.ok(m1[0].snippet.length > 0, "snippet should carry highlight markers");

    // Title-hitting 4-char query sets titleMatch.
    const mTitle = await searchSessions("登录重构", 10, sessions);
    assert.deepEqual(mTitle.map((r) => r.session.id), ["s1"]);
    assert.equal(mTitle[0].titleMatch, true);

    // 2-char Chinese query — MATCH misses, LIKE fallback hits.
    const m2 = await searchSessions("登录", 10, sessions);
    assert.deepEqual(m2.map((r) => r.session.id), ["s1"]);

    // English word.
    const m3 = await searchSessions("fts", 10, sessions);
    assert.deepEqual(m3.map((r) => r.session.id), ["s2"]);
    assert.equal(m3[0].titleMatch, true);

    // No results.
    const none = await searchSessions("不存在的词xyz", 10, sessions);
    assert.equal(none.length, 0);

    // Quoted/special chars must not throw.
    const safe = await searchSessions('a"b', 10, sessions);
    assert.equal(safe.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fuzzyQueryForTerm escapes quotes into an FTS phrase", () => {
  assert.equal(fuzzyQueryForTerm('a"b'), '"a""b"');
  assert.equal(fuzzyQueryForTerm("登录"), '"登录"');
});