// 读取路径零扫盘（列表 / 任务区 / 路径解析）—— 可执行证明。
//
// PI_CODING_AGENT_DIR 指向一个空目录（连 sessions/ 都没有），session_meta 里塞几行，
// 断言所有读取路径仍返回正确数据（含 lastReply）。任何「还得摸盘才能给出答案」的读取
// 路径在这套环境里都会退化成空/缺字段，于是这条测试就是「列表加载完全不扫盘」的证明。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// 空 agentDir：没有 sessions/、没有会话文件。必须在 import 前设好（getAgentDir 每次读 env）。
const agentDir = mkdtempSync(join(tmpdir(), "pi-noscan-empty-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDb, setDbForTesting } = await jiti.import("./sqlite-db.ts");
const reader = await jiti.import("./session-reader.ts");
const scanner = await jiti.import("./session-scanner.ts");
const { loadTaskSessionsPage, loadProjectSessions, loadAllSessionIndex, loadSessionSummariesByIds, resolveSessionPath, resolveSessionIdByPath } = reader;

const PROJ = "/tmp/noscan-proj";

function freshDb() {
  setDbForTesting(new DatabaseSync(":memory:"));
  // 路径缓存是 globalThis 级别的，跨用例会串味 —— 每个用例都清空。
  globalThis.__piSessionPathCache = new Map();
  globalThis.__piPathToSessionIdCache = new Map();
  // 索引扫描器视为已 ready：读取路径不该触发扫描。
  globalThis.__piSessionIndexScanner = { timer: undefined, firstScanDone: true };
}

beforeEach(() => freshDb());

/** 直接往库里塞会话行（不经过扫描器——磁盘上什么都没有）。 */
function seedRow({
  id,
  taskId = null,
  parentId = null,
  cwd = PROJ,
  projectKey = PROJ,
  path = `/nonexistent/${id}.jsonl`,
  title = null,
  firstMessage = "首条消息",
  lastReply = null,
  modified = 1000,
  updated = 1000,
  pinned = 0,
}) {
  getDb()
    .prepare(
      `INSERT INTO session_meta
         (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, taskId, updated, pinned, path, cwd, projectKey, title, firstMessage, parentId, modified, modified, lastReply);
}

test("列表零扫盘：sessions 目录不存在，聊天列表仍返回库内会话（含 lastReply）", async () => {
  seedRow({ id: "s1", lastReply: "最后一条回复", modified: 200 });
  seedRow({ id: "s2", modified: 100, firstMessage: null });

  const list = await loadProjectSessions(PROJ);
  assert.deepEqual(list.map((s) => s.id), ["s1", "s2"], "modified 降序");
  assert.equal(list[0].lastReply, "最后一条回复", "lastReply 来自库（旧实现读文件尾）");
  assert.equal(list[1].lastReply, "", "未回填/无回复 → 空串");
  assert.equal(list[1].firstMessage, "(no messages)", "库里没标题且不读文件头");
});

test("列表零扫盘：first_message 为空也不读文件、不回写库（读取路径不写库）", async () => {
  // 文件真实存在且有首条消息：旧实现会读它并把结果写回 meta。
  const dir = mkdtempSync(join(tmpdir(), "pi-noscan-lazy-"));
  try {
    const file = join(dir, "2026-01-01T00-00-00-000Z_a.jsonl");
    writeFileSync(file, [
      `{"type":"session","version":3,"id":"a","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${PROJ}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"文件里的首条"}}',
    ].join("\n") + "\n");
    seedRow({ id: "a", path: file, firstMessage: null });

    const list = await loadProjectSessions(PROJ);
    assert.equal(list[0].firstMessage, "(no messages)", "列表不读文件头补标题");
    const row = getDb().prepare("SELECT first_message FROM session_meta WHERE session_id='a'").get();
    assert.equal(row.first_message, null, "列表 GET 不回写库（回填改由扫描器/事件链路负责）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("全量索引零扫盘：loadAllSessionIndex 同样带 lastReply，任务会话也在内", async () => {
  seedRow({ id: "chat", lastReply: "聊了两句", modified: 300 });
  seedRow({ id: "tasked", taskId: "task-1", lastReply: "任务回复", modified: 200 });

  const all = await loadAllSessionIndex();
  assert.deepEqual(all.map((s) => s.id), ["chat", "tasked"]);
  assert.deepEqual(all.map((s) => s.lastReply), ["聊了两句", "任务回复"]);
});

test("列表不再有跨请求结果缓存：新增行立刻可见（旧实现缓存 5 分钟）", async () => {
  seedRow({ id: "first", modified: 100 });
  assert.deepEqual((await loadAllSessionIndex()).map((s) => s.id), ["first"]);

  seedRow({ id: "second", modified: 200 });
  assert.deepEqual((await loadAllSessionIndex()).map((s) => s.id), ["second", "first"], "每次调用都查库");
});

test("resolveSessionPath 先查库 path，找不到文件才按名兜底，绝不触发全量扫盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-noscan-path-"));
  try {
    // 文件名与「<ts>_<id>.jsonl」命名约定无关 → 名字兜底永远找不到它，
    // 命中只能来自库里的 path（旧实现会退化成全量头尾扫并返回 null）。
    const file = join(dir, "sess-1.jsonl");
    writeFileSync(file, `{"type":"session","version":3,"id":"sess-1","cwd":"${PROJ}"}\n`);
    seedRow({ id: "sess-1", path: file });

    assert.equal(await resolveSessionPath("sess-1"), file);
    assert.equal(await resolveSessionPath("no-such-session"), null, "查不到就是 null，不扫盘兜底");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionIdByPath 查库（含路径归一化差异）", async () => {
  seedRow({ id: "sess-9", path: "/tmp/noscan-path/2026-01-01T00-00-00-000Z_sess-9.jsonl" });

  assert.equal(
    await resolveSessionIdByPath("/tmp/noscan-path/2026-01-01T00-00-00-000Z_sess-9.jsonl"),
    "sess-9",
    "精确命中",
  );
  assert.equal(
    await resolveSessionIdByPath("/tmp/noscan-path/./2026-01-01T00-00-00-000Z_sess-9.jsonl"),
    "sess-9",
    "归一化差异也命中（旧实现靠全量扫盘填缓存）",
  );
  assert.equal(await resolveSessionIdByPath("/tmp/elsewhere/x.jsonl"), undefined);
});

