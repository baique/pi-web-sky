# 任务卡 S1（数据模型 + 看板组件）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 本 session inline 执行（executing-plans 风格，app 上下文庞大不派子代理）。Steps 用 checkbox 跟踪。
> Spec: `.agent/spec/2026-08-31-task-card-scheduler.md`

**Goal:** 看板可建/可编辑任务卡（TaskCardShape），字段齐全，前置/关联在画布自动连线（禁删），为 S2 调度提供完整数据层。

**Architecture:** 业务字段进新表 `task_cards`（SDK-free，对照 task-store），画布布局走 `board_nodes`（`kind="taskcard"`, `refId=cardId`）；依赖关系 `task_card_links` 为真相源，连线由 `syncCardEdges` 派生进 `board_edges`（`label=kind` 识别）。前端新 shape + 建卡工具，展开态左表单右工作台。

**Tech Stack:** node:sqlite（内置）、Next.js 16 route handlers、React 19、tldraw 5.x 自定义 shape、markdown（remark 栈已有）。

## Global Constraints

- 引擎 node ≥22.19；数据层 SDK-free（`getAgentDir` 本地实现，参照 task-store/board-store，纯 node 测试用 jiti 或 `--experimental-strip-types`）。
- 事务铁律：SQLite 不支持嵌套 BEGIN；跨 store 的级联调用（`deleteCard` 删 node/边）保持无事务，由调用方包事务，参照 `task-store.deleteTask` 调 `deleteBoardCascade` 先例。
- `.jsonl` 会话文件原地不动；任务卡只写旁路元数据。
- 依赖线识别：`label ∈ {prerequisite, related}` 且两端为 `kind=taskcard` node；BoardEdge 无 props 字段，不依赖 props。
- 样式引用现有 token（`--side-*`/`--accent`/`--border`）；tldraw 交互遵守 `docs/reference/board-events.md`（焦点/原生 wheel 拦截/右键放行/无依赖 effect）。
- 不新增 runtime 依赖。测试遵循 dev skill：必要功能测试、`try/finally` + 事务回滚、不保留测试数据。
- 提交纪律：每任务独立 commit。

---

## Task 1: 数据层 v6 迁移 + task-card-store 骨架

**Files:**
- Modify: `lib/sqlite-db.ts`（SCHEMA_VERSION 5→6 + MIGRATIONS 追加 v6 三表）
- Create: `lib/task-card-store.ts`
- Test: `lib/task-card-store.test.mjs`

**Interfaces:**
- Produces:
  - `export type ReadyStatus = "draft" | "todo"`
  - `export type ExecStatus = "not_started" | "running" | "review" | "done" | "failed" | "abandoned" | "waiting_reply"`
  - `export type LinkKind = "prerequisite" | "related"`
  - `export interface TaskCard { id; boardId; projectKey; number; name; description; readyStatus; execStatus; priority; due: number|null; attachments: string[]; cwd: string|null; useWorktree: boolean; maxRetries; retryCount; sessionId: string|null; created; updated }`
  - `export interface TaskCardLink { id; cardId; targetCardId; kind; created }`
  - `getCard(id): TaskCard | undefined`
  - `listCards(boardId): TaskCard[]`（按 number 升序）
  - `createCard(input: { boardId; projectKey; name; description?; readyStatus?; priority?; due?; attachments?; cwd?; useWorktree?; maxRetries? }): TaskCard`（`number = MAX(number)+1` WHERE project_key，自增）
  - `updateCard(id, patch: { name?; description?; readyStatus?; execStatus?; priority?; due?; attachments?; cwd?; useWorktree?; maxRetries?; sessionId?; retryCount? }): TaskCard | null`
  - `deleteCard(id): void`（事务内级联删 links/questions + 该卡 taskcard node + 其依赖 auto 边）

- [ ] **Step 1: 写失败测试**（内存库建 schema）：`createCard` 编号项目内自增（同项目 1,2,3；异项目重新 1）；`listCards` 按编号序；`updateCard` 改字段；`getCard` 不存在 undefined；`deleteCard` 后 links/questions 消失且同板 node（kind=taskcard, refId=cardId）消失。
- [ ] **Step 2: 运行确认失败**（`node --experimental-strip-types --test lib/task-card-store.test.mjs`）。
- [ ] **Step 3: 实现**：sqlite-db.ts v6 迁移（三表 DDL 见 spec §2）；task-card-store.ts 按接口实现（SDK-free，`getDb()` 引用；deleteCard 事务内调用 board-store 的 node/edge 查询与删除——参照 task-store 先例；sqlite-db 的 v6 DDL 同时建 `task_card_questions` 表，其 store 函数留 S3）。
- [ ] **Step 4: 测试通过 + commit** `feat(task-cards): v6 迁移 + task_card_store 建卡/查询/更新/级联删`

