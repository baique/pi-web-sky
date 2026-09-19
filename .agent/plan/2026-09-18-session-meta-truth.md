# 会话集合链路改造：数据库唯一事实（session_meta 写读闭环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `session_meta` 成为会话列表/归属/标题/最后消息/最后活跃时间的唯一事实源：所有会话操作「先 pi、成功写库、刷新前写完」，文件只在后台扫描器这一条链路里被读，列表读取零扫盘。

**Architecture:** 三条链路分工——(1) **事件链路**：pi 事件（`agent_start` / `message_end` / `agent_settled`）驱动 `modified` / `last_reply` 落库；(2) **扫描链路**：后台扫描器递归发现磁盘会话文件，为新文件建全列行（task_id 继承父、无父为临时会话），并收敛归属；(3) **读取链路**：列表、任务区子树、单会话路径解析全部改查 `session_meta`，不再 readdir/读 header。

**Tech Stack:** Next.js 16 + TypeScript(strict) + node:sqlite（`node:sqlite` DatabaseSync）+ pi SDK 0.84.3 + `node --experimental-strip-types --test` + jiti（测试加载 TS）

**Spec:** `.agent/bug/2026-09-18-session-meta-chain-audit.md`（缺陷编号 V1–V8）与用户 2026-09-18 的四项决策（事件机制 / 扫文件按库规范建临时会话 / 多实例暂不处理 / 列表零扫盘）

## Global Constraints

- **数据库是集合的唯一事实**：会话列表、任务区子树、单会话路径解析一律只查 `session_meta`；**读取路径不得读会话文件、不得 readdir**（决策 4）。
- **写入时序铁律**：先执行 pi 操作 → 成功 → **同一请求内写库** → 才允许刷新/返回。pi 失败不写库；库写失败必须可见（`console.error`，不得静默交给后台兜底）。
- **归属规则**：子会话（fork / fork_branch / 内置 subagent）建行时**继承源会话的 task_id**；归属变更（拖入/移出任务、删除任务）**连带整棵子树**。树由 `session_meta.parent_id` 定义。
- **`session_meta` 列集合（v12 起 13 列）**：`session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply`。
- **迁移规则**：只在 `lib/sqlite-db.ts` 的 `MIGRATIONS` **末尾追加**（append-only），同时把 `SCHEMA_VERSION` 加 1（当前 11 → 12）。
- **`last_reply` 上限 4000 字符**：常量 `LAST_REPLY_MAX = 4000`，超出截断（与 `lib/types.ts` 中 `lastReply` 的「截断」注释一致）。
- **开发期用户数据只读**：测试一律 `setDbForTesting(new DatabaseSync(":memory:"))` + 临时 sessions 目录（`PI_CODING_AGENT_DIR` 或注入参数）。需要真实 `~/.pi/agent/pi-web.db` 的 e2e，**必须先**把 `~/.pi/agent/pi-web.db*` 复制到 `.agent/tmp/db-backup-<时间戳>/`；e2e 只允许新建自己的任务/会话，结束后清理自己的数据。
- **禁止新增 npm 依赖**；`tsc --noEmit` 与 `eslint .` 必须零错误。
- 测试文件必须是 `.mjs`，用 jiti 加载 TS：`createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } })`。
- 提交信息用 conventional commits（`feat/fix/refactor/test` + `(scope)`）。

### 公共接口（本计划定义，后续任务按此引用）

```ts
// lib/task-store.ts
ensureSessionMetaRow(sessionId: string, row: {
  path: string; cwd: string; projectKey: string;
  parentId?: string;  firstMessage?: string; title?: string;
  taskId?: string | null;            // 新增：归属继承用；缺省不写归属（NULL）
}): void;

listDescendantIds(sessionId: string): string[];          // 按 parent_id 递归（不含自身）
assignSessionSubtreeToTask(sessionId: string, taskId: string): boolean; // 自身 + 子树
touchSessionActivity(sessionId: string, at?: number): void;                 // 只 UPDATE modified
recordSessionOutcome(sessionId: string, o: { lastReply: string; at: number }): void; // UPDATE last_reply+modified
fillFirstMessageIfEmpty(sessionId: string, firstMessage: string): void;

// lib/session-activity.ts（新文件，纯函数，无 IO；状态**按 wrapper 实例**持有，不用模块级变量）
type SessionActivityEffect =
  | { kind: "touch" }
  | { kind: "outcome"; lastReply: string; at: number };
createSessionActivityTracker(): { handle(event: { type: string; message?: AgentLikeMessage }): SessionActivityEffect | null };
lastAssistantText(message: AgentLikeMessage): string;   // content[] 里 text 块拼接，trim

// lib/session-scanner.ts
scanSessionFileMeta(sessionsDir?: string): Promise<Array<{ path: string; id: string; modified: Date }>>; // 递归；id 为文件名提示
```

---

### Task 1: 归属继承与子树连带

> **注（收尾修复波后）**：`unassignSessionSubtree` 已从代码删除（零生产调用方）——「移出任务」现在由 `updateTask` 的成员规范化承担（祖先已离开的成员自动剪掉）。下文本任务正文里的该函数引用只作历史记录，不要照它实现。

**Files:**
- Modify: `lib/task-store.ts`（`ensureSessionMetaRow` 加 `taskId`；新增 `listDescendantIds` / `assignSessionSubtreeToTask` / `unassignSessionSubtree`；`updateTask` 的 `sessionIds` 全量替换改成「子树闭包」语义）
- Modify: `lib/rpc-manager.ts:634`（fork_branch）、`lib/rpc-manager.ts:700`（fork）→ 传 `taskId`（源会话归属）
- Modify: `lib/subagent-runtime.ts:254` 之后（registerSession 成功后同请求建行，`parentId` = 父会话 id，`taskId` = 父会话归属）
- Modify: `lib/session-index-scanner.ts`（扫描收敛：子会话 task_id 为空而父非空 → 继承父）
- Modify: `app/api/tasks/[id]/assign-session/route.ts`、`app/api/boards/[id]/add-session/route.ts` → 用 `assignSessionSubtreeToTask`
- Test: `lib/task-store.subtree.test.mjs`（新建）、`lib/session-index-scanner.test.mjs`（追加）

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces: 上面「公共接口」里的 `ensureSessionMetaRow(taskId)`、`listDescendantIds`、`assignSessionSubtreeToTask`、`unassignSessionSubtree`

- [ ] **Step 1: 写失败测试（归属继承 + 子树连带）**

