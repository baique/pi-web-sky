# 侧边栏任务分组与全局搜索 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 本 session inline 执行（executing-plans 风格，app 上下文庞大不派子代理）。Steps 用 checkbox 跟踪。
> Spec: `.agent/spec/2026-08-27-sidebar-tasks-search.md`

**Goal:** 侧边栏改成「会话/文件」双 tab；会话视图加任务区（任务会话 + 临时会话，拖拽移入移出）；顶栏加全局搜索（标题+正文，FTS5 trigram），点击跨目录跳转；分支导航移入文件页底部。

**Architecture:** 数据层用 `node:sqlite` 单库（tasks + session_meta + FTS5 trigram 索引）经 API 暴露；前端纯消费接口。SessionSidebar 重构为 tabs 化，分支导航数据从 AppShell 下传。

**Tech Stack:** node:sqlite（内置）、Next.js 16 route handlers、React 19、原生 HTML5 DnD（不引第三方）。

## Global Constraints

- 引擎要求 node ≥22.19（`node:sqlite` 22.13+ 免 flag，本地 v25.2.1 已验证 FTS5+trigram）。
- **中文检索必须 trigram**：`unicode61` 对 CJK 整词切分不可用（实测 0 命中）。
- trigram **<3 字符查询不命中** → 走 FTS 表 `LIKE '%q%'` 兜底（实测可用）。
- FTS5 MATCH 特殊字符需引号转义：`'"' + q.replace(/"/g, '""') + '"'`。
- 归属只写旁路元数据 `~/.pi/agent/pi-web.db`；**`.jsonl` 文件原地不动**。
- 样式全部引用现有 token（`--side-*`/`--accent`/`--border` 等），不写死 rgba/px；毛玻璃浮层必须 portal 到 `<body>` 锚定（NOTES.md 坑）。
- 不新增 runtime 依赖。测试遵循 dev skill：必要功能测试、`try/finally` + 事务回滚、不保留测试数据。
- 提交纪律：每任务独立 commit；不碰用户未提交的 `MessageView.tsx` / `tsconfig.json`。

---

## Task 1: SQLite 单例 + Schema 迁移

**Files:**
- Create: `lib/sqlite-db.ts`
- Test: `lib/sqlite-db.test.mjs`

**Interfaces:**
- Produces: `getDb(): DatabaseSync`（幂等单例，内存 `:memory:` 供测试注入——用 `setDbForTesting(db)`）、`DB_PATH` 常量、`initSchema(db: DatabaseSync): void`（幂等 DDL，见 spec §3.1）

- [ ] **Step 1: 写失败测试**（内存库建 schema → 4 张表存在、FTS 可 MATCH、LIKE 可查、幂等可重复 init）
- [ ] **Step 2: 运行确认失败**（`npm test -- --test-name-pattern sqlite-db` 或直接 `node --experimental-strip-types --test lib/sqlite-db.test.mjs`）
- [ ] **Step 3: 实现**：DB 路径 = `joinPath(getAgentDir(), "pi-web.db")`；`globalThis.__piWebDb` 单例；DDL 含 tasks / session_meta / search_state / session_search(fts5 trigram)
- [ ] **Step 4: 测试通过 + commit** `feat: sqlite 单例与 schema（任务/归属/FTS5 trigram）`

## Task 2: 任务存储 CRUD

**Files:**
- Create: `lib/task-store.ts`
- Test: `lib/task-store.test.mjs`

**Interfaces:**
- Produces:
  - `listTasks(projectKey: string): Task[]` 其中 `Task = { id, projectKey, name, created, updated, sessionIds: string[] }`
  - `createTask(projectKey, name): Task`
  - `updateTask(id, patch: { name?: string; sessionIds?: string[] }): Task | null`（sessionIds 全量替换，diff 只改本任务成员归属；`session_meta.task_id` 为目标 id 的置 NULL、其余写入 id；**不得**动其他任务成员）
  - `deleteTask(id): void`（成员 task_id 置 NULL）
  - `taskForSession(sessionId): string | null`