## Task 2: 依赖 CRUD + 派发查询 + 并发计数（数据层完整）

**Files:**
- Modify: `lib/task-card-store.ts`
- Test: `lib/task-card-store.test.mjs`

**Interfaces:**
- Produces:
  - `listLinks(cardId): TaskCardLink[]`
  - `addLink(cardId, targetCardId, kind): TaskCardLink | null`（同看板校验：两卡 `board_id` 必须相同，否则 null；自环 null；重复 UNIQUE 幂等更新）
  - `removeLink(id): void`
  - `replaceLinks(cardId, prerequisites: string[], related: string[]): void`（全量替换，事务内删旧插新，供 PATCH 用）
  - `listDispatchableCards(): TaskCard[]`（`ready=todo & exec in (not_started, failed 且 retry_count<max_retries)` 且**前置均 done**：无 `prerequisite` link，或所有 target 卡 `exec_status=done`）
  - `countRunningDispatched(): number`（`exec_status=running` 的卡数，调度闸门用）

- [ ] **Step 1: 写失败测试**：`addLink` 跨看板拒绝 / 自环拒绝；`replaceLinks` 全量替换生效；`listDispatchableCards` 前置过滤（有未 done 前置的卡不返回）、`failed&retry<max` 返回、`failed&retry≥max` 不返回、`draft` 不返回；`countRunningDispatched` 只数 running。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：按接口；同看板校验用 `getCard` 对比 board_id；`listDispatchableCards` 用两段查询（先取候选卡，再逐卡查 prerequisite 目标状态），不用复杂 JOIN（数据量小、可读性优先）。
- [ ] **Step 4: 测试通过 + commit** `feat(task-cards): 依赖 CRUD + 派发查询 + 并发计数`

## Task 3: board 集成（BoardNodeKind + syncCardEdges）

**Files:**
- Modify: `lib/board-types.ts`（`BoardNodeKind` 加 `"taskcard"`）
- Modify: `lib/board-store.ts`（新增 `getNodeByRefId`、`syncCardEdges`）
- Test: `lib/board-store.test.mjs`

**Interfaces:**
- Produces:
  - `getNodeByRefId(boardId, refId, kind?): BoardNode | undefined`（`SELECT ... WHERE board_id=? AND ref_id=? [AND kind=?]`）
  - `syncCardEdges(cardId): void`——按 `task_card_links` 全量 reconcile 某卡的依赖边：
    1. 取 card（`getCard`）→ boardId；取本卡 node（`getNodeByRefId(boardId, cardId, "taskcard")`），无 node 则直接返回。
    2. 现有自动边集合 = `board_edges WHERE board_id=?` 中 `label ∈ {prerequisite, related}` 且 from=本卡 node id 的边。
    3. 期望边 = 对每条 link（target 卡经 `getNodeByRefId(boardId, targetCardId, "taskcard")`，target 无 node 则跳过）：`{ fromId: 本卡node, toId: targetNode, label: kind }`。
    4. diff：期望有而画布无 → `addEdge`；画布有而期望无 → `deleteEdge`。
    5. 本函数**不包事务**（内部多次写），由调用方包事务（参照 deleteCard/updateCard 先例）。

- [ ] **Step 1: 写失败测试**（内存库，建 2 卡 2 node + 1 link）：`syncCardEdges` 生成 label=prerequisite 的边；`replaceLinks` 改 target 后 `syncCardEdges` 删旧边加新边；手动删自动边后再次 `syncCardEdges` 补回；target 无 node 时跳过不崩。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：`getNodeByRefId`；`syncCardEdges` 按上述 diff（自动边识别 = 两端含本卡 node 的 `label∈{prerequisite,related}` 边，**只 reconcile 出边**——from=本卡，避免双向 reconcile 打架）。
- [ ] **Step 4: 测试通过 + commit** `feat(task-cards): board 集成 — taskcard node 查询 + 依赖边 reconcile`

## Task 4: task-cards API

**Files:**
- Create: `app/api/task-cards/route.ts`（GET `?boardId=` 列表；POST 建卡）
- Create: `app/api/task-cards/[id]/route.ts`（GET / PATCH / DELETE）
- Test: `app/api/task-cards/route.test.mjs`（node 直连 handler 或 fetch 注入，参照现有 API 测试方式）