`lib/task-store.subtree.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const { setDbForTesting } = await jiti.import("./sqlite-db.ts");
const store = await jiti.import("./task-store.ts");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  return db;
}
// 造一个「任务 T + 根 A + 子树 A<-B<-C」的库内结构
function seedTree(db) {
  const task = store.createTask("/p", "T");
  const row = (id, taskId, parentId) => db.prepare(
    "INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, created, modified, parent_id) VALUES (?,?,?,0,?,?,?,?,?,?)",
  ).run(id, taskId, Date.now(), `/s/${id}.jsonl`, "/p", "/p", Date.now(), Date.now(), parentId);
  row("A", null, null); row("B", null, "A"); row("C", null, "B");
  return task;
}

test("listDescendantIds 按 parent_id 递归（不含自身，含多层）", () => {
  const db = freshDb(); seedTree(db);
  assert.deepEqual(store.listDescendantIds("A").sort(), ["B", "C"]);
  assert.deepEqual(store.listDescendantIds("C"), []);
});

test("agent/new 之外的归属：assignSessionSubtreeToTask 连带子树", () => {
  const db = freshDb(); const task = seedTree(db);
  assert.equal(store.assignSessionSubtreeToTask("A", task.id), true);
  const ids = db.prepare("SELECT session_id, task_id FROM session_meta ORDER BY session_id").all();
  assert.deepEqual(ids.map((r) => [r.session_id, r.task_id]), [["A", task.id], ["B", task.id], ["C", task.id]]);
});

test("unassignSessionSubtree 连带子树（父移出任务，子不留在任务里当孤儿根）", () => {
  const db = freshDb(); const task = seedTree(db);
  store.assignSessionSubtreeToTask("A", task.id);
  store.unassignSessionSubtree("B");     // 以 B 为根移出
  assert.equal(store.taskForSession("A"), task.id, "A 仍在任务");
  assert.equal(store.taskForSession("B"), null);
  assert.equal(store.taskForSession("C"), null, "C 是 B 的后代，必须一起移出");
});

test("updateTask 的 sessionIds 全量替换按子树闭包展开", () => {
  const db = freshDb(); const task = seedTree(db);
  store.updateTask(task.id, { sessionIds: ["A"] });          // 只给根，服务端要连带子树
  assert.equal(store.taskForSession("B"), task.id);
  store.updateTask(task.id, { sessionIds: [] });              // 清空 → 整棵子树回到聊天区
  assert.equal(store.taskForSession("A"), null);
  assert.equal(store.taskForSession("C"), null);
});

test("ensureSessionMetaRow 传 taskId 时落归属，不传时保持 NULL", () => {
  const db = freshDb();
  store.ensureSessionMetaRow("X", { path: "/s/X.jsonl", cwd: "/p", projectKey: "/p", taskId: "T1" });
  assert.equal(store.taskForSession("X"), "T1");
  store.ensureSessionMetaRow("Y", { path: "/s/Y.jsonl", cwd: "/p", projectKey: "/p" });
  assert.equal(store.taskForSession("Y"), null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test lib/task-store.subtree.test.mjs`
Expected: FAIL —— `store.listDescendantIds is not a function`

- [ ] **Step 3: 实现 task-store 部分**

在 `lib/task-store.ts` 追加/修改（SQL 与现有 4 空格缩进、双引号风格保持一致）：

```ts
/** 按 parent_id 递归收集后代 id（不含自身）。深度优先、visited 去重防环。 */
export function listDescendantIds(sessionId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of getDb().prepare("SELECT session_id, parent_id FROM session_meta WHERE parent_id IS NOT NULL").all() as Array<{ session_id: string; parent_id: string }>) {
    const arr = childrenOf.get(r.parent_id) ?? [];
    arr.push(r.session_id);
    childrenOf.set(r.parent_id, arr);
  }
  const out: string[] = [];
  const seen = new Set<string>([sessionId]);
  const queue = [...(childrenOf.get(sessionId) ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(childrenOf.get(cur) ?? []));
  }
  return out;
}

/** 归属一条会话及其整棵子树（写库先于任何 UI 刷新；一次事务）。 */
export function assignSessionSubtreeToTask(sessionId: string, taskId: string): boolean {
  if (!getTaskRow(taskId)) return false;
  const ts = now();
  const db = getDb();
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE session_meta SET task_id = ?, updated = ? WHERE session_id = ?");
    for (const id of [sessionId, ...listDescendantIds(sessionId)]) stmt.run(taskId, ts, id);
    db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, taskId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateSessionListCache();
  return true;
}

/** 把一个会话及其整棵子树移出任务（task_id = NULL）。 */
export function unassignSessionSubtree(sessionId: string): void {
  const ts = now();
  const db = getDb();
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE session_meta SET task_id = NULL, updated = ? WHERE session_id = ?");
    for (const id of [sessionId, ...listDescendantIds(sessionId)]) stmt.run(ts, id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  invalidateSessionListCache();
}
```

`ensureSessionMetaRow` 的签名与 SQL 改为（`taskId` 缺省 → `NULL`，且 ON CONFLICT **不覆盖已存在的 task_id**，保持「归属各自管」的语义）：

```ts
export function ensureSessionMetaRow(sessionId: string, row: {
  path: string; cwd: string; projectKey: string;
  parentId?: string; firstMessage?: string; title?: string; taskId?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO session_meta
         (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         path = excluded.path,
         cwd = excluded.cwd,
         project_key = excluded.project_key,
         first_message = excluded.first_message,
         parent_id = excluded.parent_id,
         created = excluded.created,
         modified = excluded.modified`,
    )
    .run(
      sessionId, row.taskId ?? null, now(), row.path, row.cwd, row.projectKey,
      row.title ?? null, row.firstMessage ?? null, row.parentId ?? null, now(), now(),
    );
  invalidateSessionListCache();
}
```

`updateTask` 里 `patch.sessionIds` 分支改为子树闭包：

```ts
if (patch.sessionIds !== undefined) {
  // 入参是「根 id 列表」的闭包视图：加/减都以整棵子树为单位，避免子会话留在任务里当孤儿根。
  const next = new Set<string>();
  for (const id of patch.sessionIds) { next.add(id); for (const d of listDescendantIds(id)) next.add(d); }
  const current = new Set(listTaskSessionIds(id));
  const ts = now();
  const assign = db.prepare("UPDATE session_meta SET task_id = ?, updated = ? WHERE session_id = ?");
  const unassign = db.prepare("UPDATE session_meta SET task_id = NULL, updated = ? WHERE session_id = ?");
  for (const sessionId of next) if (!current.has(sessionId)) assign.run(id, ts, sessionId);
  for (const sessionId of current) if (!next.has(sessionId)) unassign.run(ts, sessionId);
  db.prepare("UPDATE tasks SET updated = ? WHERE id = ?").run(ts, id);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test lib/task-store.subtree.test.mjs lib/task-store.test.mjs lib/task-store.meta-row.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 扫描器归属收敛（含存量脏行自愈）的失败测试**

在 `lib/session-index-scanner.test.mjs` 追加（沿用该文件已有的临时目录 + `:memory:` 手法）：

```js
test("扫描收敛：父会话归属任务、子会话 task_id 为空 → 子会话继承父归属", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidx-affil-"));
  const proj = join(dir, "--p--");
  mkdirSync(proj, { recursive: true });
  const parentPath = join(proj, "2026-01-01T00-00-00-000Z_parent.jsonl");
  const childPath = join(proj, "2026-01-01T00-01-00-000Z_child.jsonl");
  writeFileSync(parentPath, sessionLine("parent", "/tmp/proj") + "\n");
  writeFileSync(childPath, sessionLine("child", "/tmp/proj", parentPath) + "\n");
  const db = new DatabaseSync(":memory:");
  setDbForTesting(db);
  db.prepare("INSERT INTO tasks (id, project_key, name, created, updated) VALUES ('T','/tmp/proj','t',1,1)").run();
  db.prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path) VALUES ('parent','T',1,0,?)").run(parentPath);
  await runSessionIndexScan(dir);
  assert.equal(db.prepare("SELECT task_id FROM session_meta WHERE session_id='child'").get().task_id, "T");
});
```

（`sessionLine(id, cwd, parentPath?)` 与 `mkdtempSync/join/tmpdir/mkdirSync/writeFileSync` 的 import 照抄该文件已有写法。）

- [ ] **Step 6: 跑测试确认失败，然后实现收敛**

Run: `node --experimental-strip-types --test lib/session-index-scanner.test.mjs`
Expected: FAIL（child 的 task_id 为 null）

在 `runSessionIndexScan()` 的 diff 循环之后、`return summary` 之前插入：

```ts
  // 归属收敛：子会话 task_id 为空而父会话有归属 → 继承父（自愈旧数据与写库失败的窗口；
  // 「归属按子树存」是本应用的约定，用户单独把子会话移出任务的状态不会出现）。
  const repaired = db.prepare(
    `UPDATE session_meta AS c
        SET task_id = (SELECT p.task_id FROM session_meta AS p WHERE p.session_id = c.parent_id)
      WHERE c.task_id IS NULL
        AND c.parent_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM session_meta AS p WHERE p.session_id = c.parent_id AND p.task_id IS NOT NULL)`,
  ).run();
  if (repaired.changes > 0) summary.updated += repaired.changes;
```