test("任务区分页：根/子树全部来自 session_meta.parent_id，不 readdir 也不读 header", async () => {
  // 任务成员：两个根（R2 置顶、R），R 的 fork 链 R → C1 → C2（文件都不存在）。
  seedRow({ id: "R", taskId: "task-1", modified: 300, firstMessage: "任务根", lastReply: "根的最后回复" });
  seedRow({ id: "C1", taskId: "task-1", parentId: "R", modified: 200, firstMessage: "fork 一" });
  seedRow({ id: "C2", taskId: "task-1", parentId: "C1", modified: 100, firstMessage: "fork 二" });
  seedRow({ id: "R2", taskId: "task-1", modified: 150, pinned: 1, firstMessage: "置顶根" });
  // 非任务会话 → 不进任务区
  seedRow({ id: "chat", modified: 400, firstMessage: "聊天区" });

  const page = await loadTaskSessionsPage("task-1", 0, 5);
  assert.deepEqual(page.sessions.map((s) => s.id).sort(), ["C1", "C2", "R", "R2"], "子树随根");
  assert.equal(page.rootTotal, 2, "根数 = 两个（R、R2），fork 不算根");
  assert.equal(page.sessionTotal, 4, "任务下全部节点数");
  assert.deepEqual(page.pinnedSessionIds, ["R2"]);
  const byId = Object.fromEntries(page.sessions.map((s) => [s.id, s]));
  assert.equal(byId.C1.firstMessage, "fork 一", "子会话详情同样来自库里（与聊天列表同源）");
  assert.equal(byId.R.lastReply, "根的最后回复");
  assert.ok(!page.sessions.some((s) => s.id === "chat"), "非任务会话不下发");

  // offset/limit 只切非置顶根；置顶根永远在页里
  const limited = await loadTaskSessionsPage("task-1", 0, 1);
  assert.deepEqual(limited.sessions.map((s) => s.id).sort(), ["C1", "C2", "R", "R2"], "limit=1 时第一个非置顶根=R（R2 置顶）");
  const secondPage = await loadTaskSessionsPage("task-1", 1, 1);
  assert.deepEqual(secondPage.sessions.map((s) => s.id), ["R2"], "offset=1 → 非置顶根已切完，只剩置顶根");
  assert.equal(secondPage.rootTotal, 2, "rootTotal 与 offset 无关");
});