**Interfaces:**
- Produces（前端/S2 消费）：
  - `GET /api/task-cards?boardId=xxx` → `{ cards: TaskCard[] }`（每卡带 `nodeId` 字段：`getNodeByRefId(boardId, id, "taskcard")?.id`）
  - `POST /api/task-cards` body `{ boardId; name; description?; readyStatus?; priority?; due?; attachments?; cwd?; useWorktree?; maxRetries?; prerequisites?; related?; x?; y? }` → 201 `{ card, nodeId }`。服务端：board 存在校验 → projectKey=board.projectKey → `createCard` → `addNode(boardId, { kind:"taskcard", refId:card.id, x: x??60, y: y??60, w:220, h:120 })` → `replaceLinks` → `syncCardEdges`（事务外顺序执行）。
  - `GET /api/task-cards/[id]` → `{ card, nodeId, links }`（links 含两向：本卡作 card_id 的依赖 + 其他卡引用本卡的被依赖，前端画被依赖线也需此信息）。
  - `PATCH /api/task-cards/[id]` body 同 POST 字段子集 + `prerequisites`/`related` → 200 `{ card }`。依赖变更 → `replaceLinks` + `syncCardEdges`。
  - `DELETE /api/task-cards/[id]` → 204。`deleteCard`（含 node/边清理）。
  - 校验：name 必填非空；`readyStatus`/`execStatus`/`priority`/`due` 类型校验；非法枚举 400。

- [ ] **Step 1: 写失败测试**：POST 建卡返回 card+nodeId、node 落库（kind=taskcard, refId）；编号自增；PATCH 改依赖后 GET links 生效、board_edges 有对应边；DELETE 后 card/links/node/auto 边全消失；name 空 400。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**：两个 route + 校验 + 集成逻辑。
- [ ] **Step 4: 测试通过 + commit** `feat(task-cards): CRUD API（建卡带 node、依赖替换、级联删）`

## Task 5: TaskCardShape 收合态 + 建卡工具 + 画布注册

**Files:**
- Create: `components/canvas/TaskCardShape.tsx`（收合态 + 后续展开态容器）
- Create: `components/canvas/TaskCardTool.ts`（`BaseBoxShapeTool`，shapeType `"task-card"`）
- Modify: `components/canvas/SessionCanvas.tsx`（注册 shape util + tool + 工具栏按钮 + `canvas-shapes` 白名单）

**Interfaces:**
- Produces:
  - `TaskCardShapeUtil extends BaseBoxShapeUtil<TaskCardShape>`；`shapeType = "task-card"`；props：`{ cardId: string; name: string; readyStatus: ReadyStatus; execStatus: ExecStatus; priority: number; due: number|null; expanded: boolean }`
  - 收合态默认 `220×120`：`#N 名称` + 就绪/执行状态徽章（running 呼吸 / review 黄 / waiting_reply 蓝 / 其余灰绿） + priority 星标 + due 小字。
  - 前端在 `SessionCanvas` 工具栏加「任务卡」按钮（参照便笺 note 按钮），点击 `setCurrentTool("task-card")`；工具在画布落点创建 shape（`getDefaultProps` 空卡）后由 Task 6 建卡向导接管。
  - `canScroll()=true`；交互遵守 board-events。

- [ ] **Step 1: 实现 shape + tool + 注册**（此任务前端无法纯单测，进 e2e 验证）。
- [ ] **Step 2: e2e**（playwright + chrome-devtools）：进入手动看板 → 工具栏出现「任务卡」→ 点画布创建空卡 shape → 收合态渲染正常（无 cardId 时显示占位「新建任务」）。
- [ ] **Step 3: commit** `feat(task-cards): 画布注册 TaskCardShape 收合态 + 建卡工具`

## Task 6: 建卡向导 + 展开态（左表单 | 右工作台）+ 编辑保存

**Files:**
- Modify: `components/canvas/TaskCardShape.tsx`（展开态 + 建卡向导 + 表单 + 保存）
- Modify: `components/canvas/SessionWorkbench.tsx`（sessionId 来源泛化：从 prop 传入，任务卡展开复用；不依赖既有「当前会话」上下文）
- Create: `hooks/useTaskCards.ts`（`useCard(cardId)`：GET /api/task-cards/[id] + 状态；`saveCard`/`createCard`/`deleteCard` action）

