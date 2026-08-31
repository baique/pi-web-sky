# pi-web · 任务卡 + 调度 + 巡检审核

> 日期：2026-08-31　范围：pi-web-sky　状态：待用户 review　前置：`2026-08-30-task-boards.md`（任务即看板）与 `2026-08-29-session-canvas-v2.md`（画布/工作台）

## 0. 需求（用户原话 + 逐轮拍板）

> 看板增加一个任务卡组件，支持用户建立任务卡：*任务名称、*描述(markdown)、*就绪状态(草稿/待办)、*执行状态(未开始/进行中/失败/完成/放弃)、附件(引用文件)、预计截止时间、优先级、前置任务、关联任务。
> 一个定时器从看板拉任务（就绪=待办 & 执行 in 未开始/失败 & 无前置或前置均已完成）发会话执行，同时调整执行状态，支持失败重试（模型失败/节流/429）。
> 一个定时器巡检运行中的任务：最后一条消息阻塞 5 分钟以上 → AI 检测判定是否阻塞（同步开服务/流式日志、死循环、429、其他异常、AI 提问）→ 自主处置（停止阻塞会话+重发 tmux 引导；或推问题等用户回复后自动转回会话）。

用户拍板（2026-08-31，逐轮确认）：
1. **任务卡 = 看板画布组件**（独立实体，像便笺，可建/拖/编辑），与 sidebar「任务」（会话分组）解耦。
2. **任务以看板为界**：前置/关联只能引用**同看板**任务卡；不允许跨看板；每看板任务独立。调度器是**一个**定时任务，按看板维度全局捞。
3. **每卡一专属执行会话**；建卡时选工作区：项目（默认=所在看板所属项目）、cwd（可改）、worktree（可选）。
4. **执行生命周期**：进行中=AI React 循环；react 结束 → **完成待审核**；审核并入检测轮询。程序能判的用程序判（最后一条消息是失败 → 直接失败），否则 AI 独立审核（pi `--no-session` 临时会话读最后几条 AI 消息）→ 完成/失败/提问/其他。失败可计次，支持设置最大重试次数。
5. 前置/关联引用同看板任务卡 id，**画布自动连线**；依赖线动态生成、**禁止用户手动删除**。
6. **展开态向右展开**：左=编辑表单，右=现有会话面板展开态（工作台），竖线分隔。（上下结构为备选，先做左右。）
7. **全局并发上限，默认 1**；只约束调度器派发的任务卡，**用户自己运行的会话随便并发、走常规逻辑**。
8. **派发会话遵循看板逻辑**：任务看板内派发的会话归属该任务；手动看板派发的会话落临时区（聊天）。会话名 = **任务编号 + 标题**（`#N 标题`）。
9. **调度优先级**：回复队列（有回复且有任务空间 → 优先开启）> 新任务 > 重试。**注意：不是回复了就开启会话，而是回复入队、调度了才续会话**（统一走并发闸门）。
10. 任务编号**项目内自增**。
11. 飞书回路**留到下阶段**，先做应用内待回答队列闭环；飞书留扩展点。

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 业务字段进新表 `task_cards`，画布布局走 `board_nodes`（`kind="taskcard"`，`refId=cardId`，与会话卡同构） | 任务卡有大量业务状态（执行状态/依赖/会话绑定/重试计数）被调度器读写，塞 shape props 里调度器无法可靠读取 |
| 2 | 依赖关系存业务表 `task_card_links`（**真相源**），画布连线由它派生进 `board_edges`（props 标记 `auto:1`），加载/变更时 reconcile 补回 | 调度器读依赖不依赖画布状态；自动补回 = 等效禁删 |
| 3 | 执行状态机：`not_started → running → review → done/failed/waiting_reply`；`failed(retry<max) → not_started`；`waiting_reply →(用户回复+调度)→ running`；`abandoned` 人工 | 完成判定不纠结：程序判得了的用程序，判不了的交 AI 审核 |
| 4 | 审核/阻塞判定用 `SessionManager.inMemory()`（`--no-session` 等价）临时会话，**不落盘、不污染执行会话文件** | SDK 已支持（`--no-session` = `SessionManager.inMemory`，已验证）；执行会话上下文干净，重试不带审核噪音 |
| 5 | 调度/巡检两个定时器 in-process（`instrumentation.ts` 注册，挂 `globalThis.__piTaskScheduler` 防热重载重复启动） | 与 `__piSessions` 同模式；单进程 dev server，无需外部 cron |
| 6 | 全局并发闸门只数**调度器派发的 running 任务卡**；用户手动会话不计数、不受限 | 后台自动化克制，人工操作自由 |
| 7 | 派发会话命名 `#N 标题`（`PATCH /api/sessions/[id]` 设置显示名）；任务看板内 `assignSessionToTask` 归属任务，否则落临时区 | 侧栏归属与「任务即看板」既有逻辑一致 |
| 8 | 回复续会话走统一调度闸门（不立即发） | 与「调度优先级」一致，避免绕过并发控制 |

