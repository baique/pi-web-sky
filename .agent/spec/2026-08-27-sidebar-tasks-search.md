# pi-web · 侧边栏任务分组与全局会话搜索设计

> 日期：2026-08-27　范围：pi-web-sky　状态：已确认（用户拍板 3 决策 + 审核修正 1 轮）→ 待实施
> 替代：原 `.agent/spec/project-management/`（08-27 项目管理设计，已删除——用户明确"之前的方案删掉"）
> 样式依据：`../2026-08-24-glass-standard.md` / `../2026-08-24-glass-spec.md`

---

## 0. 需求（用户原话收敛）

1. Pi 标题 + 新建 + 刷新：**不动**，保持在最上方。
2. 会话与文件浏览器分离，左右两栏，tab 切换。
3. 会话视图上半部分加**任务区**：可展开/收起；支持新建任务（起名即可）；每个任务内可有多个会话。
4. 区域设定最大高度，超出展示滚动条。
5. 会话分**任务会话**与**临时会话**：新建默认临时；任务行「+」= 新建任务会话；拖拽移入/移出任务。
6. 分支选择归入**文件浏览器底部**。
7. 会话/文件 tab 头放顶部、路径选择器下方，样式新设计。
8. **全局搜索**：搜会话标题 + 具体对话内容，放顶栏（todo 右侧、右侧展开收起按钮[文件面板]左侧）；点击结果切换到目标目录的目标会话。

## 1. 决策（用户已确认）

| # | 决策 | 内容 |
|---|------|------|
| 1 | 搜索框位置 | **主顶栏**，居中段：`… todo 按钮 … 搜索框 … 文件面板展开收起按钮`（desktop/mobile 各自处理，见 §5.1） |
| 2 | 任务范围 | **跟随当前目录/项目**：任务按 `projectKey` 归属，切目录显示该目录的任务（与会话列表一致）。搜索仍全局跨目录 |
| 3 | 分支导航 | **只保留文件页底部**；桌面顶栏 inline 与移动端快捷入口一并移除 |
| 4 | worktree 选择器 | **自顶部移入文件视图**（与分支选择同侧）；顶部只留路径（CWD/项目）选择器 |
| 5 | 项目层取消 | 旧 spec 的"项目 = 纯逻辑实体"层**不实施**；目录选择器保持现状（路径即组织） |
| 6 | 数据层 | `node:sqlite`（DatabaseSync，22.13+ 免 flag，引擎要求 ≥22.19 满足）+ **SQLite 单库** `~/.pi/agent/pi-web.db`：任务表 + 会话归属元数据（session_meta）+ FTS5 全文索引三合一；`.jsonl` 文件原地不动（归属只写旁路元数据） |
| 7 | 中文检索 | FTS5 **trigram** 分词（unicode61 对中文整词切分不可用，实测）；<3 字符短查询用 FTS 表 `LIKE` 兜底；特殊字符查询加引号转义 |
| 8 | 拖拽 | 原生 HTML5 DnD，不引第三方库；会话行可拖，任务行 + 临时会话区为落点 |
| 9 | 任务会话新建 | 任务行「+」→ 走现有新建流程，AppShell 记 `pendingNewSessionTaskIdRef`，会话落盘拿到真实 id 后（`handleSessionCreated`）写入归属 |

## 2. 布局

