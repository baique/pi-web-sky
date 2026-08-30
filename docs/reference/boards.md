# 会话看板（boards / 任务即看板）

> 改看板 / 画布 / 任务即看板 / 便笺 / scrim 前阅读。tldraw 5.x + 自定义 shape 的坑都在这里。

## 数据层铁律

- **迁移**：`lib/sqlite-db.ts` `SCHEMA_VERSION = 5`（v3 建 boards/board_nodes/board_edges/board_view → v4 `sort_order` → v5 `task_id`）。看板是旁路元数据，会话 jsonl 原地不动。
- **事务铁律**：SQLite 不支持嵌套 BEGIN。`deleteBoardCascade` / `renameTaskBoard` **必须无事务**，由调用方（`deleteBoard` / `deleteTask` / `updateTask`）在自身事务内调用。board-store 的 `deleteBoard` 保持"自开事务"行为。
- **任务即看板**：看板 id = 任务 id（`boards.task_id` 非空即任务型看板）。`GET /api/tasks/[id]/board` 懒创建；`deleteTask` 事务内级联删看板；`updateTask` 改名同步 `renameTaskBoard`。
- **系统「运行中」看板**：`SYSTEM_RUNNING_BOARD_ID = "__running__"`，只读、跨项目自动聚合运行中会话，不落 boards 表。

## 空画布保护（防看板被清空）

- `PUT /api/boards/[id]/canvas` **默认拒绝用空 nodes 覆盖已有内容的看板**（返回 `empty-overwrite` → 409）——客户端状态未加载完成时全量保存会把看板清空，这是血泪教训。
- 用户显式「清空画布」才传 `allowEmpty: true` 放行；客户端物化完成前禁止自动保存。
- 乐观锁：客户端必须带读取快照时的 `boards.updated`（`baseUpdated`），期间被他人保存过则拒绝写入。

## 任务即看板自动补卡

- `reconcileTaskSessions`：打开时 diff + 复用 10s 摘要轮询周期 diff，差集（任务会话中无卡片者）→ `addSessionNode`。
- `findFreeSpot(editor)`：收集现有 session-card 矩形，从 (60,60) 按行扫描（y 增 x 增），找与所有卡片**不重叠且间隙 ≥ 24** 的第一个空位——右下方向找空位，天然不遮挡。
- 任务看板**不提供"从看板移除任务会话卡片"**（要移除即移出任务），否则被 diff 补回造成语义冲突。
- `BoardSection` 列表**过滤 `taskId == null`**：任务看板不混入手动看板列表（任务行本身即入口）。

## 卡片即工作台（tldraw）

- tldraw 5.x，`next/dynamic` ssr:false 按需加载（体积 ~1MB，仅进看板时下载）。自定义 shape 用 `BaseBoxShapeUtil`。
- 卡片两态：收合卡（340×160）↔ **展开即工作台**（同一卡片放大，默认 760×600，非弹窗）。展开态工作台 = portal 浮层 + `1/zoom` 反补偿，`zoom < 60%` 降级骨架态。
- **draft 卡**：`sessionId` 为空的卡（新建会话），输入消息绑定真实会话后转正（`bindDraftSession`）。
- 卡片内改名：内联输入 → `PATCH /api/sessions/[id]` → `dispatchBoardSessionRenamed` 事件桥刷左侧树 + 摘要轮询刷新标题。

## tldraw 集成陷阱

- tldraw 全局 `user-select:none` 会禁用画布内文本选中——工作台消息区与便笺 markdown 必须显式恢复选中（根因同源）。
- 便笺是**自研 markdown 便笺**（`StickyNoteShape`），不要用 tldraw 内置 Note（拖拽会出两个控件）。
- 看板卡片内的 `position:fixed` 弹层（如 BranchNavigator 下拉）会被 `backdrop-filter` 容器劫持导致漂移 → portal 到 body；卡片内展开时用 `[data-session-titlebar]` 定位对齐标题栏。
- 便笺 `createdAt` 用 `useState` 惰性初始化，禁止 render 期 `Date.now()`（lint purity）。
- 卡片状态以展开卡内 `useAgentSession` 的 SSE 为准，看板聚合态以 `/api/agent/running` 轮询为准——双源不打架。
- 看板 URL `?board=` 持久化；退出看板 / 点会话 / 新建即回聊天。