test("任务区根集合重定义：父不在本任务成员集合内 → 该节点是根（父已删/父属别处）", async () => {
  seedRow({ id: "orphan", taskId: "task-2", parentId: "gone", modified: 100, firstMessage: "父已不在任务" });
  seedRow({ id: "elsewhere", taskId: null, parentId: "orphan", modified: 50 });

  const page = await loadTaskSessionsPage("task-2", 0, 5);
  assert.deepEqual(page.sessions.map((s) => s.id), ["orphan"], "父不在任务成员集合 → orphan 是根");
  assert.equal(page.rootTotal, 1);
  assert.equal(page.sessionTotal, 1, "非成员子会话不进任务区（归属由整棵子树存）");
});

test("看板摘要零扫盘：loadSessionSummariesByIds 的 title/lastReply/modified 全取库", async () => {
  seedRow({ id: "a", title: "改过的名字", lastReply: "最后一条回复", modified: 500 });
  seedRow({ id: "b", firstMessage: "首条", lastReply: "", modified: 400 });

  const sessions = await loadSessionSummariesByIds(["b", "a", "missing-id"]);
  assert.deepEqual(sessions.map((s) => s.id), ["b", "a"], "不存在的 id 跳过；顺序随入参（已命中项）");
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  assert.equal(byId.a.name, "改过的名字", "title 取库，不读文件尾 session_info");
  assert.equal(byId.a.lastReply, "最后一条回复");
  assert.equal(new Date(byId.a.modified).getTime(), 500, "modified 取库，不 stat 文件");
  assert.equal(byId.b.name, undefined);
  assert.equal(byId.b.lastReply, "");
});