```
┌─────────────────────────────────┐
│ Pi Web        [新建][刷新]        │ ← 不动
├─────────────────────────────────┤
│ [路径选择器 ▾]                   │ ← 只留 CWD/项目选择（worktree 移入文件视图）
├─────────────────────────────────┤
│   会话       文件                │ ← 新增分段 tab（玻璃 token 新设计）
├─────────────────────────────────┤
│ ── 会话 tab（仅此一侧显示）──    │
│   ▾ 任务 (2)          [+ 新任务] │ ← 可折叠任务区，max-height≈40vh 滚动
│     📁 登录重构                  │   任务行：名称+会话数；悬停[+][改名][删除]
│       💬 设计接口                │   行内 = 拖拽落点
│   ───────────────────────        │
│   临时会话 (3)                   │ ← 落点=移出任务；超高超限滚动
│     💬 修 bug                    │
├─────────────────────────────────┤
│ ── 文件 tab（仅此一侧显示）──    │
│   ▌ worktree 切换器（移入）      │ ← 原顶部 worktree 选择器整体搬入
│   FileExplorer（现状）           │
│   ───────────────────────        │
│   ⑂ 分支选择（底部常驻）         │ ← BranchNavigator 非 inline 形态
└─────────────────────────────────┘

主顶栏（聊天区上方）：
[≡] [bg][theme][lang][trust] [history][改名] [system][terminal][MCP] [sessionStats…] [todo] [+搜索框+] [文件面板‖]
```

## 3. 数据层

### 3.1 Schema（`lib/sqlite-db.ts` 初始化 + 迁移）

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_key);

CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  task_id TEXT,              -- NULL = 临时会话
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_task ON session_meta(task_id);

CREATE TABLE IF NOT EXISTS search_state (
  session_id TEXT PRIMARY KEY,
  mtime TEXT NOT NULL,       -- 已索引版本的 session.modified，用于增量
  title TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
  session_id UNINDEXED, title, body, tokenize='trigram'
);
```

一个 session 只能归属一个任务（`session_meta.task_id` 单值）。

### 3.2 任务 API

| 端点 | 行为 |
|------|------|
| `GET /api/tasks?projectKey=` | `{ tasks: [{ id, name, created, sessionIds[] }] }`，sessionIds 按加入顺序；过滤 projectKey |
| `POST /api/tasks` | `{ projectKey, name }` → 创建，返回 task |
| `PATCH /api/tasks/[id]` | `{ name? , sessionIds? }`（sessionIds 全量替换：diff 后仅更新 `session_meta.task_id`，先从本任务移出的清 NULL、移入的写 task_id；**不得**误改其他任务的成员） |
| `DELETE /api/tasks/[id]` | 删除任务；其成员全部清回临时（`session_meta.task_id = NULL`） |

### 3.3 搜索 API

`GET /api/search?q=&limit=`（limit 默认 30，上限 50）

- 先 `ensureSearchIndex()` 增量：`listAllSessions()`（已有缓存）与 `search_state` 比对 mtime → 变更/新增重索引、消失的删除。纯增量为零时零成本直接查询。
- 查询：`q.trim()` 空 → 空结果。长度 ≥3 → FTS5 `MATCH '"q"'`（引号转义）；<3 → `session_search` 上 `title/body LIKE '%q%'`（trigram 表 LIKE 有索引加速）。标题命中优先，再按 session.modified 降序。
- 响应：`{ indexing: boolean, results: [{ session: SessionInfo, titleMatch: boolean, snippet: string /* 首个命中片段，高亮游标由前端处理 */, entryId?: string }] }`
- 首次全量索引同步阻塞在请求内（数百会话秒级），响应带 `indexing: true`，前端显示"索引中"状态。

### 3.4 文本提取（`lib/session-search.ts`，增量只解析变更文件）

- 标题：`session.name || 首条消息文本`（截 200 字）。
- 正文遍历 `getSessionEntries(path)`：user content 文本块、assistant `text`/`thinking` 块、`toolCall` 的 toolName + JSON input（截断）、`toolResult` 文本块（**跳过 image base64**）、`bashExecution` command + output（截 4KB）、`compaction.summary`、`custom_message` 文本。
- 单 session 累计 cap **256KB**（防爆炸）。
- 大文件全量解析慢但只发生在 mtime 变更时，可接受。

## 4. 侧边栏重构（M1 核心）

### 4.1 SessionSidebar 新结构

```
Header（Pi 标题+新建+刷新）→ CWD 选择器 → [SessionTabs] →
  SessionTab: [TaskArea] + [临时会话区]   （两区各自 max-height + 独立滚动）
  FilesTab:   [worktree 切换器（自顶部移入）] + [FileExplorer] + 底部 [BranchNavigator]