- 内部：`listTasks` 用 `GROUP_CONCAT` 或二次查询组装 sessionIds（按更新顺序——用 `session_meta.updated` 排序）；projectKey 校验非空；name trim 非空。

- [ ] **Step 1: 失败测试**（create → list 含 sessionIds；update sessionIds 全量替换与"换任务"迁移语义；deleteTask 清归属；临时 NULL 状态）
- [ ] **Step 2: 确认失败**（同 Task 1 命令模式）
- [ ] **Step 3: 实现**（多语句事务：`db.exec("BEGIN")…COMMIT`，测试用 `try/finally` 回滚）
- [ ] **Step 4: 通过 + commit** `feat: 任务存储 CRUD（含会话归属 diff）`

## Task 3: /api/tasks 路由

**Files:**
- Create: `app/api/tasks/route.ts`、`app/api/tasks/[id]/route.ts`
- Test: `app/api/tasks/runtime-route.test.mjs`（模式照抄 `app/api/sessions/runtime-route.test.mjs`）

**Interfaces:**
- Consumes: Task 2 的 4 个函数
- Produces: `GET /api/tasks?projectKey=` / `POST /api/tasks {projectKey,name}` / `PATCH /api/tasks/[id] {name?,sessionIds?}` / `DELETE /api/tasks/[id]`，均为 JSON；错误 `{error}` + 恰当状态码

- [ ] **Step 1: 失败测试**（jiti import 两个 route；POST 建 → GET 列 → PATCH 换成员 → DELETE 后成员清归属）
- [ ] **Step 2/3: 实现 + 通过**（参数校验：projectKey/name 必填字符串；Next.js 16 route 的 `{ params }: { params: Promise<{ id: string }> }` 模式）
- [ ] **Step 4: commit** `feat: /api/tasks CRUD 路由`

## Task 4: 会话全文索引与查询

**Files:**
- Create: `lib/session-search.ts`
- Test: `lib/session-search.test.mjs`

**Interfaces:**
- Produces:
  - `extractSessionText(session: SessionInfo): { title: string; body: string }`（spec §3.4：user text / assistant text+thinking / toolCall input JSON 截断 / toolResult 文本跳过 base64 / bash command+output 截 4KB / compaction summary；累计 cap 256KB）
  - `ensureSearchIndex(): { indexing: boolean }`（listAllSessions 对照 `search_state.mtime`，增量重索引变更/新增，删除消失 session；首次全量）
  - `searchSessions(q: string, limit?: number): SearchResult[]`，`SearchResult = { session: SessionInfo; titleMatch: boolean; snippet: string; entryId?: string }`
  - `fuzzyQueryForTerm(q: string): string`（≥3 → `'"' + q.replace(/"/g,'""') + '"'`；<3 → 供 LIKE）
- 查询实现：≥3 先查 `title MATCH` 后 `body MATCH`（或一次 `title OR body` 查全，再分开判定 titleMatch = title 列命中）；<3 用 `title LIKE '%q%' OR body LIKE '%q%'`。snippet 用 FTS `snippet()` 取首段（预置 `[` `]`）。结果按 `titleMatch DESC, session.modified DESC`，cap limit。

- [ ] **Step 1: 失败测试**（临时目录建小 jsonl 会话 → 索引 → 中文 3 字子串命中 / 2 字 LIKE 命中 / 英文词命中 / 引号转义无害 / titleMatch 判定 / 增量：改 mtime 重索引 / 删除同步）
- [ ] **Step 2/3: 实现**（注意：测试用 `setDbForTesting(:memory:)` + 假 session 列表注入——`ensureSearchIndex(sessionsOverride?)` 留注入参数便于测试不碰真实目录）
- [ ] **Step 4: commit** `feat: 会话 FTS5 trigram 索引与查询`

## Task 5: /api/search 路由

**Files:**
- Create: `app/api/search/route.ts`
- Test: `app/api/search/runtime-route.test.mjs`