**Interfaces:**
- Produces:
  - 建卡向导：新建空卡 shape 双击/点击进入向导 → 必填名称+描述、选工作区（项目=看板所属项目只读显示、cwd 可改、useWorktree 勾选）、前置/关联多选（同看板卡，从 `GET /api/task-cards?boardId=` 拿候选）→ `POST /api/task-cards` → shape props 写入 cardId/name/状态 + `editor.updateShapes`。
  - 展开态：向右展开 `~900×600`，左表单/右工作台竖线分隔（`borderLeft` 用现有 token）。表单字段=spec §3 全量；执行状态显示+人工可改（下拉）。右工作台=`SessionWorkbench` 复用（绑定执行会话；未派发空态显示「等待调度 / 手动运行」——运行按钮 S2 接）。
  - 保存：表单变更 `PATCH /api/task-cards/[id]` → 成功回写 shape props 展示字段。

- [ ] **Step 1: 实现 useTaskCards + SessionWorkbench 泛化 + 展开态表单**。
- [ ] **Step 2: e2e**：建卡向导全流程（名称/描述/工作区/前置关联）→ 卡落库且收合态正确 → 展开态左右布局、竖线分隔 → 编辑字段保存 → PATCH 生效 → 刷新看板数据恢复。
- [ ] **Step 3: commit** `feat(task-cards): 建卡向导 + 展开态（左表单右工作台）+ 编辑保存`

## Task 7: 依赖连线前端 + 禁删 + 状态事件桥

**Files:**
- Modify: `components/canvas/TaskCardShape.tsx`（依赖选择 UI + 被依赖提示 + 手动运行/状态操作占位）
- Modify: `components/canvas/SessionCanvas.tsx`（`onMount` 后对 taskcard 卡执行 `syncCardEdges` 兜底 reconcile——直接调 API 或复用保存链路）
- Modify: `lib/board-events.ts`（新增 `dispatchTaskCardChanged(cardId)` 事件桥）
- Modify: `components/canvas/SyncedContextMenu.tsx` 或边选中处理（依赖线禁删：`label∈{prerequisite,related}` 的边右键菜单无删除项）

**Interfaces:**
- Produces:
  - 依赖线渲染：展开态「前置任务/关联任务」多选（同看板卡），保存后画布自动出现连线（Task 3 `syncCardEdges` 已在服务端生成，前端加载 canvas 即见）。
  - 禁删：选中/右键依赖线（`label∈{prerequisite,related}`）无「删除」操作；即使手动删，重进画布或下次卡变更 reconcile 补回。
  - `dispatchTaskCardChanged(cardId)`：卡状态/字段变化广播（S2 调度状态回写时刷新看板聚合态）。

- [ ] **Step 1: 实现依赖选择 UI + 事件桥 + 禁删处理**。
- [ ] **Step 2: e2e**：建两卡 → 设前置 → 画布自动连线（label 可见）→ 右键依赖线无删除项 → 删前置关系保存 → 线消失 → 重设恢复 → 手动删线（若有通道）重进画布补回。
- [ ] **Step 3: commit** `feat(task-cards): 依赖连线前端 + 禁删 + 状态事件桥`

## Task 8: 参考文档 docs/reference/task-cards.md（S1 部分）

**Files:**
- Create: `docs/reference/task-cards.md`（S1 部分；AGENTS.md 参考索引加一行，主题触发词「改任务卡/任务卡数据模型/依赖线」）

**Interfaces:**
- Consumes: Task 1-4 的数据模型/API 事实。

- [ ] **Step 1: 写文档**：task_cards / task_card_links 表结构、执行状态机枚举、编号自增规则、依赖线 label=kind 识别与禁删机制、`syncCardEdges` 语义、API 一览；标注 S2/S3 部分待实现后补。
- [ ] **Step 2: 自检**：AGENTS.md「参考索引」表加一行 `任务卡 | docs/reference/task-cards.md | 改任务卡/依赖线/任务卡 API`。
- [ ] **Step 3: commit** `docs(task-cards): 参考文档 task-cards.md（S1 部分）+ 参考索引`

---

## S1 验收清单

- [ ] 手动看板可建任务卡（向导填名称/描述/工作区/依赖）→ 收合态正确
- [ ] 展开态左右布局（左表单|右工作台，竖线分隔），编辑保存生效、刷新恢复
- [ ] 前置/关联引用同看板卡，画布自动连线，依赖线不可删（删了补回）
- [ ] 任务编号项目内自增；`listDispatchableCards`/`countRunningDispatched` 数据正确
- [ ] `npm test` / `node_modules/.bin/tsc --noEmit` / `npm run lint` 全绿