## 2. 数据层（迁移 v6）

```sql
CREATE TABLE IF NOT EXISTS task_cards (
  id            TEXT PRIMARY KEY,
  board_id      TEXT NOT NULL,           -- 所属看板（任务以看板为界）
  project_key   TEXT NOT NULL,           -- 看板所属项目（cwd 默认来源）
  number        INTEGER NOT NULL,        -- 项目内自增编号 #N
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',-- markdown
  ready_status  TEXT NOT NULL DEFAULT 'draft',        -- draft|todo
  exec_status   TEXT NOT NULL DEFAULT 'not_started',  -- not_started|running|review|done|failed|abandoned|waiting_reply
  priority      INTEGER NOT NULL DEFAULT 0,           -- 高1/中0/低-1（或 -1..1）
  due           INTEGER,                 -- ms epoch；NULL=无
  attachments   TEXT NOT NULL DEFAULT '[]',           -- 引用文件路径数组 JSON
  cwd           TEXT,                    -- 执行工作目录；NULL=项目根
  use_worktree  INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 3,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,                    -- 专属执行会话 id
  created       INTEGER NOT NULL,
  updated       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_cards_board   ON task_cards(board_id);
CREATE INDEX IF NOT EXISTS idx_task_cards_project ON task_cards(project_key);
CREATE INDEX IF NOT EXISTS idx_task_cards_status  ON task_cards(ready_status, exec_status);

CREATE TABLE IF NOT EXISTS task_card_links (
  id             TEXT PRIMARY KEY,
  card_id        TEXT NOT NULL,          -- 依赖方
  target_card_id TEXT NOT NULL,          -- 被依赖方（同看板）
  kind           TEXT NOT NULL,          -- prerequisite|related
  created        INTEGER NOT NULL,
  UNIQUE(card_id, target_card_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_task_links_card ON task_card_links(card_id);

CREATE TABLE IF NOT EXISTS task_card_questions (
  id         TEXT PRIMARY KEY,
  card_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,              -- 执行会话
  question   TEXT NOT NULL,              -- 问题文本（含 AI 最后几条消息摘要）
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending|answered
  answer     TEXT,                       -- 用户回复
  created    INTEGER NOT NULL,
  answered   INTEGER                     -- answered 时间
);
CREATE INDEX IF NOT EXISTS idx_task_questions_status ON task_card_questions(status);
```

- `SCHEMA_VERSION 5 → 6`，MIGRATIONS 追加 v6（三张新表）。
- `lib/task-card-store.ts`（SDK-free，对照 task-store）：建卡（`number = MAX(number)+1` WHERE project_key 自增）、CRUD、依赖 CRUD（同看板校验）、问答 CRUD、状态流转、`listDispatchableCards` / `countRunningDispatched`。
- 删卡：级联删 `task_card_links`/`task_card_questions`；执行会话保留（jsonl 不动，卡删了会话仍在侧栏），或按需解绑。

