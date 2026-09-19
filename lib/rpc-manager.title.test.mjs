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
