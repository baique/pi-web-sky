import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
  alias: { "@": process.cwd() },
});
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

/** 事件链路的行为测试：真 wrapper + 真库（:memory:）+ 假 SDK 会话。 */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}

function seedSession(db, sessionId) {
  db.prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply)
     VALUES (?, NULL, 111, 0, ?, '/p', 'proj', NULL, NULL, NULL, 100, 200, NULL)`,
  ).run(sessionId, `/s/${sessionId}.jsonl`);
}

const rowOf = (db, sessionId) =>
  db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId);

const assistant = (text, ts, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", timestamp: ts, stopReason, content: [{ type: "text", text }] },
});

/** 假 AgentSessionLike：只实现事件订阅 + wrapper 读到的几处。 */
function makeWrapper(sessionId, entries = []) {
  let emit = null;
  const inner = {
    sessionId,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => entries },
    agent: { state: {} },
    subscribe(listener) {
      emit = listener;
      return () => {
        emit = null;
      };
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  return { wrapper, fire: (event) => emit(event) };
}

const userEntry = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });

test("agent_start → 刷 modified（活跃时间立刻前移），不碰 last_reply", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const { wrapper, fire } = makeWrapper("sess-live");
  t.after(() => wrapper.destroy());

  const before = Date.now();
  fire({ type: "agent_start" });

  const row = rowOf(db, "sess-live");
  assert.ok(row.modified >= before, "agent_start 立刻把活跃时间前移到当前");
  assert.equal(row.last_reply, null);
  assert.equal(row.updated, 111);
  assert.ok(wrapper.lastAgentStartAt() >= before, "既有 agent_start 逻辑（缓存起始时间）保持原样");
});

test("一轮循环结束：message_end 缓存、agent_settled 落 last_reply + modified", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const { wrapper, fire } = makeWrapper("sess-live");
  t.after(() => wrapper.destroy());

  fire({ type: "agent_start" });
  fire(assistant("中间回复", 1000));
  assert.equal(rowOf(db, "sess-live").last_reply, null, "单条 message_end 不落库（不是循环最后一条）");
  fire(assistant("最后一条回复", 2000));
  fire({ type: "agent_settled" });

  const row = rowOf(db, "sess-live");
  assert.equal(row.last_reply, "最后一条回复");
  assert.equal(row.modified, 2000);
});

test("用户取消（stopReason=aborted）走同一条路径落库", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const { wrapper, fire } = makeWrapper("sess-live");
  t.after(() => wrapper.destroy());

  fire(assistant("被打断的半截回复", 3000, "aborted"));
  fire({ type: "agent_settled" });

  assert.equal(rowOf(db, "sess-live").last_reply, "被打断的半截回复");
});

test("本轮没采到文本 → 保留库里的 last_reply，只刷 modified", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  db.prepare("UPDATE session_meta SET last_reply = '上一条回复' WHERE session_id = 'sess-live'").run();
  const { wrapper, fire } = makeWrapper("sess-live");
  t.after(() => wrapper.destroy());

  fire({ type: "agent_start" });
  fire({ type: "agent_settled" });

  const row = rowOf(db, "sess-live");
  assert.equal(row.last_reply, "上一条回复", "空文本不清库");
  assert.ok(row.modified > 200);
});

test("首条用户消息在落库时回填（内存 entries，不读文件），只补一次", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const entries = [userEntry("帮我写一个 e2e 测试"), { type: "message", message: { role: "assistant", content: [] } }];
  const { wrapper, fire } = makeWrapper("sess-live", entries);
  t.after(() => wrapper.destroy());

  fire(assistant("好的", 1000));
  fire({ type: "agent_settled" });
  assert.equal(rowOf(db, "sess-live").first_message, "帮我写一个 e2e 测试");

  entries[0] = userEntry("换了个说法");
  fire(assistant("第二次回复", 2000));
  fire({ type: "agent_settled" });
  assert.equal(rowOf(db, "sess-live").first_message, "帮我写一个 e2e 测试", "首条消息不被后续覆盖");
});

test("首条用户消息截断到 300 字符（与扫描器同一上限）", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const long = "长".repeat(500);
  const { wrapper, fire } = makeWrapper("sess-live", [userEntry(long)]);
  t.after(() => wrapper.destroy());

  fire(assistant("回复", 1000));
  fire({ type: "agent_settled" });

  assert.equal(rowOf(db, "sess-live").first_message.length, 300);
});

test("并发会话各自记账，事件不串台", (t) => {
  const db = freshDb();
  seedSession(db, "sess-a");
  seedSession(db, "sess-b");
  const a = makeWrapper("sess-a");
  const b = makeWrapper("sess-b");
  t.after(() => {
    a.wrapper.destroy();
    b.wrapper.destroy();
  });

  a.fire(assistant("A 的回复", 1000));
  b.fire(assistant("B 的回复", 2000));
  b.fire({ type: "agent_settled" });
  a.fire({ type: "agent_settled" });

  assert.deepEqual(
    [rowOf(db, "sess-a").last_reply, rowOf(db, "sess-b").last_reply],
    ["A 的回复", "B 的回复"],
  );
});

test("库里没有行时事件写库静默 no-op，且不影响既有事件流", (t) => {
  const db = freshDb();
  const { wrapper, fire } = makeWrapper("sess-unknown");
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));

  fire({ type: "agent_start" });
  fire(assistant("回复", 1000));
  fire({ type: "agent_settled" });

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM session_meta").get().c, 0, "事件不建行");
  assert.deepEqual(events, ["agent_start", "message_end", "agent_settled"]);
});

test("写库失败必须可见且不打断既有事件流", (t) => {
  const db = freshDb();
  seedSession(db, "sess-live");
  const { wrapper, fire } = makeWrapper("sess-live");
  t.after(() => {
    wrapper.destroy();
    setDbForTesting(db);
  });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  t.after(() => {
    console.error = original;
  });
  const events = [];
  wrapper.onEvent((event) => events.push(event.type));

  // 让库写入抛错：stub 掉全局库句柄（真库仍在 db 变量里，未被触碰）
  globalThis.__piWebDb = {
    prepare() {
      throw new Error("database is locked");
    },
  };

  fire({ type: "agent_start" });
  fire(assistant("回复", 1000));
  fire({ type: "agent_settled" });

  assert.equal(errors.length, 2, "agent_start / agent_settled 各报一次写库失败");
  assert.match(errors.join("\n"), /会话活跃写库失败/);
  assert.match(errors.join("\n"), /database is locked/);
  assert.deepEqual(events, ["agent_start", "message_end", "agent_settled"], "写库失败不打断事件流");
  assert.ok(wrapper.lastAgentStartAt() > 0, "既有回调逻辑（agent_start 缓存）不受影响");
});