## 3. 看板组件（S1）

- `lib/board-types.ts`：`BoardNodeKind` 加 `"taskcard"`。
- `components/canvas/TaskCardShape.tsx`：`BaseBoxShapeUtil`（照 `StickyNoteShape`/`SessionCardShape`），shape type `"task-card"`。
  - **收合态**（默认 ~220×120）：`#N 名称` + 就绪/执行状态徽章（配色区分 running 呼吸 / review 黄 / waiting_reply 蓝）+ 优先级/截止小字。
  - **展开态**（向右展开 ~900×600）：**左=编辑表单，右=现有会话工作台（`SessionWorkbench` 复用，绑定执行会话），中间竖线分隔**。表单：名称、描述(md 编辑)、就绪、执行状态（显示+人工可改）、优先级、截止、附件(引用文件选择器，复用文件浏览能力)、前置/关联(同看板卡多选)、工作区(项目/cwd/worktree)、重试上限。工作台空态：未派发时显示「等待调度 / 手动运行」按钮。
  - 交互遵守 [board-events.md](board-events.md)（焦点、原生 wheel 拦截、右键放行、无依赖 effect）。
- 建卡：工具栏按钮（`TaskCardTool extends BaseBoxShapeTool`，照 `StickyNoteTool`）→ 点画布弹出建卡向导（必填名称/描述 + 工作区选择 + 前置/关联）→ 落库 + 建 node。
- **依赖连线**：卡保存时 `syncCardEdges`——按 `task_card_links` 生成/更新 `board_edges`（from=本卡 node，to=目标卡 node，`props:{auto:1, kind}`），画布加载与卡变更时 reconcile 补回（缺失重插）；`auto:1` 的边前端禁用删除（右键菜单无删除项 / 删除即补回）。
- 状态变更事件：卡执行状态变化通过 `board-events.ts` 事件桥广播（`dispatchBoard…` 模式）刷新看板聚合态 + 侧栏。

## 4. API

```
GET/POST   /api/task-cards                      ?boardId 列表/建卡（含依赖）
GET/PATCH/DELETE /api/task-cards/[id]           详情/改字段(含依赖同步边)/删(级联)
POST       /api/task-cards/[id]/run             手动触发调度（立即排入调度器队列，走并发闸门）
POST       /api/task-cards/[id]/abort           停止执行会话（转 review→程序判失败或人工）
GET        /api/task-card-questions             pending/answered 列表
POST       /api/task-card-questions/[id]/answer 用户回答（status→answered，answer 落库）
GET        /api/task-cards/[id]/context         （供审核用）执行会话最后几条 AI 消息
```

- 建卡 POST body：`{ boardId, name, description, readyStatus, priority, due, attachments, cwd, useWorktree, prerequisites:[], related:[] }`；服务端补 `project_key`（=board 的 project_key）与 `number`。
- 手动运行：入调度队列而非直接开跑（保证并发闸门与优先级一致）。

## 5. 调度定时器（S2）

- 启动：`lib/task-scheduler.ts` 在 `instrumentation.ts` register 里 `startTaskScheduler()`，挂 `globalThis.__piTaskScheduler` 防重。调度周期 ~10s；巡检周期 ~30s（两个 setInterval 同模块）。
- **并发闸门**：`countRunningDispatched()`（running 的任务卡数）≥ 全局上限（默认 1，可配置）→ 本轮不派发新卡。
- **每轮派发优先级**：
  1. **回复队列**：`task_card_questions` 取 `status=answered` 未续的（按 answered 时间序）→ 续会话：把 `answer` 发执行会话（若会话是 `waiting_input` 挂起 → `extension_ui_response`；否则 `prompt` 发回复）→ `exec= running`。
  2. **新任务**：`ready=todo & exec=not_started & 无前置或前置均 done`（前置 = `task_card_links kind=prerequisite` 且其卡 `exec_status=done`）。
  3. **重试**：`exec=failed & retry_count<max_retries`（reset retry 时机见 §7）。
