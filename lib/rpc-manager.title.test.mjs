import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

/** set_session_name 命令（前端改名/看板卡改名）必须与路由层同语义落库：
 *  pi 侧成功 → 同一次 send 内写 session_meta.title → 缓存失效；
 *  写库失败 console.error 可见，但不抛断命令响应（RPC 已改文件名，抛错无可恢复动作）。
 *  真 wrapper + 真库（:memory:）+ 假 SDK 会话（参照 rpc-manager.activity.test.mjs）。 */

function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}

/** 全列行（title 为 NULL：模拟还没改过名的老会话）。 */
function seedSession(db, sessionId) {
  db.prepare(
    `INSERT INTO session_meta
       (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply)
     VALUES (?, NULL, 111, 0, ?, '/p', 'proj', NULL, NULL, NULL, 100, 200, NULL)`,
  ).run(sessionId, `/s/${sessionId}.jsonl`);
}

const rowOf = (db, sessionId) =>
  db.prepare("SELECT * FROM session_meta WHERE session_id = ?").get(sessionId);

/** 取 `case "<name>"` 到下一个 case 之间的源码片段。
 *  右边界用「下一个 case」的形状（不依赖某个具体 case 名存在）——别人把
 *  get_session_stats 改名/删除也不会让切片静默退化成整文件；找不到边界直接报错。 */
function caseSourceOf(source, name) {
  const marker = `case "${name}"`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `找不到 ${marker}`);
  const rest = source.slice(start + marker.length);
  const next = rest.slice(1).search(/\n      case "/);
  assert.ok(next >= 0, `${marker} 之后找不到下一个 case（切片无法闭合）`);
  return rest.slice(0, next + 1);
}

/** 假 AgentSessionLike：只实现 wrapper 用到的几处 + 记录 pi 侧改名调用。 */
function makeWrapper(sessionId) {
  const nameCalls = [];
  const inner = {
    sessionId,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    agent: { state: {} },
    setSessionName(name) {
      nameCalls.push(name);
    },
    subscribe() {
      return () => {};
    },
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  return { wrapper, nameCalls };
}

/** 源码断言：命令分支确实接了库写，且失败处理形状正确。 */
test("set_session_name 分支接线：pi 成功 → await setSessionTitle → 失败只记日志不抛", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const caseSource = caseSourceOf(source, "set_session_name");

  assert.match(source, /import \{[^}]*\bsetSessionTitle\b[^}]*\} from "\.\/task-store";/s);
  assert.ok(caseSource.includes("await setSessionTitle("), "库写必须 await（命令响应返回时库已落地）");
  assert.match(caseSource, /setSessionTitle\(this\.inner\.sessionId, name\)/);
  assert.ok(
    caseSource.indexOf("this.inner.setSessionName(name)") < caseSource.indexOf("await setSessionTitle("),
    "先 pi 侧改名成功、再写库（pi 失败时不该写库）",
  );
  assert.match(caseSource, /catch \(error\) \{[\s\S]*?console\.error\([\s\S]*?会话标题写库失败/);
  assert.doesNotMatch(caseSource, /catch[\s\S]{0,400}?\bthrow\b/, "写库失败不得抛断命令响应/事件流");
  assert.match(caseSource, /invalidateSessionListCache\(\);/);
  assert.match(caseSource, /return null;/);
});

test("改名成功：同一次 send 内把 title 写库（不依赖扫描器/懒更新）", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-name");
  const { wrapper, nameCalls } = makeWrapper("sess-name");
  t.after(() => wrapper.destroy());

  const before = Date.now();
  const result = await wrapper.send({ type: "set_session_name", name: "  新标题  " });

  assert.deepEqual(nameCalls, ["新标题"], "pi 侧收到 trim 后的名字（校验行为不变）");
  assert.equal(result, null, "返回值保持原样");
  const row = rowOf(db, "sess-name");
  assert.equal(row.title, "新标题", "刷新侧栏/看板卡不再退回旧标题");
  assert.ok(row.updated >= before, "写库顺带前移 updated");
  assert.equal(row.task_id, null, "改名不碰归属");
  assert.equal(row.path, "/s/sess-name.jsonl", "改名不碰索引列（只 UPDATE title/updated）");
});

test("写库失败：console.error 可见、不抛（命令响应与事件流都不被打断）", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-name");
  const { wrapper, nameCalls } = makeWrapper("sess-name");
  const errors = [];
  const original = console.error;
  t.after(() => {
    wrapper.destroy();
    console.error = original;
    globalThis.__piWebDb = db;
  });
  console.error = (...args) => errors.push(args.map(String).join(" "));

  // 让库写入抛错：stub 掉全局库句柄（真库仍在 db 变量里，未被触碰）
  globalThis.__piWebDb = {
    prepare() {
      throw new Error("database is locked");
    },
  };

  const result = await wrapper.send({ type: "set_session_name", name: "新标题" });

  assert.equal(result, null, "RPC 命令照常返回成功响应（与路由层 500 语义不同：这里无可恢复动作）");
  assert.deepEqual(nameCalls, ["新标题"], "pi 侧改名已生效");
  assert.equal(errors.length, 1, "写库失败必须可见");
  assert.match(errors[0], /\[pi-web\] 会话标题写库失败/);
  assert.match(errors[0], /database is locked/);
});