- [ ] **Step 7: fork / fork_branch / subagent 三处传归属**

`lib/rpc-manager.ts` fork 分支（`case "fork"` 的 `ensureSessionMetaRow(newSessionId, {...})` 处，约 700 行）——在返回值里带上源归属：

```ts
        const cwd = sessionManager.getCwd();
        const sourceTaskId = taskForSession(sourceSessionId);   // 需要 import { taskForSession }
        await this.shutdown();
        try {
          const project = await resolveProject(cwd ?? "");
          ensureSessionMetaRow(newSessionId, {
            path: newSessionFile,
            cwd: cwd ?? "",
            projectKey: projectIdentityKey(project?.projectRoot ?? cwd ?? ""),
            parentId: sourceSessionId,
            taskId: sourceTaskId,        // 归属继承：子会话与父同任务
          });
```

按同样的方式改 `case "fork_branch"`（`indexSessionFileNow` 之前取 `taskForSession(sessionManager.getSessionId())`）：

```ts
export async function indexSessionFileNow(
  filePath: string, parentSessionId: string | null, taskId: string | null = null,
): Promise<void> { /* INSERT/upsert 的 task_id 用 taskId（原为硬编码 NULL），ON CONFLICT 不覆盖 task_id */ }
```

`lib/subagent-runtime.ts`：在 `dependencies.registerSession(inner, {...})` 之后（约 258 行）同请求建行：

```ts
      // 子代理会话与 fork 同规则：落库即带父会话归属（否则只会在聊天区当孤儿根出现）。
      try {
        ensureSessionMetaRow(inner.sessionId, {
          path: inner.sessionFile ?? "",
          cwd: (isolatedWorktree ? childCwd : parent.cwd) ?? "",
          projectKey: projectIdentityKey((isolatedWorktree ? childCwd : parent.cwd) ?? ""),
          parentId: parentSessionId,
          taskId: taskForSession(parentSessionId),
          firstMessage: request.description.trim() || undefined,
        });
      } catch (e) {
        console.error("[pi-web] subagent 会话建行失败:", e instanceof Error ? e.message : String(e));
      }
```

- [ ] **Step 8: 两个归属入口改用子树版本**

`app/api/tasks/[id]/assign-session/route.ts:21` 与 `app/api/boards/[id]/add-session/route.ts:35`：`assignSessionToTask` → `assignSessionSubtreeToTask`。
`components/SessionSidebar.tsx:1136-1148 handleUnassignSession`：先取该会话在任务里的子树根（若其父也在同任务，则上溯到最高同任务祖先），只提交仍需保留的根列表——由服务端闭包语义兜底，前端不改逻辑即可，但**必须在测试里锁定**「以子会话为根移出 → 子会话与其后代一起离开任务」。

- [ ] **Step 9: 全量测试 + 类型检查 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`
Expected: 全绿

```bash
git add -A && git commit -m "feat(session): 子会话继承任务归属并按子树连带（fork/subagent/归属变更）"
```

---

### Task 2: 扫描器递归发现（含子目录与 header 权威 id）

**Files:**
- Modify: `lib/session-scanner.ts:253-290`（`scanSessionFileMeta` 递归、跳过隐藏目录、深度上限）
- Modify: `lib/session-index-scanner.ts:83-235`（行匹配改用 **path 优先**；新文件用 header.id 建行；非会话文件跳过）
- Test: `lib/session-scanner.test.mjs`、`lib/session-index-scanner.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `ensureSessionMetaRow`（不直接调用；本任务用自带 INSERT）
- Produces: `scanSessionFileMeta` 递归语义（`{path, id, modified}`，`id` 为文件名提示，可能为空串）

- [ ] **Step 1: 失败测试 —— 递归发现三种布局**

`lib/session-index-scanner.test.mjs` 追加：