- **派发流程**（新任务/重试）：
  1. 定 cwd：`use_worktree` → 复用/创建 worktree（`lib/worktree.ts`）取路径；否则 `cwd || 项目根`。
  2. `startRpcSession` 建执行会话（`session_id` 空时；已存在复用），`toolNames` 默认 FULL 预设。
  3. 会话命名 `#N 标题`（`PATCH /api/sessions/[id]` 显示名）。
  4. 看板是任务看板（`boards.task_id` 非空）→ `assignSessionToTask(session_id, task_id)`；否则不挂（临时区）。
  5. `send({type:"prompt", message: 任务描述 + 附件引用})`。
  6. `exec= running`，`updated` 刷新；board node 绑定 `session_id`。
- **失败重试口径**：模型失败 / 节流 / 429 表现为 prompt 被拒或会话运行异常 → 由审核程序检测或调度层捕获 → `failed` 计次。调度层发送时被拒（429 等）不立刻涨 retry，先让审核判定；调度层可在下一轮自然重试（退避在下一周期）。

## 6. 巡检 + 审核 + 待回答队列（S3）

### 6.1 阻塞检测（运行中）
- 遍历 running 的任务卡执行会话；**最后一条消息/事件时间 > 5min 无进展** → 触发 AI 判定。
- `SessionManager.inMemory()` 临时审核会话：喂「任务描述 + 运行 phase + 最后几条 AI 消息」→ 结构化判定阻塞类型：`sync_server`（同步开服务/流式日志）/ `infinite_loop` / `rate_limit`(429) / `error` / `asking`（AI 提问）/ `normal`。
- **处置**：
  - `sync_server` / `infinite_loop` → `abort` 会话 + `prompt` 重发引导「应使用 tmux 后台启动服务」→ 保持 `running` 观察。
  - `rate_limit` → 不 abort，记一次，下一轮退避再观察（不误杀）。
  - `asking` → `exec= waiting_reply`，入 `task_card_questions`（pending）。
  - `error` → 转 §6.2 审核路径（程序判失败）。
  - `normal` → 继续观察（可能长任务）。
- 每卡阻塞判定**有冷却**（如 10min 内不重复判同一卡），避免反复 abort。

### 6.2 审核（review 卡）
- 遍历 `exec=review` 的卡：
  1. **程序检测**：读执行会话最后一条 assistant/toolResult——若为失败（tool 错误、exit≠0、模型错误/429 文本）→ 直接 `failed`（`retry_count+1`）。
  2. 否则 `SessionManager.inMemory()` 临时会话审核：喂「任务描述 + 最后几条 AI 消息」→ 判定 `done / failed / waiting_reply / other`。
  3. 按判定：`done` → `done`；`failed` → `retry_count+1`，`< max_retries` 则回 `not_started`（等下轮调度重试），否则保持 `failed`；`waiting_reply` → `waiting_reply` + 入问答队列；`other` → 保持 `review` 记日志。
- **回复续会话**：`POST answer` 后 status=answered；调度器回复队列拾取 → 发回复给执行会话 → `running`。（回复前若会话已 `waiting_input` 挂起 → `extension_ui_response` 应答；否则 `prompt`。）

### 6.3 待回答队列 UI
- 侧栏底/看板角标：pending 数徽章（轮询刷新）。
- 面板：列表（`#N 标题` + 问题文本），每项输入框作答 → `POST answer`。
- 任务卡展开态：`waiting_reply` 状态卡直接内联答题（同样走 answer API）。

## 7. 组件 / 文件改动清单