test("空名字仍然报错（既有校验不变），不碰 pi 也不碰库", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-name");
  const { wrapper, nameCalls } = makeWrapper("sess-name");
  t.after(() => wrapper.destroy());

  await assert.rejects(
    () => wrapper.send({ type: "set_session_name", name: "   " }),
    /Session name cannot be empty/,
  );
  assert.deepEqual(nameCalls, []);
  assert.equal(rowOf(db, "sess-name").title, null);
});

/** 假 inner：prompt 提交的接受/拒绝由调用方控制（SDK 通过 preflightResult 同步 ack）。
 *  `entries` 模拟 transcript 已有内容（判定「是不是真首条」靠它）。 */
function makePromptWrapper(sessionId, { preflight = "accept", entries = [] } = {}) {
  const inner = {
    sessionId,
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => entries },
    agent: { state: {} },
    subscribe() {
      return () => {};
    },
    dispose() {},
    prompt(_message, options) {
      if (preflight === "reject") return Promise.reject(new Error("prompt rejected"));
      options.preflightResult(true);
      return Promise.resolve();
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  return wrapper;
}

test("首条用户消息在 prompt 被接受时即落库：标题不必等整轮跑完", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  const wrapper = makePromptWrapper("sess-title");
  t.after(() => wrapper.destroy());
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  await wrapper.send({ type: "prompt", message: "  会话标题为什么不及时  " });

  assert.equal(rowOf(db, "sess-title").first_message, "会话标题为什么不及时", "trim 后入库");
  assert.ok(
    (globalThis.__piSessionListGeneration ?? 0) > generationBefore,
    "同一次写库推列表代次：正在看侧栏的客户端 ≤2.5s 内重拉，标题立刻可见",
  );
});

test("首条用户消息截断到 300 字符（与扫描器同一上限）", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  const wrapper = makePromptWrapper("sess-title");
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "prompt", message: "长".repeat(500) });

  assert.equal(rowOf(db, "sess-title").first_message.length, 300);
});

test("prompt 没被接受（preflight 拒绝）：不写 first_message", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  const wrapper = makePromptWrapper("sess-title", { preflight: "reject" });
  t.after(() => wrapper.destroy());

  await assert.rejects(() => wrapper.send({ type: "prompt", message: "会被拒绝的提交" }), /prompt rejected/);
  assert.equal(rowOf(db, "sess-title").first_message, null);
});

test("prompt 分支接线：await preflight 之后才写 first_message（拒绝的提交不留标题）", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const caseSource = caseSourceOf(source, "prompt");

  assert.match(caseSource, /await preflight;[\s\S]*?fillFirstMessageIfEmpty\(/);
  assert.match(caseSource, /command\.message[\s\S]*?slice\(0, FIRST_MESSAGE_PREVIEW_LENGTH\)/);
  assert.match(caseSource, /try \{[\s\S]*?fillFirstMessageIfEmpty\([\s\S]*?catch \(error\)/, "库写失败不得冒泡（否则路由把已接受的 prompt 报成 prompt_rejected）");
});

test("transcript 里已有用户消息（老会话）：prompt 不写 first_message（不把最新消息写成首条）", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  // 模拟 CLI 建的老会话：transcript 有历史，但 first_message 还空着（扫描器拿不到）
  const wrapper = makePromptWrapper("sess-title", {
    entries: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "历史里的真首条消息" }] } }],
  });
  t.after(() => wrapper.destroy());
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  await wrapper.send({ type: "prompt", message: "这是这条会话里最新的一句" });

  assert.equal(rowOf(db, "sess-title").first_message, null, "留给 agent_settled/扫描器按真首条回填");
  assert.equal(globalThis.__piSessionListGeneration ?? 0, generationBefore, "没写库就不推代次");
});

test("空的 message（图片-only 等）：不写库、不推代次", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  const wrapper = makePromptWrapper("sess-title");
  t.after(() => wrapper.destroy());
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  await wrapper.send({ type: "prompt", message: "   ", images: [] });

  assert.equal(rowOf(db, "sess-title").first_message, null);
  assert.equal(globalThis.__piSessionListGeneration ?? 0, generationBefore);
});

test("写库失败不拖累 send：命令照常成功响应（库是旁路索引）", async (t) => {
  const db = freshDb();
  seedSession(db, "sess-title");
  const wrapper = makePromptWrapper("sess-title");
  const errors = [];
  const original = console.error;
  t.after(() => {
    wrapper.destroy();
    console.error = original;
    globalThis.__piWebDb = db;
  });
  console.error = (...args) => errors.push(args.map(String).join(" "));
  // 让库写入抛错：stub 掉全局库句柄（真库仍在 db 变量里，未被触碰）
  globalThis.__piWebDb = {
    prepare() {
      throw new Error("database is locked");
    },
  };

  const result = await wrapper.send({ type: "prompt", message: "阻塞的库也不能让 prompt 变失败" });

  assert.equal(result, null, "send 正常返回：路由才会写 promptAccepted=true（否则客户端回填草稿、诱导重发）");
  assert.equal(errors.length, 1, "写库失败必须可见");
  assert.match(errors[0], /\[pi-web\] 首条消息写库失败/);
  assert.match(errors[0], /database is locked/);
});