```js
test("扫描递归：forks/ 与 <session>/<run>/run-0/ 子目录里的会话同样入库，父子链正确", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sidx-nested-"));
  const proj = join(dir, "--p--");
  const root = join(proj, "2026-01-01T00-00-00-000Z_root.jsonl");
  const forksDir = join(proj, "2026-01-01T00-00-00-000Z_root", "forks");
  const runDir = join(proj, "2026-01-01T00-00-00-000Z_root", "run-1", "run-0");
  mkdirSync(forksDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  writeFileSync(root, sessionLine("root", "/tmp/proj") + "\n");
  writeFileSync(join(forksDir, "2026-01-01T00-10-00-000Z_fork1.jsonl"), sessionLine("fork1", "/tmp/proj", root) + "\n");
  writeFileSync(join(runDir, "session.jsonl"), sessionLine("run1", "/tmp/proj", root) + "\n");
  writeFileSync(join(proj, "transcript.jsonl"), '{"type":"message","role":"user","content":"x"}\n');
  const db = new DatabaseSync(":memory:"); setDbForTesting(db);

  const summary = await runSessionIndexScan(dir);
  const rows = db.prepare("SELECT session_id, parent_id, task_id FROM session_meta ORDER BY session_id").all();
  assert.equal(summary.scanned, 3, "只认 3 个会话文件（transcript.jsonl 非会话被跳过）");
  assert.deepEqual(rows, [
    { session_id: "fork1", parent_id: "root", task_id: null },
    { session_id: "root", parent_id: null, task_id: null },
    { session_id: "run1", parent_id: "root", task_id: null },
  ]);
  assert.ok(rows.every((r) => r.task_id === null), "磁盘有、库无的会话＝临时会话（task_id NULL）");
});

test("扫描：库行按 path 精确匹配（同 id 旧副本不复活，子目录文件移动到新路径被跟随）", async () => {
  // 见报告：断言 path 变化时 upsert 覆盖 path，且旧 path 的行不会被当作另一个会话留下
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test lib/session-index-scanner.test.mjs`
Expected: FAIL —— `summary.scanned` 为 1（只看到 root）

- [ ] **Step 3: 实现递归扫描**

`lib/session-scanner.ts` 把 `scanSessionFileMeta` 的目录遍历换成递归：

```ts
const MAX_SCAN_DEPTH = 6;   // `<project>/<session>/<run>/run-0/session.jsonl` 为 3 层，留余量

/** 会话文件候选 id：`<...>_<id>.jsonl` 取末段；`session.jsonl` 等无名文件返回 ""（由 header 决定）。 */
function idHintFromName(name: string): string {
  const stem = name.slice(0, -".jsonl".length);
  const last = stem.split("_").pop() ?? "";
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(last) && !/^[0-9]+$/.test(last) ? last : "";
}

async function walkJsonl(dir: string, depth: number, out: Array<{ path: string; id: string; modified: Date }>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 单个目录不可读 → 跳过，不影响其它目录
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SCAN_DEPTH) await walkJsonl(full, depth + 1, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isFile() || stat.size === 0) continue;
    out.push({ path: full, id: idHintFromName(entry.name), modified: stat.mtime });
  }
}
```

`scanSessionFileMeta` 主体改为：readdir 根目录拿项目目录 → 对每个项目目录 `await walkJsonl(projectDir, 1, metas)` → 末尾按 mtime desc 排序返回。`scanSessionFiles`（全量头尾版）与 `sessionScanner.scan` 保持原样（T5 会删掉它们的调用方）。

- [ ] **Step 4: 索引扫描改「path 优先 + header 权威 id」**

`lib/session-index-scanner.ts` 的 `runSessionIndexScan`：

```ts
  const allDiskFiles = await scanSessionFileMeta(sessionsDir);
  const db = getDb();
  const selectAll = db.prepare("SELECT session_id, modified, path, parent_id, first_message FROM session_meta").all() as ...;
  const rowById = new Map(...);                       // 原样
  const rowByPath = new Map(selectAll.filter((r) => r.path).map((r) => [sessionPathKey(r.path!), r.session_id]));

  // 磁盘 → 库行：先按原文件名提示的 id 认，再按 path 认（path 是会话与文件的唯一绑定）
  for (const file of allDiskFiles) {
    const byHint = file.id ? rowById.get(file.id) : undefined;
    const byPathId = rowByPath.get(sessionPathKey(file.path));
    const row = (byPathId && rowById.get(byPathId)) ?? byHint;
    ...
  }
```

新文件（库中任何行都没有）：读 header（`scanOneSessionHead`）→ **用 `head.id` 建行**（不再用文件名推导的 id）；`pathToId` 映射用 **全部已解析文件** 的 path（含子目录）→ parent 反查；parent 解析不到但 header.parentSession 存在时保留 `parentId = null`（下轮或别名解析后再收敛）。删除分支改为「库行的 path 不在本轮磁盘 path 集合里，且 `existsSync(row.path)` 为假 → 删」。

- [ ] **Step 5: 跑测试确认通过**

Run: `node --experimental-strip-types --test lib/session-scanner.test.mjs lib/session-index-scanner.test.mjs`
Expected: PASS（含 Step 1 的两条新测试）

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat(session): 索引扫描器递归发现子目录会话，按 path 匹配、header 权威 id 建行"
```

---

### Task 3: 事件驱动 last_reply / modified（含 schema v12）

**Files:**
- Modify: `lib/sqlite-db.ts`（`SCHEMA_VERSION` 11 → 12；`MIGRATIONS` 追加 `session_meta.last_reply`）
- Create: `lib/session-activity.ts`（纯函数事件映射）
- Modify: `lib/task-store.ts`（`touchSessionActivity` / `recordSessionOutcome` / `fillFirstMessageIfEmpty`）
- Modify: `lib/rpc-manager.ts:271-279`（subscribe 回调里接上事件映射 + 落库）
- Test: `lib/session-activity.test.mjs`（新建）、`lib/sqlite-db.test.mjs`（追加迁移断言）、`lib/task-store.activity.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `ensureSessionMetaRow`（不涉及）
- Produces: `LAST_REPLY_MAX`、`touchSessionActivity`、`recordSessionOutcome`、`fillFirstMessageIfEmpty`、`handleSessionActivity`；`session_meta.last_reply`

- [ ] **Step 1: 迁移失败测试**

`lib/sqlite-db.test.mjs` 追加：

```js
test("schema v12：老库升级后 session_meta 有 last_reply 列，新库直接具备", () => {
  const old = new DatabaseSync(":memory:");
  old.exec("PRAGMA user_version = 11");
  old.exec("CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, task_id TEXT, updated INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, path TEXT, cwd TEXT, project_key TEXT, title TEXT, first_message TEXT, parent_id TEXT, created INTEGER, modified INTEGER)");
  initSchema(old);
  const cols = old.prepare("PRAGMA table_info(session_meta)").all().map((c) => c.name);
  assert.ok(cols.includes("last_reply"));
  assert.equal(old.prepare("PRAGMA user_version").get().user_version, 12);
});
```

- [ ] **Step 2: 跑测试确认失败，然后实现迁移**

Run: `node --experimental-strip-types --test lib/sqlite-db.test.mjs` → FAIL

`lib/sqlite-db.ts`：

```ts
export const SCHEMA_VERSION = 12;
// MIGRATIONS 末尾追加：
  {
    version: 12,
    name: "session_meta.last_reply（最后一条消息入库，列表零扫盘）",
    statements: [
      "ALTER TABLE session_meta ADD COLUMN last_reply TEXT;",
    ],
  },
```

- [ ] **Step 3: 事件映射纯函数 + 失败测试**

`lib/session-activity.test.mjs`：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: { "@": process.cwd() } });
const { handleSessionActivity, lastAssistantText } = await jiti.import("./session-activity.ts");

