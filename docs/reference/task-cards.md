# 任务卡（task-cards）

> 改任务卡 / 任务卡数据模型 / 依赖线 / 执行会话线 / 任务卡表单前阅读。当前架构 spec 见 `.agent/spec/2026-09-01-task-card-atomic-link.md`（原子-链接 + exec 线）；历史 spec `.agent/spec/2026-08-31-task-card-scheduler.md` / plan `.agent/plan/2026-08-31-task-cards-s1.md` 已标注废弃部分，冲突处以当前 spec 为准。

## 概念

任务卡 = 看板上的工作项卡（独立实体，与 sidebar「任务/会话分组」解耦）。业务字段在 `task_cards` 表；**画布布局在 tldraw sync**（shape 自带 `cardId` prop，持久化到 `sync.db`），不再写 `board_nodes`。**任务以看板为界**：前置/关联只能引用同看板任务卡。

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
- **派发语义**：画布上的卡 = 草稿占位（未建卡/未入任务表）；点右上角「派发」→ 建卡（`ready_status=todo`）或 draft→todo，调度器才可派发。todo 态显示执行状态徽章，不再可回退草稿。

## 画布集成

- **画布节点在 tldraw sync**（shape 自带 cardId prop，CRDT 持久化到 `sync.db`）；`board_nodes` 废弃保留（不再写）。
- 建卡/保存**不依赖 nodeId 绑定**：`POST/PATCH /api/task-cards` 直接写 `task_cards` 表；shape 的 `cardId` 由前端 `editor.updateShape` 写回（建卡成功后）。
- BoardIdContext（SessionCanvas 提供）：`{ boardId, defaultCwd }`——`useBoardId()` / `useBoardDefaultCwd()`（建卡 cwd 默认 = 左侧栏当前目录）。

## 依赖线

- 真相源 `task_card_links`；**画布依赖线由前端 reconcile 渲染**（`useBoardCanvas.ts`）：读任务卡 links → diff 画布 → `createLinkEdge`（arrow + binding，`meta.taskLinkLabel`，缺补多删、确定性 id 幂等）。后端只写 links，不直接建线。
- 触发：任务看板打开 + 10s 轮询 + running 快照发现新 running 卡时跑。
- 画布 arrow 带 `meta.taskLinkLabel`（prerequisite/related）→ 右键菜单选中依赖线时只显示「依赖连线（自动生成，不可删除）」只读项（`SyncedContextMenu`），无删除。

## 执行会话线（exec）

- 真相源 `task_cards.session_id`；**画布上的 exec 线由前端 reconcile 渲染**（`useBoardCanvas.ts` 的 `reconcile`）：读任务卡 sessionId + 画布节点 diff → `createExecEdge`（arrow + binding，`meta.execLinkLabel`，缺补多删、确定性 id 幂等）。后端只写 `session_id`，不直接建线。
- 触发：reconcile 在任务看板打开 + 10s 轮询 + running 快照发现新 running 卡时跑——任务卡绑定执行会话后 **exec 线秒级/10s 内自动出现**。
- 派生禁删：手动删 exec 线会被 reconcile 补回；真正的删除 = 清 `session_id` 或删任务卡。
- **执行会话卡必然存在**：先有会话才有关联，reconcile 补所有任务会话（含执行会话），exec 线总有落点。

## 删除（确认制 + 事务）

- 删除拦截 toast 已废除（无 `boards.deleteBlocked`）；删除走**确认弹窗**（提示关联关系）→ 事务删除。
- **删会话**（单事务）：断 exec 线 → 清任务卡 `session_id` → 删画布 session 节点 + 关联边 → 删 `session_meta` → 删会话文件。先断引用再删实体，任一步失败回滚。
- **删任务卡**（单事务）：删依赖/问答 → 删卡行（画布 shape 由前端删，sync.db 持久化）。

## API

```
GET/POST   /api/task-cards                     ?boardId 列表/建卡（建卡即派发，readyStatus 默认 todo）
GET/PATCH/DELETE /api/task-cards/[id]          详情(links+inbound)/改字段(依赖替换)/级联删
```

- POST/PATCH 依赖预校验：目标存在 + 同看板 + 非自环（400）。
- 系统看板 `__running__` 不能建任务卡（400）。

## 表单控件（TaskCardShape）

- 右上角「派发」按钮：空卡 = 建卡向导（派发即建卡 todo）；已建卡 draft = 转 todo（可调度）；已建卡 todo = 执行状态徽章（只读，不再可回退草稿）。
- 预计截止：`DuePicker`（年/月/日三 ThemedSelect 联动，ms epoch）。
- 执行状态：只读徽章。
- 工作目录：`DirectoryPicker` 弹窗（「选择目录」按钮）+ 只读展示；默认 = `useBoardDefaultCwd()`。
- Worktree：调 `/api/worktrees?cwd=` 列 git worktrees，ThemedSelect 选择（主 checkout / 分支），选中联动 cwd。
- 前置/关联：同看板候选卡多选 checkbox（**新建时也可选**）。
- 最小尺寸：`onResize` minWidth 340 / minHeight 240。
