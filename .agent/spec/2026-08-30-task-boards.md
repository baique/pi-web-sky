# pi-web · 任务即看板

> 日期：2026-08-30　范围：pi-web-sky　状态：待用户 review　前置：`2026-08-29-session-canvas-v2.md`（看板/画布/工作台已交付）

## 0. 需求（用户原话 + 拍板）

> 任务本身就是看板，点击任务，直接打开看板，内部自动加入当前任务中的会话。
> 旧会话记录坐标等信息，新会话放在右上或者左下角，或者随便一个什么位置，只要不遮挡。

用户已拍板（2026-08-30）：
1. **点任务行进看板**；会话列表**保留**为次级入口（chevron 折叠展开）。
2. 手动「看板」区**保留**，任务型看板**不混进**手动看板列表（类别区分，不重复展示）。
3. 任务看板**懒创建**、名随任务、删任务连带删看板；旧会话恢复坐标，新会话自动找空位不遮挡。
4. 打开期间任务新增会话：**轮询顺带 diff 自动补卡**（用户已确认加）。

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | **看板 id = 任务 id**，`boards.task_id` 非空即任务型看板 | 复用全部 board 基础设施（nodes/edges/view/展开工作台），无新表；懒创建一次写入 |
| 2 | 任务看板自动补卡 = **任务根会话集合**（`listTaskSessionIds`，即 session_meta.task_id 匹配） | 看板天然"一个会话一张卡"，根会话卡片展开工作台已含 fork 分支导航，fork 后代不单独建卡 |
| 3 | 任务看板是任务会话的**实时镜像**：打开时 diff + 打开期间轮询 diff，差集自动补卡 | 保证"任务即看板、新会话自动进"，坐标由 board_nodes 持久化自然恢复 |
| 4 | 任务看板**不提供**"从看板移除任务会话卡片"（要移除即移出任务）；手动拖入的额外会话卡片保留 | 避免"删掉又被 diff 补回"的语义冲突；看板恒 = 任务会话镜像 + 手动附加 |
| 5 | `listBoards` 返回全部（含 task 看板，`BoardInfo.taskId` 暴露）；**前端 BoardSection 过滤** `taskId == null` | API 语义完整，展示层决定显示与否 |

## 2. 数据层（迁移 v5）

```sql
ALTER TABLE boards ADD COLUMN task_id TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_boards_task ON boards(task_id);
```

- `lib/board-types.ts`：`BoardInfo` 加 `taskId: string | null`。
- `lib/board-store.ts`：
  - `BoardRow` 加 `taskId`；`getBoardRow` / `listBoards` SQL 补 `task_id`；`rowToBoard` 补字段。
  - `createBoard(projectKey, name, taskId?)`：可选 taskId，INSERT 时写入。
  - 新增 `getOrCreateTaskBoard(taskId, projectKey, name): BoardInfo`：查 `boards WHERE task_id = ?`；不存在则 INSERT（id = taskId，task_id = taskId，is_system = 0，sort_order 沿用 createBoard 的最小值 - 1 置顶逻辑，名字 = 任务名）；返回 BoardInfo。
  - 新增 `deleteBoardCascade(id)`（**无事务**，纯 SQL：删 nodes/edges/view/boards 行）；`deleteBoard(id)` 改为事务包装 + 调它（保持外部 API 不变）。
  - 新增 `renameTaskBoard(taskId, name)`（无事务，`UPDATE boards SET name WHERE task_id = ?`，看板不存在则 0 行无害）。
- `lib/task-store.ts`：
  - `deleteTask` 事务内追加 `deleteBoardCascade(id)`（任务 id 即看板 id）。
  - `updateTask` 改名分支追加 `renameTaskBoard(id, trimmed)`。
  - （SDK-free 约束：board-store 同样 SDK-free，task-store 可直接 import。）

> 事务铁律：SQLite 不支持嵌套 BEGIN。`deleteBoardCascade` / `renameTaskBoard` 必须无事务，由调用方（deleteBoard / deleteTask / updateTask）在自身事务内调用。board-store 的 `deleteBoard` 保持"自开事务"行为不变。

## 3. API

- 新增 `GET /api/tasks/[id]/board`：`getTask(id)` 拿 projectKey/name → `getOrCreateTaskBoard(taskId, projectKey, name)` → `{ board: BoardInfo }`；任务不存在 404。`dynamic = "force-dynamic"`。
- 其余 boards API 不变（task 看板复用 `GET/PUT /api/boards/[id]/canvas`、nodes/edges/view 全接口）。

## 4. 任务行交互（TaskCard / TaskArea / SessionSidebar）