```
lib/sqlite-db.ts                    Modify：SCHEMA_VERSION 5→6 + v6 迁移（三表）
lib/task-card-store.ts              Create：task_cards/links/questions CRUD + 派发查询 + 编号自增 + 级联删
lib/board-types.ts                  Modify：BoardNodeKind + "taskcard"
lib/board-store.ts                  Modify：syncCardEdges / 查询 taskcard node
lib/task-scheduler.ts               Create：调度+巡检两个 setInterval + 并发闸门 + 派发/阻塞/审核逻辑
lib/task-card-questions.ts          Create：问答 CRUD（或并入 task-card-store）
lib/audit-session.ts                Create：SessionManager.inMemory 临时会话判定封装（阻塞判定/审核）
instrumentation.ts                  Modify：startTaskScheduler()（globalThis 防重）
app/api/task-cards/route.ts         Create：GET/POST
app/api/task-cards/[id]/route.ts    Create：GET/PATCH/DELETE
app/api/task-cards/[id]/run/route.ts  Create：POST 手动调度
app/api/task-cards/[id]/abort/route.ts Create：POST
app/api/task-cards/[id]/context/route.ts Create：GET 审核用最后几条消息
app/api/task-card-questions/route.ts  Create：GET
app/api/task-card-questions/[id]/answer/route.ts Create：POST
components/canvas/TaskCardShape.tsx Create：收合/展开（左表单|右工作台）+ 状态徽章
components/canvas/TaskCardTool.ts   Create：建卡工具
components/canvas/SessionCanvas.tsx Modify：注册 task-card shape + 工具栏按钮
components/canvas/SessionWorkbench.tsx Modify：可被任务卡复用（sessionId 来源泛化）
components/canvas/BoardSection.tsx  Modify：角标 pending 数（可选）
components/QuestionCenter.tsx       Create：待回答队列面板（侧栏入口 + 看板角标）
hooks/useTaskCards.ts               Create：卡数据 + 状态订阅 + 回答 action
docs/reference/task-cards.md        Create：任务卡主题参考（本 spec 拆条）
```

## 8. 测试与验收

- **数据层（.mjs，事务 + try/finally 回滚，不保留数据）**：建卡编号项目内自增；依赖同看板校验（跨看板拒绝）；状态流转（not_started→running→review→done/failed）；`listDispatchableCards` 前置过滤；并发计数。
- **调度逻辑（纯函数单测）**：优先级（回复>新任务>重试）；并发闸门满则不派发；重试上限。
- **API（.mjs）**：task-cards CRUD + 依赖同步边；questions answer 状态翻转。
- **前端 e2e**（playwright + chrome-devtools 真浏览器）：建卡向导 → 展开态左右布局 → 编辑字段 → 前置/关联连线自动生成、手动删不生效 → 手动 run → 执行会话工作台可见 → waiting_reply 内联作答续会话。
- `npm test` / `node_modules/.bin/tsc --noEmit` / `npm run lint` 全绿。

## 9. 实施顺序

- **阶段一（S1）**：数据模型 + task-card-store + API + TaskCardShape（建/编辑/依赖线）。交付：可建卡、可编辑、可连线。
- **阶段二（S2）**：调度定时器 + 并发闸门 + 派发/状态流转/重试。交付：待办卡自动执行、状态自动流转。
- **阶段三（S3）**：巡检/阻塞判定 + 审核 + 待回答队列面板。交付：阻塞自动处置、完成待审核闭环、提问可答。
- 每阶段可独立验收、滚动提交；一个总 spec，阶段内再拆 plan。

## 10. 不做（YAGNI）

- 飞书问答回路（下阶段；`task_card_questions` 预留 status/扩展点，不写飞书相关代码）。
- 阻塞处置的复杂策略（先基线：abort+tmux 引导 / 429 退避 / 提问入队）。
- 任务卡泳道/看板内卡片排序、批量操作、统计报表、截止时间超期告警。
- 任务卡执行会话的生命周期回收（不做自动清理，交给现有会话清理机制）。
