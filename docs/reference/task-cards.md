# 任务卡（task-cards）

> 改任务卡 / 任务卡数据模型 / 依赖线 / 执行会话线 / 任务卡表单前阅读。当前架构 spec 见 `.agent/spec/2026-09-01-task-card-atomic-link.md`（原子-链接 + exec 线）；历史 spec `.agent/spec/2026-08-31-task-card-scheduler.md` / plan `.agent/plan/2026-08-31-task-cards-s1.md` 已标注废弃部分，冲突处以当前 spec 为准。

## 概念

任务卡 = 看板上的工作项卡（独立实体，与 sidebar「任务/会话分组」解耦）。业务字段在 `task_cards` 表，画布布局走 `board_nodes`（`kind="taskcard"`，`ref_id = card_id`）。**任务以看板为界**：前置/关联只能引用同看板任务卡。

**形态**：任务卡 = 纯工作项卡，**无内置执行会话工作台**。常态 = 编辑表单栏（340px，左侧常驻，直接可输入）；展开 = 表单全宽（900px）。任务卡通过 **exec 线**引用画布上独立存在的执行会话卡（原子-链接，见「执行会话线」），提供「定位执行会话」动作跳到那张卡。从工具栏**拖出创建**（像便笺，`ToolbarItem tool="task-card"`）。

## 数据模型（迁移 v7）

```
task_cards
  id / board_id / project_key / number(项目内自增 #N)
  name* / description*(markdown)
  ready_status: draft|todo
  exec_status: not_started|running|review|done|failed|abandoned|waiting_reply
  priority(-1..1) / due(ms) / attachments(路径数组 JSON)
  cwd(默认=左侧栏当前目录，可改) / use_worktree(废弃，UI 不再编辑)
  max_retries(默认3) / retry_count / session_id(执行会话，exec 线真相源)
  created / updated

task_card_links      card_id → target_card_id(同看板) / kind: prerequisite|related
task_card_questions  待回答队列（S3 用）
```

- 编号：`MAX(number)+1` WHERE project_key，**UNIQUE(project_key, number)** 兜底防并发撞号。
- 状态枚举 store 层白名单校验（`assertReadyStatus`/`assertExecStatus`）。
- 执行状态**由调度器维护**，用户只读（表单显示徽章，无下拉）。

## 画布集成

- serialize：`type="task-card"` → `kind="taskcard"`，`refId=cardId`，props 全量存 `shapeProps`。
- hydrate：`kind="taskcard"` → 恢复 task-card shape，`cardId` 以 `node.refId` 为准（服务端绑定兜底）。
- **purge-orphans 必须排除 `kind='taskcard'`**（refId 是 task_cards.id 非会话 id，否则误删——血泪教训，见 `lib/board-purge.ts`）。
- 建卡：POST 支持 `nodeId`（复用空卡 node，`upsertTaskCardNode` 存在则绑 refId+写 shapeProps，不存在则按 nodeId 新建）；无 nodeId 走 `addNode`（也带 shapeProps）。**都带完整 shapeProps**（hydrate 依赖）。
- BoardIdContext（SessionCanvas 提供）：`{ boardId, defaultCwd }`——`useBoardId()` / `useBoardDefaultCwd()`（建卡 cwd 默认 = 左侧栏当前目录）。

## 依赖线

- 真相源 `task_card_links`；`syncCardEdges(cardId)` 按它 reconcile `board_edges`（label=kind，只 reconcile 出边，缺补多删）。
- 触发：建卡/改依赖（API 内）；删除依赖线会被 reconcile 补回（等效禁删）。
- 画布 arrow 带 `meta.taskLinkLabel`（prerequisite/related）→ 右键菜单选中依赖线时只显示「依赖连线（自动生成，不可删除）」只读项（`SyncedContextMenu`），无删除。

## 执行会话线（exec）

- 真相源 `task_cards.session_id`；`syncExecEdge(cardId)` 按它 reconcile `board_edges`（`label='exec'`，from=taskcard 节点 → to=session 节点，缺补多删）。
- 触发：`session_id` 写入/清空（绑定/解绑/重派发）、删任务卡（API/调度器内统一调）。
- 派生禁删：手动删 exec 线会被 reconcile 补回；真正的删除 = 清 `session_id` 或删任务卡。
- **执行会话卡必然存在**：先有会话才有关联，reconcile 补所有任务会话（含执行会话），exec 线总有落点；若任务卡已显示 sessionId 而画布暂无卡，属刷新时序 bug（修时序，不兜底）。

## 删除（确认制 + 事务）

- 删除拦截 toast 已废除（无 `boards.deleteBlocked`）；删除走**确认弹窗**（提示关联关系）→ 事务删除。
- **删会话**（单事务）：断 exec 线 → 清任务卡 `session_id` → 删画布 session 节点 + 关联边 → 删 `session_meta` → 删会话文件。先断引用再删实体，任一步失败回滚。
- **删任务卡**（单事务）：删依赖线 → 删 exec 线（会话保留，回到无关联）→ 删 taskcard 节点 + 关联边 → 删卡行。

## API

```
GET/POST   /api/task-cards                     ?boardId 列表/建卡（nodeId 复用空卡 node）
GET/PATCH/DELETE /api/task-cards/[id]          详情(links+inbound)/改字段(依赖替换同步边)/级联删
```

- POST/PATCH 依赖预校验：目标存在 + 同看板 + 非自环（400）。
- 系统看板 `__running__` 不能建任务卡（400）。

## 表单控件（TaskCardShape）

- 就绪/优先级/日期：自研 `ThemedSelect`（`components/canvas/ThemedSelect.tsx`，复用 `AnimatedDropdown` + `--side-*` token，主题自适应）。
- 预计截止：`DuePicker`（年/月/日三 ThemedSelect 联动，ms epoch）。
- 执行状态：只读徽章。
- 工作目录：`DirectoryPicker` 弹窗（「选择目录」按钮）+ 只读展示；默认 = `useBoardDefaultCwd()`。
- Worktree：调 `/api/worktrees?cwd=` 列 git worktrees，ThemedSelect 选择（主 checkout / 分支），选中联动 cwd。
- 前置/关联：同看板候选卡多选 checkbox（**新建时也可选**）。
- 最小尺寸：`onResize` minWidth 340 / minHeight 240。
