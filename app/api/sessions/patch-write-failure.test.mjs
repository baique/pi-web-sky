import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

// getAgentDir() 每次调用都读环境变量 → 指向临时树，测试绝不碰 ~/.pi/agent。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-patch-write-"));
const sessionsDir = join(agentDir, "sessions", "alpha");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const SESSION_ID = "sess-patch-write-fail";
const sessionFile = join(sessionsDir, `2026-09-18T00-00-00_${SESSION_ID}.jsonl`);
writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", id: SESSION_ID, timestamp: "2026-09-18T00:00:00.000Z", cwd: "/w/alpha" })}\n`,
);

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting } = await jiti.import("@/lib/sqlite-db.ts");
const { PATCH: patchSession } = await jiti.import("./[id]/route.ts");

/** 库写失败场景：库能开（setDbForTesting 建过 schema）但立刻 close → 任何库写都抛。 */
function freshClosedDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  db.close();
}

function patchSessionRequest(body) {
  return patchSession(
    new Request(`http://localhost/api/sessions/${SESSION_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: SESSION_ID }) },
  );
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

test("改名库写失败：日志可见 + 缓存仍失效 + 500（文件改了、库没改不许报成功）", async (t) => {
  freshClosedDb();
  const logs = captureConsoleError(t);
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  const response = await patchSessionRequest({ name: "新名字" });

  assert.equal(response.status, 500, "库是标题事实源：写库失败必须报错");
  assert.ok(logs.some((line) => line.includes("会话标题写库失败")), "失败必须可见（console.error）");
  assert.equal(
    globalThis.__piSessionListGeneration,
    generationBefore + 1,
    "库写失败也要失效列表缓存（否则列表还是旧标题）",
  );
});

test("置顶库写失败：日志可见 + 缓存仍失效 + 500", async (t) => {
  freshClosedDb();
  const logs = captureConsoleError(t);
  const generationBefore = globalThis.__piSessionListGeneration ?? 0;

  const response = await patchSessionRequest({ pinned: true });

  assert.equal(response.status, 500);
  assert.ok(logs.some((line) => line.includes("会话置顶写库失败")), "失败必须可见（console.error）");
  assert.equal(
    globalThis.__piSessionListGeneration,
    generationBefore + 1,
    "库写失败也要失效列表缓存",
  );
});
