import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const routeSource = readFileSync(new URL("./[id]/auto-name/route.ts", import.meta.url), "utf8");

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-auto-name-"));
const sessionsDir = join(agentDir, "sessions");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { getDb, setDbForTesting } = await jiti.import("@/lib/sqlite-db.ts");
const { POST: autoName } = await jiti.import("./[id]/auto-name/route.ts");

const SESSION_ID = "sess-auto-name";
const PROJECT = "alpha";
const TITLE = "落库标题";

/** 真实会话文件：resolveSessionPath 按文件名找得到，header.id 与文件名一致。 */
const sessionFile = join(sessionsDir, PROJECT, `2026-09-18T00-00-00_${SESSION_ID}.jsonl`);
mkdirSync(join(sessionsDir, PROJECT), { recursive: true });
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-09-18T00:00:00.000Z", cwd: "/w/alpha" })}\n`,
);

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** 假 wrapper：不落真实会话，只提供路由用到的 isAlive/waitUntilReady/inner。
 *  inner.agent 走真实 generateSessionTitle（streamFunction 直接回一条 assistant 文本，
 *  不发网络请求），保证测的是「生成成功后是否写库」这条链路而不是 mock 的链路。 */
function installFakeSession() {
  let assignedName;
  const agent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "帮我起个标题", timestamp: 1 }],
    },
    waitForIdle: async () => {},
    convertToLlm,
    streamFunction: () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: assistantMessage(TITLE) });
      });
      return stream;
    },
    sessionId: SESSION_ID,
  };
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[SESSION_ID, {
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      agent,
      setSessionName: (name) => { assignedName = name; },
    },
  }]]);
  return {
    assignedName: () => assignedName,
    restore: () => { globalThis.__piSessions = previousRegistry; },
  };
}

/** 断言失败场景的可见性时静音 console.error（测试输出保持干净），仍校验日志内容。 */
function captureConsoleError(t) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return calls;
}

test("auto-name 生成标题后写库（扫描器不读文件尾，只写文件会让侧栏与聊天标题永久分叉）", async (t) => {
  setDbForTesting(new DatabaseSync(":memory:"));
  const fake = installFakeSession();
  t.after(fake.restore);

  const response = await autoName(
    new Request(`http://localhost/api/sessions/${SESSION_ID}/auto-name`, { method: "POST" }),
    { params: Promise.resolve({ id: SESSION_ID }) },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.title, TITLE);
  assert.equal(fake.assignedName(), TITLE, "pi 侧文件名照旧先写");

  const row = getDb().prepare("SELECT * FROM session_meta WHERE session_id = ?").get(SESSION_ID);
  assert.ok(row, "标题必须同请求落库");
  assert.equal(row.title, TITLE);
  assert.equal(row.path, sessionFile);
  assert.equal(row.cwd, "/w/alpha");
  assert.ok(row.project_key, "project_key 齐全（缺列行会被聊天区过滤掉）");
  assert.ok(row.created > 0);
});

test("auto-name 库写失败：日志可见 + 缓存仍失效 + 500（不允许文件改了、库没改还报成功）", async (t) => {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  db.close(); // 库写必抛，模拟 session_meta 写失败
  const fake = installFakeSession();
  t.after(fake.restore);
  const logs = captureConsoleError(t);
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  const response = await autoName(
    new Request(`http://localhost/api/sessions/${SESSION_ID}/auto-name`, { method: "POST" }),
    { params: Promise.resolve({ id: SESSION_ID }) },
  );

  assert.equal(response.status, 500, "库写失败必须报错（库是标题事实源）");
  assert.equal(fake.assignedName(), TITLE, "pi 侧写名仍先完成");
  assert.ok(logs.some((line) => line.includes("会话标题写库失败")), "失败必须可见（console.error）");
  assert.equal(
    globalThis.__piSessionListGeneration,
    generationBefore + 1,
    "库写失败也要失效列表缓存（否则列表还是旧标题）",
  );
});

test("写库在 pi 写名成功之后（同一请求内：先 pi、成功、写库）", () => {
  const nameWrite = routeSource.indexOf("session.inner.setSessionName(result.title)");
  const dbWrite = routeSource.indexOf("await setSessionTitle(id, result.title)");
  assert.ok(nameWrite >= 0, "仍先写 pi 侧会话名");
  assert.ok(dbWrite > nameWrite, "落库必须在 pi 写名成功之后");
  assert.match(routeSource, /import \{[^}]*setSessionTitle[^}]*\} from "@\/lib\/task-store"/);
});
