import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";
// 单会话删除的库内父子链同步：删父后子行 parent_id 必须立刻改写到祖父（或 NULL），
// 不等扫描器（T5 之后「根」判定全来自 session_meta —— 不同步子会话会以根行呈现 ≤30s）。
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-del-reparent-"));
const sessionsDir = join(agentDir, "sessions", "--w-proj--");
mkdirSync(sessionsDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { setDbForTesting, getDb } = await jiti.import("@/lib/sqlite-db.ts");
const { DELETE } = await jiti.import("./[id]/route.ts");
const { runSessionIndexScan } = await jiti.import("@/lib/session-index-scanner.ts");

/** 写一个会话文件；parentPath 非空时 header.parentSession 指向它。 */
function sessionFile(id, parentPath) {
  const file = join(sessionsDir, `2026-09-18T00-00-00_${id}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "session",
      id,
      timestamp: "2026-09-18T00:00:00.000Z",
      cwd: "/w/proj",
      ...(parentPath ? { parentSession: parentPath } : {}),
    })}\n`,
  );
  return file;
}

function seedRow(id, parentId, filePath) {
  getDb()
    .prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, parent_id, created, modified) VALUES (?, NULL, ?, 0, ?, '/w/proj', 'proj', ?, 1, 1)")
    .run(id, Date.now(), filePath, parentId);
}

const call = (id) =>
  DELETE(new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => setDbForTesting(new DatabaseSync(":memory:")));

test("删父会话：子行 parent_id 立刻改写到祖父（库内，不等扫描器）", async () => {
  const gFile = sessionFile("g");
  const pFile = sessionFile("p", gFile);
  const cFile = sessionFile("c", pFile);
  seedRow("g", null, gFile);
  seedRow("p", "g", pFile);
  seedRow("c", "p", cFile);

  const res = await call("p");
  assert.equal(res.status, 200);

  assert.equal(getDb().prepare("SELECT session_id FROM session_meta WHERE session_id='p'").get(), undefined, "父行已删");
  assert.equal(
    getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='c'").get().parent_id,
    "g",
    "子行 parent_id 指向祖父（不再指向已删的 p）",
  );
  assert.ok(existsSync(gFile) && existsSync(cFile), "只删父的文件");
  assert.equal(JSON.parse(readFileSync(cFile, "utf8").split("\n")[0]).parentSession, gFile, "磁盘 header 与库同向改写");
});

test("删父会话：祖父反查不到 → 子行 parent_id 写 NULL（不留悬空指针）", async () => {
  // 父的 header 没有 parentSession（外部工具建的顶层会话）
  const pFile = sessionFile("p2");
  const cFile = sessionFile("c2", pFile);
  seedRow("p2", null, pFile);
  seedRow("c2", "p2", cFile);

  const res = await call("p2");
  assert.equal(res.status, 200);
  assert.equal(
    getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='c2'").get().parent_id,
    null,
    "拿不到祖父 → NULL（子会话变临时根，而不是悬空 parent_id）",
  );
});

test("删未落盘（文件已丢失）的父会话：子行 parent_id 同样改写成 NULL", async () => {
  // 父行存在但文件不在盘上（Pi 延迟 flush / 已被外部删）→ 走「无文件」分支，
  // 同样不能留下指向已删 id 的悬空 parent_id。
  seedRow("p3", null, join(sessionsDir, "2026-09-18T00-00-00_p3.jsonl"));
  seedRow("c3", "p3", join(sessionsDir, "2026-09-18T00-00-00_c3.jsonl"));

  const res = await call("p3");
  assert.equal(res.status, 200);
  assert.equal(getDb().prepare("SELECT session_id FROM session_meta WHERE session_id='p3'").get(), undefined);
  assert.equal(
    getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='c3'").get().parent_id,
    null,
    "无文件分支：祖父不可知 → NULL（不留悬空指针）",
  );
});

// ── 子目录里的子行（forks/ 等历史布局）────────────────────────────────────────
// 平铺 readdirSync(dirname(父文件)) 只能看到同级文件：子目录里的子行磁盘 header 不会被
// 改写，仍然指着已删父——下一轮扫描按磁盘 header 把库里的祖父重挂改回 NULL（嵌套回退）。

test("删父会话：forks/ 子目录里的子行磁盘 header 也改指祖父，下一轮扫描不会改回 NULL", async () => {
  const gFile = sessionFile("gp");
  const pFile = sessionFile("pp", gFile);
  const forkDir = join(sessionsDir, "2026-09-18T00-00-00_pp", "forks");
  mkdirSync(forkDir, { recursive: true });
  const cFile = join(forkDir, "2026-09-18T00-01-00_cp.jsonl");
  writeFileSync(
    cFile,
    `${JSON.stringify({ type: "session", id: "cp", timestamp: "2026-09-18T00:01:00.000Z", cwd: "/w/proj", parentSession: pFile })}\n`,
  );
  seedRow("gp", null, gFile);
  seedRow("pp", "gp", pFile);
  seedRow("cp", "pp", cFile);

  const res = await call("pp");
  assert.equal(res.status, 200);
  assert.equal(
    JSON.parse(readFileSync(cFile, "utf8").split("\n")[0]).parentSession,
    gFile,
    "子目录里的子行磁盘 header 也改指祖父（库与磁盘同向）",
  );
  assert.equal(getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='cp'").get().parent_id, "gp");

  // 复现「一次性嵌套回退」：再跑一轮扫描，磁盘若仍指已删父会把库改回 NULL。
  // 扫描 root 是 sessions 根（项目目录算第 1 层）。
  await runSessionIndexScan(join(agentDir, "sessions"));
  assert.equal(
    getDb().prepare("SELECT parent_id FROM session_meta WHERE session_id='cp'").get().parent_id,
    "gp",
    "扫描后仍指祖父（磁盘 header 已同向改写）",
  );
});