```

- `SessionTabs`：分段胶囊（💬 会话 / 📄 文件），等宽两段，选中 accent 底 + 图标；localStorage 记忆 `pi-sidebar-tab`。
- 会话树构建沿用 `buildSessionTree`（fork 嵌套保留）；任务组显示 = 该任务下**当前项目**的根会话（含其 fork 子树，随根移动）。
- 临时会话区头部显示未挂任务根会话数，可整体折叠（localStorage 记忆）。
- 文件视图无 cwd 时显示空态引导"先选择项目目录"；有 cwd 才渲染 worktree 切换器 + FileExplorer。

### 4.2 任务区（TaskArea）

- 折叠态：一行 `▾ 任务 (N)`；展开态：任务行列表 + 底部「+ 新建任务」行（点击 → 内联输入，Enter 建行；Escape 取消）。
- 任务行：左缩进树形（任务 → 会话），会话用现有 `SessionItem`（复用 hover 按钮/重命名/删除）；会话行增加 `draggable`。
- 任务行悬停按钮：`+`（新建任务会话）、改名（内联）、删除（确认后删任务，成员退回临时）。
- 拖拽：源 = 会话行（`dataTransfer.setData("text/session-id", id)`，原行虚线占位）；落点 = 任务行（挂入，写 task_id）/ 临时会话区（移出，task_id=NULL）。onDragOver `preventDefault` + accent 高亮 + 顶部 2.5px 插入线（沿用旧 spec 交互语言）。
- 任务会话新建：任务行「+」→ `onNewSessionFromTask(taskId)` → AppShell 设 `pendingNewSessionTaskIdRef`，走现有 `handleNewSession`；`handleSessionCreated` 拿到真实 id 后 `PATCH /api/tasks/[id]`（sessionIds push），清 ref。新建 transient 期间先出现在临时区，落盘后进任务（已知可接受）。

### 4.3 SessionSidebar 新 props

```
branchTree: SessionTreeNode[]            // 来自 AppShell（原顶栏 BranchNavigator 数据，不删）
branchActiveLeafId: string | null
onBranchLeafChange: (leafId) => void
onNewSessionFromTask: (taskId: string) => void   // AppShell 处理 pending 归属
```

## 5. 顶栏全局搜索（M2）

### 5.1 位置

- 组件 `SidebarGlobalSearch`，渲染于 AppShell 顶栏 `renderTodoButton(false)` 之后、`renderMainFileToggle(false)` 之前（正是"todo 右侧、文件面板展开收起左侧"）。
- 桌面：`width: ~200px` 内联输入框（glass 输入样式，`--glass-bg-input` token），聚焦高亮。
- 移动端：同插槽渲染为图标按钮，点击展开全宽 overlay 输入（手机无空间放常驻框）；选择跳转后自动收合。

### 5.2 结果面板

- popover 形式，portal 到 `<body>`，`.glass-top-panel`，锚定输入框（照 NOTES.md 毛玻璃坑：必须 portal 锚定）。
- 交互：350ms debounce + AbortController；结果逐会话一行：图标(运行/未读) + 标题 + snippet（命中处高亮 `<mark>` 样式）+ 项目路径 + 相对时间；标题命中行置顶。
- 状态：`indexing: true` → "索引中…"；空查询 → 提示；无结果 → "无匹配会话"。
- ESC / 外部点击关闭；关闭后清空输入。

### 5.3 跨目录跳转（关键坑）

现有 `handleCwdChange` 在项目切换时会调 `restoreWorkspaceContext(newProject)`（恢复该项目上次打开的会话），会**覆盖**搜索选择。实现：

- AppShell 增加 `suppressWorkspaceRestoreRef: boolean`；
- `handleSearchSelectSession(session)`：置 `suppressWorkspaceRestoreRef.current = true` → 调现有 `handleSelectSession(session)`（内含 invalidateWorkspaceRestore + router + sessionKey++）→ 侧边栏 `selectedCwdProp` 同步使 cwd 切换 → `handleCwdChange` 中：`if (suppressWorkspaceRestoreRef.current) { 清 ref; } else { restoreWorkspaceContext(newProject); }`；
- 结果：切到目标目录并选中目标会话、文件 tab 清空、URL 更新，与手动点击行为一致。

## 6. 分支与 worktree 选择器迁移

- **worktree 切换器搬迁**：现状 Header 区的 `showWorktreeSwitcher` 下拉与 `inactiveWorktreeSelector` 整体移入**文件视图顶部**；顶部只保留路径（CWD/项目）选择器。
- **分支导航**：AppShell 移除桌面 `renderChatToolbarActions(false)` 中的 `<BranchNavigator inline .../>` 和移动端 `hideInlineButton` 实例及 mobile toolbar 的 branches 按钮；清理 `activeTopPanel === "branches"` 与 `toggleTopPanel("branches")`。
- `branchTree/branchActiveLeafId/branchLeafChangeFnRef` 数据链路**保留**，改传 SessionSidebar → 文件页底部 `<BranchNavigator tree activeLeafId onLeafChange />`（现有非 inline 形态自带折叠头）。

## 7. i18n

`lib/i18n/messages/zh-CN.ts` + `en.ts` 同步新增：
`sidebar.tasks / sidebar.tempSessions / sidebar.newTask / sidebar.taskName / sidebar.taskSessionsCount / sidebar.sessionTab / sidebar.filesTab / search.placeholder / search.indexing / search.noResults / search.empty / search.titleMatch / search.dropToTask` 等（实现时按需增补）。

## 8. 组件与文件地图

| 文件 | 动作 |
|------|------|
| `lib/sqlite-db.ts` | 新建：DB 打开 + schema 迁移（幂等），单例 |
| `lib/task-store.ts` | 新建：任务 CRUD + 归属 diff 逻辑（纯函数 + DatabaseSync） |
| `app/api/tasks/route.ts` · `app/api/tasks/[id]/route.ts` | 新建 |
| `lib/session-search.ts` | 新建：文本提取 + 增量索引 + 查询 |
| `app/api/search/route.ts` | 新建 |
| `components/SidebarGlobalSearch.tsx` | 新建：顶栏输入 + 结果 popover |
| `components/SessionTabs.tsx` | 新建：分段 tab |
| `components/TaskArea.tsx` | 新建：任务区 |
| `components/SessionSidebar.tsx` | 重构：tabs 化 + 顶部只留路径选择器 + worktree/分支迁入文件页 + 任务区 + 临时区 + SessionItem 拖拽 |
| `components/AppShell.tsx` | 顶栏搜索插槽；移除 BranchNavigator；pending 任务归属；suppress restore 守卫 |
| `lib/i18n/messages/zh-CN.ts` · `en.ts` | 文案 |
| 测试（必要功能测试，dev skill 原则） | `lib/task-store.test.mjs`（事务回滚）、`lib/session-search.test.mjs`（提取/索引/短查询/转义）、`app/api/tasks/runtime-route.test.mjs` |

不新增 runtime 依赖（`node:sqlite` 内置）。

## 9. 里程碑

- **M0 数据层**：sqlite-db + task-store + tasks API + session-search + search API（含测试）
- **M1 侧边栏**：SessionTabs + TaskArea + SessionSidebar 重构 + 拖拽 + worktree/分支迁入文件页
- **M2 搜索 UI**：SidebarGlobalSearch + AppShell 插槽 + 跨目录跳转守卫 + pending 任务归属
- **M3 打磨**：i18n 补全、空态、明暗主题目测、lint + typecheck + 全量验证

## 10. 测试与验收

- `npm test`（数据层单元测试）、`tsc --noEmit`、`npm run lint` 通过；
- 手动/E2E（playwright）：建任务 → 拖入/拖出 → 任务行 + 新建 → 切目录任务隔离 → 三态搜索（标题/正文/无结果）→ 中文 1/2/3 字符查询 → 跨目录点击跳转不触发"恢复上次会话"覆盖 → worktree 切换与分支导航在文件页内可用 → 分支导航在文件页底部可用。