const assistant = (text, ts, stopReason = "stop") => ({ role: "assistant", timestamp: ts, stopReason, content: [{ type: "text", text }] });

test("agent_start → touch（只刷活跃时间，浮动到列表顶部）", () => {
  assert.deepEqual(handleSessionActivity({ type: "agent_start" }), { kind: "touch" });
});

test("单条 message_end 不落 outcome（不是循环最后一条）", () => {
  assert.equal(handleSessionActivity({ type: "message_end", message: assistant("中间回复", 1000) }), null);
});

test("agent_settled → outcome（带最后一条 assistant 文本与时间戳）", () => {
  const seq = [
    { type: "message_end", message: assistant("第一条", 1000) },
    { type: "message_end", message: { role: "user", content: "再问" } },
    { type: "message_end", message: assistant("最后一条回复", 2000) },
    { type: "agent_settled" },
  ];
  const effects = seq.map(handleSessionActivity).filter(Boolean);
  assert.deepEqual(effects.at(-1), { kind: "outcome", lastReply: "最后一条回复", at: 2000 });
});

test("用户取消（stopReason=aborted）同样落 outcome", () => {
  const seq = [
    { type: "message_end", message: assistant("被打断的半截回复", 3000, "aborted") },
    { type: "agent_settled" },
  ];
  const effects = seq.map(handleSessionActivity).filter(Boolean);
  assert.deepEqual(effects.at(-1), { kind: "outcome", lastReply: "被打断的半截回复", at: 3000 });
});

