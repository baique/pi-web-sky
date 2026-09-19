import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent，也不跑真实 subagent。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-subagent-title-"));
mkdirSync(join(agentDir, "sessions"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { fillFirstMessageIfEmpty } = await jiti.import("./task-store.ts");
const { ensureSubagentSessionRow } = await jiti.import("./subagent-runtime.ts");

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
  const db = getDb();
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** 内置 subagent 出生即建行，与 lib/subagent-runtime.ts start() 里同参数。
 *  只收 request.description：run 元数据里的 profile 显示名**不是**标题来源。 */
function buildRow(db, sessionId, { description, parentId = "parent-session" }) {
  ensureSubagentSessionRow(sessionId, {
    path: `/tmp/sessions/${sessionId}.jsonl`,
    cwd: "/tmp",
    projectKey: "proj",
    parentId,
    taskId: null,
    description,
  });
  return db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId);
}

test("description 有值即标题：建行时 title = trim 后的 description（不依赖首条消息兜底）", () => {
  const db = freshDb();
  const row = buildRow(db, "child-named", { description: "  Inspect parser  " });

  assert.equal(row.title, "Inspect parser");
  assert.equal(row.parent_id, "parent-session");
});

test("description 空白/空 → title 为 NULL（不写空串；profile 显示名也不许兜底成标题）", () => {
  const db = freshDb();

  // 空 description 的子代理，run 元数据里仍有 profile.displayName（"Explore"/"Plan" 之类）。
  // 建行时只拿得到 request.description，标题必须是 NULL——展示回退到被委派任务的原文，
  // 而不是显示 "Explore"。
  for (const [sessionId, description] of [["child-blank", "   "], ["child-empty", ""], ["child-newline", " \n "]]) {
    const row = buildRow(db, sessionId, { description });
    assert.equal(row.title, null, `${sessionId} 不应写入空串/空白/profile 名标题`);
  }
});

test("老兜底口已关闭：实参里就算带上元数据描述，空 description 的 title 仍为 NULL", () => {
  const db = freshDb();
  // 元数据描述（metadata.description = profile.displayName）曾是标题兜底来源，
  // 现在建行函数不认这个字段——它不得从任何旁路挤进 title。
  ensureSubagentSessionRow("child-extra", {
    path: "/tmp/sessions/child-extra.jsonl",
    cwd: "/tmp",
    projectKey: "proj",
    parentId: "parent-session",
    taskId: null,
    description: "   ",
    fallbackDescription: "Explore",
  });

  const row = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("child-extra");
  assert.equal(row.title, null, "profile 显示名不得变成子会话标题");
});

test("first_message 不再写 description：留 NULL，由真实首条用户消息回填", () => {
  const db = freshDb();
  const row = buildRow(db, "child-first", { description: "Inspect parser" });

  assert.equal(row.first_message, null, "描述不是首条消息，不应占用内容派生列");

  // 内容派生列的回填路径（扫描器/事件链路同语义）在其上照常工作。
  fillFirstMessageIfEmpty("child-first", "Find the parser");
  const filled = db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get("child-first");
  assert.equal(filled.first_message, "Find the parser");
  assert.equal(filled.title, "Inspect parser", "回填首条消息不动自定义标题");
});

/** 从 `ensureSubagentSessionRow(inner.sessionId` 起按花括号配对取出实参块。 */
function subagentRowCallArgs(source) {
  const start = source.indexOf("ensureSubagentSessionRow(inner.sessionId");
  assert.ok(start >= 0, "start() 里找不到 ensureSubagentSessionRow(inner.sessionId 调用点");
  const open = source.indexOf("{", start);
  assert.ok(open > start, "调用点后面找不到实参对象");
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("建行调用的实参对象没有闭合");
}

test("start() 接线：标题来源只有 request.description，不传 firstMessage/元数据描述", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const args = subagentRowCallArgs(source);

  assert.match(args, /description: request\.description/, "标题来源必须是 request.description");
  assert.doesNotMatch(args, /firstMessage/, "first_message 是内容派生列，建行时不能写");
  assert.doesNotMatch(args, /fallbackDescription|displayName|metadata\.description/, "profile 显示名不算标题");
  assert.match(args, /parentId: parentSessionId/, "父会话归属丢了，子会话会在聊天区当孤儿根");
  assert.match(args, /taskId: taskForSession\(parentSessionId\)/, "任务归属继承丢了");
  assert.doesNotMatch(source, /firstMessage: request\.description/, "描述不能占 first_message（那是内容派生列）");
});