**Interfaces:**
- Consumes: Task 4
- Produces: `GET /api/search?q=&limit=` → `{ indexing, results: SearchResult[] }`（session 用完整 `SessionInfo`，`attachSessionProjectInfo` 补齐 projectRoot/key 供前端跳转）

- [ ] **Step 1: 失败测试**（空 q → 空 results + 200；limit clamp 30/50；结果含 session.id/cwd）
- [ ] **Step 2/3: 实现 + 通过**
- [ ] **Step 4: commit** `feat: /api/search 全文检索路由`

## Task 6: SessionTabs + TaskArea 组件

**Files:**
- Create: `components/SessionTabs.tsx`、`components/TaskArea.tsx`

**Interfaces:**
- Produces:
  - `SessionTabs({ active, onChange }: { active: "sessions"|"files"; onChange: (v)=>void })`：分段胶囊，localStorage `pi-sidebar-tab` 读写由父级或组件内完成（组件内即可）
  - `TaskArea({ tasks, sessions, renderSession, onNewTask, onRenameTask, onDeleteTask, onNewSessionFromTask, onDropSessionToTask })`：折叠头 + 任务行（名称、会话数、悬停 +/改名/删除）+ 底部新建任务行；每任务行是 drop target（onDragOver preventDefault + accent 高亮 + 顶部插入线 class）

- [ ] **Step 1: 手动验证布局**（先组件裸挂 dev 页不可行——直接并入 Task 7 联调；本任务只做组件骨架 + 写死 props）
- [ ] **Step 2: 实现**（样式全走 token；`renderSession` 由 SessionSidebar 注入复用 `SessionItem`，TaskArea 只负责分组渲染与落点）
- [ ] **Step 3: commit** `feat: 会话/文件分段 tab 与任务区组件`

## Task 7: SessionSidebar 重构（核心）

**Files:**
- Modify: `components/SessionSidebar.tsx`（大改：Header 区只留路径选择器并后插 SessionTabs；会话视图 = TaskArea + 临时会话区；文件视图 = FileExplorer + 底部 worktree 切换器（自 Header 区迁入，含 `showWorktreeSwitcher`/`inactiveWorktreeSelector`）；顶栏 BranchNavigator 保持原样；SessionItem 加 draggable）

**Interfaces:**
- Consumes: Task 6 组件、Task 2/3 API、现有 `buildSessionTree`/`SessionItem`/`FileExplorer`、`BranchNavigator`（非 inline 形态）
- Produces（新 props）：`branchTree: SessionTreeNode[]`、`branchActiveLeafId: string|null`、`onBranchLeafChange: (id:string|null)=>void`、`onNewSessionFromTask: (taskId:string)=>void`
- 内部逻辑：
  - 任务数据：`fetch("/api/tasks?projectKey="+selectedProject.key)`，随 `refreshKey`/切换项目重取；任务变更后本地更新 + 触 `refreshKey` 等
  - 分组：`tasks.map(t => ({task: t, roots: t.sessionIds.map(id => allSessionById.get(id)).filter(Boolean).map(根 → buildSessionTree 叶子子树)}))`；临时会话 = 未挂任务的项目根会话
  - 拖拽：`SessionItem` 根行 `draggable`，`onDragStart` 写 `text/session-id`；TaskRow `onDrop` 调 `PATCH /api/tasks/[id] {sessionIds: [...]}`；临时区 `onDrop` 置 NULL（走 `taskForSession` 找原任务再 PATCH）
  - 任务区/临时区 max-height（≈40vh/剩余）各自滚动
  - 分支底部：文件视图内 `<BranchNavigator …/>`（现有非 inline 形态，flex 底部常驻）

- [ ] **Step 1: 先改数据层对接**（任务 fetch/缓存/变更刷新）+ 手动 dev 验证任务列表出现
- [ ] **Step 2: tabs 化布局**（SessionTabs 接入，会话/文件视图拆分）
- [ ] **Step 3: TaskArea 接入 + 临时会话区 + 拖拽移入/移出**
- [ ] **Step 4: worktree 切换器迁入文件浏览器底部**（`showWorktreeSwitcher`/`inactiveWorktreeSelector` 从 Header 区移入 FileExplorer 下方；BranchNavigator 留在顶栏）
- [ ] **Step 5: commit** `feat: 侧边栏 tabs 化 + 任务分组拖拽 + 分支底部`