test("lastAssistantText：只取 text 块，thinking/toolCall 忽略", () => {
  assert.equal(lastAssistantText({ role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  assert.equal(lastAssistantText({ role: "assistant", content: "plain" }), "plain");
});
```

- [ ] **Step 4: 实现 lib/session-activity.ts**

```ts
// ============================================================================
// 会话活跃事件 → 数据库写入意图（纯函数，无 IO）
//
// 背景：会话列表的「最后一条消息」「最后活跃时间」原先由 30s 扫描器从文件
// mtime 反推（滞后 ≤30s，且发消息不刷库）。改为事件驱动：一轮循环真正结束
// 时（agent_settled）把最后一条 assistant 文本与时间戳落库；用户取消走同一条
// 路径（SDK 会为取消生成 stopReason="aborted" 的 assistant 消息）。
//   · agent_start                → touch（活跃时间立刻前移，运行中会话浮顶）
//   · message_end(assistant)     → 缓存本轮最后一条（不落库；一轮可能多条）
//   · agent_settled              → outcome（落 last_reply + modified）
// 状态必须**按 wrapper 实例**持有：多个会话并发跑时共享模块级变量会串台。
// ============================================================================

export interface AgentLikeMessage { role?: string; content?: unknown; timestamp?: number; stopReason?: string }
export type SessionActivityEffect = { kind: "touch" } | { kind: "outcome"; lastReply: string; at: number };

/** assistant 消息的纯文本（text 块拼接；无 text 返回 ""）。 */
export function lastAssistantText(message: AgentLikeMessage): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text?: string } => Boolean(b) && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

/** 每个 AgentSessionWrapper 持有一个 tracker，内部缓存「本轮最后一条 assistant」。 */
export function createSessionActivityTracker(): {
  handle(event: { type: string; message?: AgentLikeMessage }): SessionActivityEffect | null;
} {
  let pending: { lastReply: string; at: number } | null = null;
  return {
    handle(event) {
      if (event.type === "agent_start") return { kind: "touch" };
      if (event.type === "message_end") {
        const message = event.message;
        if (message?.role === "assistant") {
          const text = lastAssistantText(message);
          if (text) pending = { lastReply: text, at: typeof message.timestamp === "number" ? message.timestamp : Date.now() };
        }
        return null;
      }
      if (event.type === "agent_settled") {
        const outcome = pending ?? { lastReply: "", at: Date.now() };
        pending = null;
        return { kind: "outcome", ...outcome };
      }
      return null;
    },
  };
}
```

`lib/session-activity.test.mjs` 的用例改为每个 case `const tracker = createSessionActivityTracker();` 再 `tracker.handle(...)`。
`AgentSessionWrapper` 构造函数里加 `private readonly activityTracker = createSessionActivityTracker();`。

- [ ] **Step 5: task-store 的三个写入函数 + 失败测试**

`lib/task-store.activity.test.mjs`：

```js
test("touchSessionActivity 只刷 modified，不建行（无行时静默 no-op）", () => { /* UPDATE 断言 + 无行不新增 */ });
test("recordSessionOutcome 写 last_reply + modified，超 4000 字符截断", () => { /* 断言 lastReply.slice(0,4000) */ });
test("fillFirstMessageIfEmpty 只在为空时写入（已有 first_message 不被覆盖）", () => { /* 断言两次调用后仍是首值 */ });
```

实现（`lib/task-store.ts`）：

```ts
/** last_reply 入库上限（与 types.ts 的「截断」语义一致，防大消息撑爆行）。 */
export const LAST_REPLY_MAX = 4000;

/** 会话活跃时间前移（只 UPDATE，不建行：会话行由创建/扫描建立）。 */
export function touchSessionActivity(sessionId: string, at: number = now()): void {
  getDb().prepare("UPDATE session_meta SET modified = ? WHERE session_id = ?").run(at, sessionId);
  invalidateSessionListCache();
}

/** 一轮循环结束：落最后一条 assistant 文本 + 活跃时间。 */
export function recordSessionOutcome(sessionId: string, outcome: { lastReply: string; at: number }): void {
  const text = outcome.lastReply.length > LAST_REPLY_MAX ? outcome.lastReply.slice(0, LAST_REPLY_MAX) : outcome.lastReply;
  getDb().prepare("UPDATE session_meta SET last_reply = ?, modified = ? WHERE session_id = ?").run(text, outcome.at, sessionId);
  invalidateSessionListCache();
}

/** 首条用户消息回填（读取路径不再读文件，改由事件/扫描补齐）。 */
export function fillFirstMessageIfEmpty(sessionId: string, firstMessage: string): void {
  if (!firstMessage) return;
  getDb().prepare("UPDATE session_meta SET first_message = ? WHERE session_id = ? AND (first_message IS NULL OR first_message = '')").run(firstMessage, sessionId);
  invalidateSessionListCache();
}
```

- [ ] **Step 6: 接进 wrapper 的事件订阅**

`lib/rpc-manager.ts` 的 `start()` 回调（271-279 处）追加：

```ts
            const effect = this.activityTracker.handle(event as { type: string; message?: AgentLikeMessage });
        if (effect?.kind === "touch") {
          try { touchSessionActivity(session.sessionId ?? this.sessionId); } catch (e) { console.error("[pi-web] 会话活跃时间写库失败:", e); }
        } else if (effect?.kind === "outcome") {
          const id = session.sessionId ?? this.sessionId;
          try {
            recordSessionOutcome(id, effect);
            fillFirstMessageIfEmpty(id, firstUserMessageOf(manager.getEntries()));
          } catch (e) { console.error("[pi-web] 会话结果写库失败:", e); }
        }
```

`firstUserMessageOf(entries)` 用**内存里已加载的 entries**（不读文件）取首条 user 文本，限制前 300 字符（与 `FIRST_MESSAGE_PREVIEW_LENGTH` 一致）。

- [ ] **Step 7: 跑测试 + 类型检查 + 提交**

Run: `npm test && node_modules/.bin/tsc --noEmit`

```bash
git add -A && git commit -m "feat(session): agent_settled 事件落 last_reply/modified（含取消），schema v12"
```

---

### Task 4: 写路径补齐（auto-name 写库、局部行补全、失败可见）

**Files:**
- Modify: `app/api/sessions/[id]/auto-name/route.ts:29-31`（写完文件后写库）
- Modify: `lib/task-store.ts`（`setSessionTitle` / `setSessionPinned` / `assignSessionToTask` 对无行会话先建**全列行**，不再插局部行）
- Modify: `lib/rpc-manager.ts:700-712`（去掉静默 `catch {}`，改成 `console.error`）
- Test: `lib/task-store.partial-row.test.mjs`（新建）、`app/api/sessions/auto-name.test.mjs`（新建，源码断言 + jiti 行为测试）

**Interfaces:**
- Consumes: Task 1 的 `ensureSessionMetaRow`；Task 3 的 `setSessionTitle`（未改签名）
- Produces: `ensureRowForSession(sessionId): boolean`（内部辅助：按 DB path 或名字解析文件 → 读 header → 建全列行）

- [ ] **Step 1: 失败测试 —— 无行会话被改名/置顶后必须有全列行**

```js
test("setSessionTitle 对无行会话建全列行（path/project_key/created 齐全，不再是 1970 局部行）", async () => {
  // 用临时 PI_CODING_AGENT_DIR + 一个真实写入的会话文件，调 setSessionTitle
  // 断言：行存在，且 path !== null、project_key !== null、created > 0
});
test("setSessionPinned / assignSessionToTask 同样不产生缺列行", () => { /* 同上三条断言 */ });
```

- [ ] **Step 2: 跑测试确认失败，实现 `ensureRowForSession`**

```ts
/** 给「已有会话但库里没行」的场景建一条全列行：定位文件 → 读 header → upsert。
 *  DB path 优先（库是事实源），miss 才按文件名找；都找不到返回 false（调用方保持原语义）。 */
async function ensureRowForSession(sessionId: string): Promise<boolean> {
  if (getDb().prepare("SELECT 1 FROM session_meta WHERE session_id = ?").get(sessionId)) return true;
  const { resolveSessionPath } = await import("./session-reader");
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;
  const head = scanOneSessionHead(filePath);
  if (!head) return false;
  const project = await resolveProject(head.cwd);
  ensureSessionMetaRow(sessionId, {
    path: filePath, cwd: head.cwd,
    projectKey: projectIdentityKey(project?.projectRoot ?? head.cwd),
    parentId: undefined, firstMessage: head.firstMessage || undefined,
  });
  return true;
}
```

`setSessionTitle` / `setSessionPinned` / `assignSessionToTask` 在无行时 `await ensureRowForSession(sessionId)` 再执行原 UPDATE。**三者签名变 async**，必须同步改所有调用点（缺一个就是 `tsc` 报错，用类型检查兜底）：

| 文件:行 | 处理 |
|---|---|
| `app/api/sessions/[id]/route.ts:111` | `await setSessionTitle(...)`（路由已 async） |
| `app/api/sessions/[id]/route.ts:119` | `await setSessionPinned(...)` |
| `app/api/agent/new/route.ts:88` | `await assignSessionSubtreeToTask(...)`（Task 1 已换名） |
| `lib/task-scheduler.ts:159` | `await assignSessionToTask(...)`（在 async 函数内） |
| `lib/task-store.meta-row.test.mjs:68` 等既有测试 | 调用处补 `await`（该用例已有行，行为不变） |
| `lib/board-reconcile.test.mjs` / `lib/task-store.test.mjs` | 若有直接调用，同样补 `await` |

**互斥检查**：`assignSessionToTask`（单节点）在本任务只加 async；子树版本由 Task 1 提供，路由已经改调子树版本，两者不冲突。

- [ ] **Step 3: auto-name 写库（先 pi、成功、写库）**

```ts
    session.inner.setSessionName(result.title);
    // pi 写入成功后再落库：扫描器不读文件尾，只写文件会让侧栏标题与聊天标题永久分叉。
    await setSessionTitle(id, result.title);
    invalidateSessionListCache();
```

- [ ] **Step 4: fork 建行失败不再静默**

`lib/rpc-manager.ts:700-712` 的 `catch {}` 改为：

```ts
        } catch (error) {
          // 不阻塞 fork（文件已经在了），但必须可见：静默失败会让子会话在 ≤30s 内以临时会话（无归属）
          // 出现在聊天区，正是「子会话两区重复」的病灶。扫描器的归属收敛是第二道网。
          console.error(`[pi-web] fork 建行失败 session=${newSessionId}:`, error instanceof Error ? error.message : String(error));
        }
```

- [ ] **Step 5: 跑测试 + 类型检查 + 提交**

```bash
git add -A && git commit -m "fix(session): 写路径补齐——auto-name 落库、消除缺列局部行、fork 建行失败可见"
```

---

### Task 5: 读取路径零扫盘

**Files:**
- Modify: `lib/session-reader.ts`：`loadProjectSessions` / `loadAllSessionIndex` / `loadSessionDetailsFromMeta`（SELECT 加 `last_reply`，映射 `lastReply`）；**删除** `fillFirstMessageFromFile`；**删除** `buildTaskSessionIndex`，`loadTaskSessionsPageWithIndex` 改读 DB `parent_id`/`modified`；`resolveSessionPath` 改「DB path 优先」，`resolveSessionIdByPath` 改查 DB；删除 `loadAllSessions`（全量头尾扫）与其调用方
- Modify: `app/api/tasks/route.ts:20`（不再构建磁盘索引）
- Modify: `lib/session-delete.ts:21-50`（`collectSessionDescendants` 改按 DB `parent_id`）
- Modify: `lib/session-search.ts`（若引用 `loadAllSessions` 改引用 `loadAllSessionIndex`）
- Test: `lib/session-reader.noscan.test.mjs`（新建）、`lib/session-delete.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 2（扫描器保证磁盘会话都有行）、Task 3（`last_reply` 已入库）、Task 1（`listDescendantIds`）
- Produces: 列表/任务区/路径解析的零扫盘实现

- [ ] **Step 1: 失败测试 —— 会话目录为空/不可读时列表照常工作**

```js
test("列表零扫盘：sessions 目录不存在，列表仍返回库内会话（含 lastReply）", async () => {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-empty-"));   // 空 agentDir
  const db = new DatabaseSync(":memory:"); setDbForTesting(db);
  db.prepare("INSERT INTO session_meta (session_id, task_id, updated, pinned, path, cwd, project_key, title, first_message, parent_id, created, modified, last_reply) VALUES (?,NULL,?,0,?,?,?,?,?,?,?,?,?)")
    .run("s1", Date.now(), "/nope/s1.jsonl", "/tmp/proj", "/tmp/proj", null, "首条消息", null, 1, 2, "最后一条回复");
  globalThis.__piSessionIndexScanner = { timer: undefined, firstScanDone: true };
  const list = await loadProjectSessions("/tmp/proj");
  assert.equal(list.length, 1);
  assert.equal(list[0].lastReply, "最后一条回复");
});

test("resolveSessionPath 先查库 path，不做名字扫描", async () => { /* 库内 path 指向临时文件 → 返回该 path，且不调用 readdir */ });
test("任务区子树来自 session_meta.parent_id：buildTaskSessionIndex 已不存在，/api/tasks 不再 readdir", async () => { /* 断言模块不再导出该函数；分页结果的父子关系来自库 */ });
test("collectSessionDescendants 按库 parent_id 递归（磁盘目录不可读也能返回整棵子树）", async () => { /* ... */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-strip-types --test lib/session-reader.noscan.test.mjs`

- [ ] **Step 3: 实现（逐点改）**

1. 三处 SELECT 加 `last_reply`；`mapSessionMetaRow` 加 `lastReply: (r.last_reply as string | null) ?? ""`。
2. 删 `fillFirstMessageFromFile`（三个调用点去掉该包装）。
3. `loadTaskSessionsPageWithIndex(taskId, offset, limit)` 改为只查库：

```ts
  const rootIds = listTaskSessionIds(taskId);            // 库内该任务的全部节点
  const allRows = /* SELECT session_id, parent_id, modified FROM session_meta WHERE task_id = ? */;
  // 根 = 其 parent 不在本任务集合内（或 parent 为空）的节点；子树用 parent_id 递归收集
```

并删掉 `buildTaskSessionIndex`、`app/api/tasks/route.ts` 里的 `const index = await buildTaskSessionIndex()`。
4. `resolveSessionPath`：

```ts
export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;
  // 库是路径的事实源：命中即用（不扫盘、不读目录）
  try {
    const row = getDb().prepare("SELECT path FROM session_meta WHERE session_id = ?").get(sessionId) as { path: string | null } | undefined;
    if (row?.path && existsSync(row.path)) { cacheSessionPath(sessionId, row.path); return row.path; }
  } catch { /* db 不可用 → 走名字兜底 */ }
  const direct = await findSessionPathByName(sessionId);
  if (direct) { cacheSessionPath(sessionId, direct); return direct; }
  return null;                                     // 不再触发全量头尾扫
}
```

`resolveSessionIdByPath` 改为 `SELECT session_id FROM session_meta WHERE path = ?`（`sessionPathKey` 归一化后比较另做一次字典序等价的 LIKE 兜底），删掉 `listAllSessions()` 调用。
5. `collectSessionDescendants(rootId)` 改为返回 `[rootId, ...listDescendantIds(rootId)]`（保持 async 签名）。
6. 顺带删掉死代码：`loadAllSessions()`（全量头尾扫）、`listAllSessions()`（5 分钟缓存包装）、`sessionScanner.scan` 的导出（若无其它调用方，`grep` 确认），以及 `lib/session-reader.test.mjs:375-408` 里针对 `listAllSessions` 的用例（删除或改为 `loadAllSessionIndex` 等价断言）。`scanSessionFiles` 若仍无人调用，一并删除并同步 `lib/session-scanner.test.mjs`。

- [ ] **Step 4: 跑测试 + 全量回归 + 类型检查**

Run: `npm test && node_modules/.bin/tsc --noEmit && npm run lint`

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "refactor(session): 列表/任务区/路径解析全部改查 session_meta，删除读取期扫盘与文件回填"
```

---

### Task 6: 侧栏运行中浮顶（顺序修正）+ 任务区子会话行拖出护栏

**补充裁定（2026-09-18，T6 审查后）**：
- 浮顶只适用于**聊天区**（任务区按任务分组排序，有意不浮顶；单参调用语义由测试锁定）。
- 不要用「关掉拖拽源」来阻止子会话被拖出任务：`draggable={false}` 会连带丢掉「拖到看板行/画布建卡」这类非归属手势。改为：行保持可拖，拖拽载荷里带上深度标记（`text/session-depth` 与现有 `text/session-title` 并列），**只**在归属类落点（聊天区 unassign、TaskArea 的 `SESSION_MIME`）拒绝 `depth > 0`。
- 运行中浮出的会话不参与时间分组标签（避免「昨天/今天/昨天」重复标签）。

**Files:**
- Modify: `components/SessionSidebar.tsx:1151-1167, 1186-1193`
- Test: `components/SessionSidebar.test.mjs`（追加）

- [ ] **Step 1: 失败测试**

```js
test("chatNodes：运行中会话在非置顶段内浮顶，不被 modified 全量重排覆盖", () => {
  // 构造：runningIds 含 s-old（modified 很旧），另一会话 s-new（modified 最新）
  // 断言：排序结果里 s-old 在 s-new 之前
});
```

- [ ] **Step 2: 实现**

`orderPinnedFirst(nodes, runningIds?)` 的排序键改为「置顶段 → 运行中 → modified 降序」，`chatNodes` 传 `runningSessionIds` 并去掉 `[...running, ...rest]` 拼接。

- [ ] **Step 3: 跑测试 + 提交**

```bash
git add -A && git commit -m "fix(sidebar): 运行中会话在段内真正浮顶（此前被按 modified 重排覆盖）"
```

---

### Task 7: e2e 验证（新建测试数据，最后清理）

**Files:**
- Create: `.agent/script/browser_automation/e2e-session-meta-truth.mjs`（playwright 脚本，参数化 baseURL）
- Report: `.agent/tmp/e2e-report.md`

**前置（强制）：**
- [ ] **Step 1: 备份真实数据库**

```bash
mkdir -p .agent/tmp/db-backup-$(date +%Y%m%d-%H%M%S)
cp ~/.pi/agent/pi-web.db* .agent/tmp/db-backup-*/
```

- [ ] **Step 2: 起本 worktree 的 dev server（独立端口，避免影响 30143/30141）**

```bash
tmux new -d -s piweb-dev "cd $(pwd) && PORT=30155 node server.mjs > /tmp/piweb-dev.log 2>&1"
```

**须知**：`server.mjs` 启动即跑新版扫描器（`instrumentation.ts` → `startSessionIndexScanner`），它会对真实 `~/.pi/agent` 做两件可预期的事——把 `forks/` 等子目录里的历史会话建成新行（决策 2 要的行为）、把存量「父在任务、子为空」的脏行收敛成继承（Task 1 要的行为）。这两件事就是本次修复的目标，Step 1 的备份是唯一的安全网；在下发前把这一步告诉用户，得到「可以跑」再执行。

- [ ] **Step 3: 用**新建**数据走完整链路**（自己建任务 + 会话，绝不动用户会话）
  1. `POST /api/tasks` 建任务「e2e-临时-<时间戳>」；
  2. `POST /api/agent/new` 用 `type:"ensure_session"` + 指定 id + 该 taskId 建会话；
  3. 给该会话发一条短 prompt（`POST /api/agent/[id]` `type:"prompt"`）；
  4. 等 `agent_settled` → 断言 `session_meta` 里该行 `last_reply` 非空、`modified` 在最近 60s 内（**这就是「列表零扫盘」的证据**：不跑扫描器也拿到了最后消息）；
  5. 对该会话 `fork` → 断言子会话行 `task_id` 与父相同（V1 修复证据）；
  6. `GET /api/sessions?project=` 与 `GET /api/tasks?projectKey=` → 断言子会话**只**出现在任务区，不在聊天区（原 bug 的回归检测）；
  7. 对 `forks/` 那类历史布局：在临时 agentDir 里跑一遍 `runSessionIndexScan`（单元级已覆盖），真实盘只做只读观察，记录行数变化。

- [ ] **Step 4: 清理自己的数据 + 记录证据**

```bash
# 删除 e2e 任务与它下面的会话（只删自己创建的 id，删前用返回的 deletedSessionIds 核对）
```

把每一步的 curl 输出、SQL 快照、以及「用户数据未被改动」的对比（会话总数、既有会话 id 集合的差集）写进 `.agent/tmp/e2e-report.md`。

---

### Task 4b: `set_session_name` RPC 命令也落库标题

**为什么单列一个任务**：Task 4 的 implementer 发现——除了 `PATCH /api/sessions/[id]` 与 `auto-name` 路由，`lib/rpc-manager.ts` 的 `send` 里还有 `case "set_session_name"` 路径会改名（前端/看板卡走这条），它同样**不写库**，是审计 V2 的同一个洞。

**Files:**
- Modify: `lib/rpc-manager.ts`（`case "set_session_name"` 分支）
- Test: `lib/rpc-manager.title.test.mjs`（新建，源码+行为断言）

- [ ] **Step 1: 失败测试**

```js
// 断言：case "set_session_name" 分支在 pi 侧成功后调用 await setSessionTitle(...)，且失败时 console.error + 不抛断事件流
// 参考 lib/rpc-manager.activity.test.mjs 的接线测试写法（注入假 DB/假 inner）
```

- [ ] **Step 2: 实现**

```ts
      case "set_session_name": {
        const name = command.name as string;
        this.inner.setSessionName(name);                 // pi 侧成功
        try { await setSessionTitle(this.inner.sessionId, name); }   // 库侧（参数校验/权限不变）
        catch (e) { console.error("[pi-web] 会话标题写库失败:", e); }
        invalidateSessionListCache();
        return null;
      }
```

- [ ] **Step 3: 全量测试 + `tsc --noEmit` + 提交**

```bash
npm test && node_modules/.bin/tsc --noEmit
git add -A && git commit -m "fix(session): set_session_name 命令同步写 session_meta.title"
```

---

### Task 8: 内置 subagent 会话标题取 `description`

**为什么单列一个任务**：用户 2026-09-18 追加的需求——内置 subagent 工具有一个 `description` 参数，**有值时就视为该子会话的标题**，不再依赖首条消息兜底（否则侧栏/看板卡上看到的是被委派任务的原文，而不是作者写的短描述）。

**Files:**
- Modify: `lib/subagent-runtime.ts`（建行处，约 265-274 行：T1 已在这里建行）
- Test: `lib/subagent-session-title.test.mjs`（新建）

**Interfaces:**
- Consumes: `ensureSessionMetaRow(sessionId, { path, cwd, projectKey, parentId?, firstMessage?, title?, taskId? })`（T1）
- Produces: 子会话行 `title = description.trim()`（非空时），`firstMessage` **不再写 description**（留 NULL，等扫描器/事件按真实首条用户消息回填）

- [ ] **Step 1: 失败测试**

```js
// 断言：description 非空 → 建行时 title === description.trim()（不依赖首条消息）
// 断言：description 为空/全空格 → title 为 NULL（不写空串，保持「无自定义名」的展示回退）
// 断言：first_message 不被写入 description（扫描器/事件回填真实首条消息）
```

- [ ] **Step 2: 实现**

```ts
        const description = request.description.trim() || metadata.description.trim() || "";
        ensureSessionMetaRow(inner.sessionId, {
          path: inner.sessionFile ?? "",
          cwd: (isolatedWorktree ? childCwd : parent.cwd) ?? "",
          projectKey: projectIdentityKey((isolatedWorktree ? childCwd : parent.cwd) ?? ""),
          parentId: parentSessionId,
          taskId: taskForSession(parentSessionId),
          ...(description ? { title: description } : {}),   // 有值即标题（用户规则）
        });
```

- [ ] **Step 3: 全量测试 + `tsc --noEmit` + 提交**

```bash
npm test && node_modules/.bin/tsc --noEmit
git add -A && git commit -m "feat(subagent): 子会话标题取 description（有值即标题）"
```

---

## 自检清单（写完计划后核对）

- 决策 1（事件机制）→ Task 3（agent_settled + 取消走同路径）
- 决策 2（扫文件按库规范建临时会话）→ Task 2（递归 + 建行 `task_id NULL` + 父子链 + 归属收敛）
- 决策 3（多实例）→ 不处理（无任务，仅在最终报告说明）
- 决策 4（零扫盘）→ Task 5（+ Task 3 提供 `last_reply` 数据来源）
- V1（子会话两区重复）→ Task 1（继承 + 子树 + 收敛）
- V2（auto-name 不写库 / fork 静默失败）→ Task 4
- V3（活跃时间滞后）→ Task 3
- V4（缺列局部行）→ Task 4
- V5（列表无最后一条消息）→ Task 3 + Task 5
- V6（读取期扫盘）→ Task 5
- V7（子目录会话不可见）→ Task 2
- V8（多实例）→ 不处理

后续追加的任务（计划下发后的收尾修复波）：

- Task 4b（`set_session_name` RPC 命令也写库标题）→ V2（改名三路径都落库）
- Task 6（侧栏运行中浮顶 + 任务区子会话行拖出护栏）→ 决策 2 / V1（归属按子树的 UI 护栏）
- Task 7（e2e 验证：隔离跑，不写真实数据）→ V1–V7 的端到端回归
- Task 8（内置 subagent 会话标题取 `description`）→ V2（建行时 `title` 的来源与三态一致）