- **点任务行 header → 打开该任务的看板**（不再整行 toggle 会话列表）。
- 会话列表保留：任务行最左侧新增 **chevron 折叠箭头按钮**（`stopPropagation`），点击展开/收起任务内会话列表；箭头方向随 collapsed 旋转（沿用现有折线箭头样式与 0.15s 过渡）。
- `+`新建、重命名、⋮更多（置顶/重命名/删除）、任务拖拽排序、会话拖入分配、删除确认、加载更多**全部保留**。
- 新 prop 链路：`TaskCard.onOpenBoard(taskId)` ← `TaskArea.onOpenBoard` ← `SessionSidebar.onOpenTaskBoard` ← `AppShell.handleOpenTaskBoard`。
- `aria-expanded` / role="button" 语义从整行移到 chevron 按钮（避免可访问性歧义）。

## 5. AppShell 打开链路

- 新增 `handleOpenTaskBoard(taskId)`：
  1. `fetch /api/tasks/[id]/board` → `boardId`（懒创建）
  2. 复用 `handleOpenBoard(boardId)`：`setActiveBoardId` + `router.replace(?board=)`。
- 退出看板、点会话/新建即回聊天：现有机制不变（`setActiveBoardId(null)`）。

## 6. 自动补卡 + 坐标恢复 + 自动摆放（useBoardCanvas / CanvasStage）

- `useBoardCanvas` 新增 prop `taskId?: string`（由 SessionCanvas 透传）。
- 打开任务看板时（现有 hydrate 完成后）：若 `taskId` 非空 → 执行一次 `reconcileTaskSessions`。
- 打开期间（复用现有 10s 摘要轮询循环）：每个周期顺带执行 `reconcileTaskSessions`。
- `reconcileTaskSessions`：
  1. `fetch /api/tasks/[id]`（no-store）拿最新 `sessionIds`。
  2. 收集画布现有 `session-card` shape 的 `sessionId` 集合。
  3. 差集（任务会话中无卡片者）= 新会话 → `addSessionNode(sid, findFreeSpot(editor))`。
  4. 已有卡片坐标由 board_nodes 物化自然恢复，不动。
- **自动摆放 `findFreeSpot(editor)`**：收集现有 session-card 矩形（x/y/w/h），从画布起点 `(60, 60)` 起按行扫描（y 递增、x 递增），候选矩形 `(x, y, CARD_W, CARD_H)` 与所有现有矩形**不重叠且间隙 ≥ 24** 的第一个位置返回；画布无限，最坏也极快。等价于"右下方向逐行找空位"，天然不遮挡。
- 系统「运行中」看板 / 手动看板路径完全不受影响（taskId 为空则原逻辑）。

## 7. 手动看板区（BoardSection）

- 列表渲染改为过滤 `board.taskId == null`（项目看板行）；系统「运行中」看板照旧。
- 任务型看板**不重复展示**——任务行本身即入口。
- 新建/改名/删除/拖拽排序等仅作用于手动看板，逻辑不变。

## 8. 组件 / 文件改动清单

```
lib/sqlite-db.ts                  Modify：SCHEMA_VERSION 4 → 5 + MIGRATIONS 追加 v5（boards.task_id）
lib/board-types.ts                Modify：BoardInfo 加 taskId
lib/board-store.ts                Modify：taskId 字段 + getOrCreateTaskBoard + deleteBoardCascade + renameTaskBoard
lib/task-store.ts                 Modify：deleteTask 级联删看板；updateTask 改名同步看板名
app/api/tasks/[id]/board/route.ts Create：GET（懒创建任务看板）
components/TaskArea.tsx           Modify：TaskCard 点行开看板 + 左侧 chevron 展开会话列表
components/SessionSidebar.tsx     Modify：onOpenTaskBoard prop 透传；taskGroups 不变
components/AppShell.tsx           Modify：handleOpenTaskBoard
components/canvas/SessionCanvas.tsx Modify：透传 taskId
hooks/useBoardCanvas.ts           Modify：taskId prop + reconcileTaskSessions + findFreeSpot
components/canvas/BoardSection.tsx Modify：过滤 taskId == null
i18n/*                            补全：任务看板相关新文案
```

## 9. 测试与验收

- **数据层（.mjs，事务 + try/finally 回滚，不保留数据）**：
  - `board-store.test.mjs`：`getOrCreateTaskBoard` 幂等（重复调用返回同一 board）；task 看板带 taskId 落库；`deleteBoardCascade` 事务内级联删 nodes/edges/view。
  - `task-store.test.mjs`：`deleteTask` 后对应看板及 nodes/edges/view 全部消失；`updateTask` 改名后看板名同步。
- **API（.mjs）**：`/api/tasks/[id]/board` 首次 200 创建、再调返回同一 id；任务不存在 404。
- **前端**：playwright + chrome-devtools 真实浏览器 e2e：点任务行进看板 → 任务会话自动成卡 → 拖拽换位 → 刷新页面坐标不丢 → 任务内新建会话自动补卡不遮挡。
- `npm test` / `node_modules/.bin/tsc --noEmit` / `npm run lint` 全绿。

## 10. 不做（YAGNI）

- 任务看板不做"移除任务会话卡片"（镜像语义）；任务会话移动/删除由任务区操作完成。
- 不做任务看板批量导入 fork 后代、不做自动布局算法（保留手动拖动）。
- 手动看板功能不裁剪，仅列表过滤展示。