test("库内无行的 id（外部工具刚建、尚未入索引）→ 文件名兜底 + 文件头尾读", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fallbackAgentDir = mkdtempSync(join(tmpdir(), "pi-noscan-fallback-"));
  const projSessionsDir = join(fallbackAgentDir, "sessions", "--tmp-proj--");
  mkdirSync(projSessionsDir, { recursive: true });
  try {
    // 库内无行 → 只能靠磁盘：按「<ts>_<id>.jsonl」找到文件并读头尾。
    // 库优先的断言（上面的用例）不依赖文件；这一条守住唯一的文件兜底口子。
    // 父文件也放盘中（且库内也无行）→ parentSessionId 应经库反查不到 → undefined；
    // 另建一个有库行的父 → parentSessionId 应是对应会话 id（与主路径字段一致）。
    const parentFile = join(projSessionsDir, "2026-01-01T00-00-00-000Z_fallbackparent.jsonl");
    writeFileSync(parentFile, `{"type":"session","version":3,"id":"fallbackparent","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${PROJ}"}\n`);
    writeFileSync(join(projSessionsDir, "2026-01-02T00-00-00-000Z_outside.jsonl"), [
      `{"type":"session","version":3,"id":"outside","timestamp":"2026-01-02T00:00:00.000Z","cwd":"${PROJ}","parentSession":"${parentFile}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"外部工具建的"}}',
      '{"type":"message","id":"a1","parentId":"u1","message":{"role":"assistant","content":[{"type":"text","text":"文件里的最后回复"}]}}',
    ].join("\n") + "\n");
    process.env.PI_CODING_AGENT_DIR = fallbackAgentDir;
    globalThis.__piSessionPathCache = new Map();
    globalThis.__piPathToSessionIdCache = new Map();

    // 父在库里有行（扫描器已索引）→ 兜底路径要给出会话 id，而不是磁盘路径。
    seedRow({ id: "fallbackparent", path: parentFile, modified: 900 });

    const sessions = await loadSessionSummariesByIds(["outside"]);
    assert.equal(sessions.length, 1, "库内无行但磁盘有文件 → 兜底读得到");
    assert.equal(sessions[0].firstMessage, "外部工具建的");
    assert.equal(sessions[0].lastReply, "文件里的最后回复");
    assert.equal(sessions[0].parentSessionId, "fallbackparent", "兜底摘要也带 parentSessionId（会话 id，与主路径一致）");
  } finally {
    process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(fallbackAgentDir, { recursive: true, force: true });
  }
});

test("任务区冷启动闸门：未就绪时 loadTaskSessionsPage 先跑首轮扫描（子会话被发现并继承归属）", async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const gateAgentDir = mkdtempSync(join(tmpdir(), "pi-noscan-gate-"));
  const projSessionsDir = join(gateAgentDir, "sessions", "--tmp-noscan-proj--");
  mkdirSync(projSessionsDir, { recursive: true });
  try {
    // 父会话：磁盘有文件、库里已有行且已归属任务。
    const parentFile = join(projSessionsDir, "2026-01-01T00-00-00-000Z_gateparent.jsonl");
    writeFileSync(parentFile, `{"type":"session","version":3,"id":"gateparent","timestamp":"2026-01-01T00:00:00.000Z","cwd":"${PROJ}"}\n`);
    // 子会话（fork）：磁盘上有文件（header.parentSession 指向父），库里还没有行。
    // 闸门没跑首轮扫描 → 任务页只有父；跑过 → 子会话建行并继承任务归属（归属收敛）。
    const childFile = join(projSessionsDir, "2026-01-02T00-00-00-000Z_gatechild.jsonl");
    writeFileSync(childFile, [
      `{"type":"session","version":3,"id":"gatechild","timestamp":"2026-01-02T00:00:00.000Z","cwd":"${PROJ}","parentSession":"${parentFile}"}`,
      '{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"fork"}}',
    ].join("\n") + "\n");
    process.env.PI_CODING_AGENT_DIR = gateAgentDir;
    globalThis.__piSessionPathCache = new Map();
    globalThis.__piPathToSessionIdCache = new Map();
    // 冷启动：没有扫描器状态（未就绪）——闸门必须自己跑首轮
    globalThis.__piSessionIndexScanner = undefined;
    seedRow({ id: "gateparent", taskId: "task-gate", path: parentFile, modified: 1000 });

    const page = await loadTaskSessionsPage("task-gate", 0, 5);
    assert.deepEqual(
      page.sessions.map((s) => s.id).sort(),
      ["gatechild", "gateparent"],
      "首轮扫描发现的子会话已进入任务页",
    );
    assert.equal(page.rootTotal, 1, "gatechild 随父入任务 → 不是根");
    assert.equal(page.sessionTotal, 2);
    assert.equal(globalThis.__piSessionIndexScanner?.firstScanDone, true, "闸门确实跑完首轮扫描并置 ready");
    const row = getDb().prepare("SELECT task_id, parent_id FROM session_meta WHERE session_id='gatechild'").get();
    assert.equal(row.task_id, "task-gate", "归属收敛：子会话继承任务");
    assert.equal(row.parent_id, "gateparent");
  } finally {
    process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    globalThis.__piSessionIndexScanner = { timer: undefined, firstScanDone: true };
    rmSync(gateAgentDir, { recursive: true, force: true });
  }
});

test("任务区冷启动闸门故障（真分支）：无扫描器 → 自己跑的那一轮真的失败，闸门不穿透——仍返回库内已有行", async (t) => {
  // 为什么换成这套写法（旧用例分支不可达）：旧用例 stub 的是 firstScanPromise 的
  // rejection，而生产里 firstScanPromise 由 startSessionIndexScanner 的
  // `.then(...).catch(...)` 链产生（session-index-scanner.ts:371-379、393-396）——
  // catch 把失败吃掉并返回 { ok: false }，**结构上永不 reject**，所以
  // `await scanner.firstScanPromise` 那条 rejection 路径不可达（旧用例只证明
  // 「stub 的 rejection 会穿透」）。
  // 真正可达的抛出点：无扫描器状态时 ensureSessionIndexReady 直接
  // `await runSessionIndexScan(sessionsDir)`（同文件 361 行，没有 try/catch）——
  // 那一轮扫描抛什么就穿透什么。
  // 让「这一轮」真的失败：给 session_meta 挂 BEFORE DELETE 触发器 RAISE(ABORT)
  // ——真实的 SQLite 写入错误（等价于「注入一个写时会抛错的库」）。扫描器的删除分支
  // 撞上它就整轮失败，而 SELECT 不受影响，于是能区分验证：闸门 catch 生效后
  // 「继续查库」返回的是**库内已有的行**，而不是空页。
  seedRow({ id: "member", taskId: "task-boom", modified: 500 });
  getDb()
    .prepare("INSERT INTO tasks (id, project_key, name, created, updated) VALUES ('task-boom', ?, 'T', 1, 1)")
    .run(PROJ);
  getDb().exec(
    "CREATE TRIGGER boom_block_delete BEFORE DELETE ON session_meta BEGIN SELECT RAISE(ABORT, '会话索引写入故障（测试注入）'); END",
  );
  // 无扫描器状态 → ensureSessionIndexReady 走「自己跑一轮」，而不是复用某个 promise。
  globalThis.__piSessionIndexScanner = undefined;
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  t.after(() => { console.error = original; });

  const page = await loadTaskSessionsPage("task-boom", 0, 5);

  assert.equal(logs.length, 1, "闸门失败可见（console.error）");
  assert.match(logs[0], /任务区索引就绪检查失败/);
  assert.match(logs[0], /会话索引写入故障（测试注入）/, "失败确实来自闸门自己跑的那轮扫描（真分支）");
  assert.deepEqual(page.sessions.map((s) => s.id), ["member"], "库里有行 + 扫描失败 → 照常返回库内行（不是空页 / 500）");
  assert.equal(page.rootTotal, 1);
  assert.equal(page.sessionTotal, 1);
  assert.equal(globalThis.__piSessionIndexScanner, undefined, "首轮失败不置 ready（下次 ensure 再试）");
});

test("任务区分页：modified 相同的根分页顺序确定（ORDER BY modified DESC, rowid）", async () => {
  seedRow({ id: "first", taskId: "task-1", modified: 500 });
  seedRow({ id: "second", taskId: "task-1", modified: 500 });

  // 同 modified 时按建行顺序（rowid）切页，且重复调用结果一致——否则「加载更多」
  // 会在两页间反复拿到同一条/丢一条。
  const p1 = await loadTaskSessionsPage("task-1", 0, 1);
  const p2 = await loadTaskSessionsPage("task-1", 1, 1);
  assert.deepEqual(p1.sessions.map((s) => s.id), ["first"]);
  assert.deepEqual(p2.sessions.map((s) => s.id), ["second"]);
  assert.deepEqual((await loadTaskSessionsPage("task-1", 0, 1)).sessions.map((s) => s.id), ["first"]);
  assert.equal(p1.rootTotal, 2);
});

test("库不可用 + 无扫描器：闸门与查库同时失败 → 空页降级（两条降级路径并存，互不掩盖）", async (t) => {
  // 与上一条互补：上一条「库好好的、只有扫描失败」→ 返回库内行；这一条
  // 「库也坏了、扫描也跑不了」→ 闸门先抛（catch 记日志）+ 查库再抛（catch 返回空页）。
  // 两条路径各自独立生效，谁也不靠对方兜底。
  seedRow({ id: "R", taskId: "task-1" });
  globalThis.__piSessionIndexScanner = undefined;
  getDb().close(); // getDb() 仍返回同一个已关闭实例 → 扫描与查库都抛
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.map(String).join(" "));
  t.after(() => { console.error = original; });

  assert.deepEqual(await loadTaskSessionsPage("task-1", 0, 5), {
    sessions: [],
    rootTotal: 0,
    sessionTotal: 0,
    pinnedSessionIds: [],
  });
  assert.equal(logs.length, 1, "闸门失败仍然可见（一条 console.error），但绝不穿透成 500");
  assert.match(logs[0], /任务区索引就绪检查失败/);
});

test("库不可用（连接已关）→ 任务分页/列表降级为空，不抛错（否则 /api/tasks、/api/sessions 全 500）", async () => {
  seedRow({ id: "R", taskId: "task-1" });
  seedRow({ id: "chat" });
  getDb().close(); // getDb() 仍返回同一个已关闭实例 → prepare 抛错

  assert.deepEqual(await loadTaskSessionsPage("task-1", 0, 5), {
    sessions: [],
    rootTotal: 0,
    sessionTotal: 0,
    pinnedSessionIds: [],
  });
  assert.deepEqual(await loadProjectSessions(PROJ), []);
  assert.deepEqual(await loadAllSessionIndex(), []);
});

test("零扫盘是结构性保证：读取模块不再暴露全量扫盘/文件回填入口", async () => {
  for (const gone of ["listAllSessions", "buildTaskSessionIndex", "fillFirstMessageFromFile", "loadAllSessions"]) {
    assert.equal(typeof reader[gone], "undefined", `session-reader 不应再导出 ${gone}`);
  }
  for (const gone of ["scanSessionFiles", "sessionScanner"]) {
    assert.equal(typeof scanner[gone], "undefined", `session-scanner 不应再导出 ${gone}`);
  }
  // 保留：扫描器/事件链路/单文件详情仍要用的入口
  for (const kept of ["scanSessionFileMeta", "scanOneSessionHead", "scanOneSessionFile", "readSessionTail"]) {
    assert.equal(typeof scanner[kept], "function", `${kept} 必须保留`);
  }
});