## Task 8: AppShell 集成（搜索插槽、分支迁移、pending 归属、跳转守卫）

**Files:**
- Modify: `components/AppShell.tsx`

**Interfaces:**
- Consumes: Task 9 的 `SidebarGlobalSearch`、Task 7 props、现有 `handleSelectSession`/`handleCwdChange`/`handleSessionCreated`
- 改动点：
  - 顶栏：`renderTodoButton(false)` 与 `renderMainFileToggle(false)` 之间插入 `<SidebarGlobalSearch onSelectSession={handleSearchSelectSession} session={selectedSession} />`
  - 移除：desktop `<BranchNavigator inline …/>`、mobile `hideInlineButton` 实例、mobile toolbar branches 按钮、`activeTopPanel==="branches"` 分支与 `toggleTopPanel("branches")` 调用
  - 数据下传：给 `SessionSidebar` 传 `branchTree/branchActiveLeafId/onBranchLeafChange/onNewSessionFromTask`
  - `pendingNewSessionTaskIdRef`：`onNewSessionFromTask(taskId)` 置 ref → `handleNewSession` 照旧 → `handleSessionCreated` 里若 ref 有值 → `PATCH /api/tasks/[id]` push 真实 id → 清 ref
  - `suppressWorkspaceRestoreRef`：`handleSearchSelectSession(s)` 置 true → `handleSelectSession(s)`；`handleCwdChange` 中 `restoreWorkspaceContext` 调用处改为 `if (suppress) 清 ref else restore`

- [ ] **Step 1: 分支迁移 + 数据下传**（此时 SidebarGlobalSearch 未建，插槽先占位）
- [ ] **Step 2: pending 任务归属 + suppress 守卫**
- [ ] **Step 3: commit** `feat: AppShell 搜索插槽/分支迁移/任务归属/跳转守卫`

## Task 9: 顶栏全局搜索组件

**Files:**
- Create: `components/SidebarGlobalSearch.tsx`

**Interfaces:**
- Consumes: `GET /api/search`
- Produces: `({ onSelectSession, session })`；internal：输入框（桌面 ~200px / 移动端图标 + 全宽 overlay）、350ms debounce + AbortController、结果 popover（portal `<body>`、`.glass-top-panel`、锚定输入框、`<mark>` 高亮 snippet、标题命中置顶）、状态（indexing/empty/noResult）、ESC/外部点击关闭

- [ ] **Step 1: 组件实现**（桌面形态）
- [ ] **Step 2: 移动端形态 + 跳转后收合**
- [ ] **Step 3: commit** `feat: 顶栏全局会话搜索`

## Task 10: i18n + 全量验证

**Files:**
- Modify: `lib/i18n/messages/zh-CN.ts`、`lib/i18n/messages/en.ts`

- [ ] **Step 1: 补全部新文案**（zh/en 同步，参考 spec §7 键名清单 + 实现中新增的键）
- [ ] **Step 2: `node_modules/.bin/tsc --noEmit`** 零错误
- [ ] **Step 3: `npm run lint`** 零错误
- [ ] **Step 4: `npm test`** 全绿（含新增数据层/路由测试）
- [ ] **Step 5: dev 手动验收**（tmux 起 `npm run dev`；按 spec §10 验收清单逐项：建任务/拖入拖出/任务 + 新建/切目录隔离/三态搜索/中文字符 1-2-3 查询/跨目录跳转不被"恢复上次会话"覆盖/分支导航在文件页底部可用；必要时 playwright e2e）
- [ ] **Step 6: commit（含 i18n+可能小修）**
- [ ] **Step 7: 更新 `.agent/NOTES.md`**（搜到的隐含经验：node:sqlite/FTS5 trigram 中文检索结论与 LIKE 兜底），并入最终 commit