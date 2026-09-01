# pi-web · 任务卡原子-链接重构（exec 线）

> 日期：2026-09-01　范围：pi-web-sky　状态：已与用户逐轮确认　前置：`2026-08-30-task-boards.md`（任务即看板）、`2026-08-31-task-card-scheduler.md`（任务卡/调度）
> **取代**：本文是任务卡/看板会话关系的权威设计。`2026-08-30-task-boards.md`、`2026-08-31-task-card-scheduler.md`、`2026-08-31-task-cards-s1.md` 中与本设计冲突的部分全部废弃（详见 §6 清理清单）。

## 0. 需求（用户逐轮拍板）

> 看板 = 原子 + 链接：会话是原子，任务卡是引用会话的普通卡，关系用连线表达。
> 任务卡不需要工作台；执行会话在画布上就是一张普通会话卡，两者连线。
> 先创建会话才能有关联，所以执行会话一定有会话卡；若出现"任务卡比画布先刷新"属时序 bug，修时序不兜底。
> 删除是确认制：删前提示清楚（含关联关系），确认后删除；事务保证不留孤儿。
> 8s 详情轮询没有存在必要，运行中由 2.5s running 快照负责，及时状态展开时获取。

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | **会话卡是唯一会话形态**；任务卡 = 纯工作项卡（表单+状态徽章），不再内置执行会话工作台 | 消灭"两套展示体系"并行，occupied 去重、删除保护冲突、回默认等一系问题的根源拔除 |
| 2 | **occupied 概念整个废除**：`occupiedSessionIds`、reconcile 删 occupied 卡、删除保护豁免全部删除 | 无去重需求，画布允许每个会话（含执行会话）独立成卡 |
| 3 | 任务卡 ↔ 执行会话用 **exec 线**表达：`board_edges` 中 `label='exec'` 的边，`from=taskcard 节点` → `to=session 节点`；**派生、禁删**（改真相源才动） | 复用依赖线 `syncCardEdges` 的成熟模式；关系显式化、生命周期可管理 |
| 4 | **reconcile 补卡 = 补所有任务会话**（含执行会话），不再排除 occupied | 执行会话必然有卡（先有会话才有关联），exec 线总有落点 |
| 5 | 画布层 `deleteShapes` 拦截删除；删除走**确认制 + 事务**（删会话/删任务卡各自一个事务，不留孤儿） | 工具属性 > 产品属性；提示清楚比硬拦更符合预期 |
| 6 | **8s 详情轮询删除**；运行中状态由 2.5s running 快照（已含任务卡 `sessionId`）负责，展开时立即拉取一次 | 删掉一条 8s 滞后链路；任务卡工作台挂载改由 running 快照 + 展开即时驱动 |
| 7 | draft 兜底轮询（`reconcilePendingDrafts`）**保留** | 转正最终一致性兜底，成本低收益稳 |
| 8 | 任务卡 exec 线生命周期（绑定建线/解绑删线/删卡删线）由服务端 `syncExecEdge` 管理 | 与依赖线同模式，调度器/API 写真相源即可 |

## 2. 数据层

### 2.1 exec 线（新增派生边）

- 复用 `board_edges`，新增识别 `label='exec'`（`from_id` = taskcard 节点，`to_id` = session 节点）。
- `lib/board-store.ts` 新增 `syncExecEdge(cardId)`（参照 `syncCardEdges`）：
  1. 取卡（`getCard`）→ `session_id` + boardId；
  2. 本卡 taskcard 节点 + 会话节点（`getNodeByRefId`，session 节点取 `refId = session_id` 且 `kind='session'`）；任一端缺失则**不建线、清掉残留 exec 边**（节点后补由 reconcile 兜底）；
  3. 期望边 = 一条 `{ fromId: 本卡node, toId: sessionNode, label: 'exec' }`；
  4. diff：期望有而画布无 → `addEdge`；画布有而期望无 → `deleteEdge`（禁删由派生 reconcile 保证）。
- **不包事务**（内部多次写），由调用方包事务（同 `syncCardEdges` 先例）。
- 触发点：`updateCard` 写 `sessionId`（绑定/解绑/重派发）、`deleteCard`（删任务卡）——API/调度器统一在这些写入点调 `syncExecEdge`。

### 2.2 occupied 废除

- `app/api/tasks/[id]/route.ts`：删除 `occupiedSessionIds` 计算与返回（前端不再消费）。
- `hooks/useBoardCanvas.ts` `reconcileTaskSessions`：删除 occupied 集合、`toRemove` 删卡段、补卡时的 occupied 排除；`missing = sessionIds - 画布已有卡` 直接补。
- `occupiedSessionIdsRef`（及 deleteShapes 保护里的 occupied 豁免）删除。

### 2.3 删除事务

- **删会话**（确认后，单事务）：断 exec 线（`board_edges label='exec'` 指向该会话节点的边）→ 清 `task_cards.session_id`（引用它的卡置空 + `syncExecEdge`）→ 删画布 session 节点 + 关联边 → 删 `session_meta` → 删会话文件。**先断引用、再删实体**；任一步失败回滚。
- **删任务卡**（确认后，单事务）：删 `task_card_links` → 删 `task_card_questions` → 删 exec 线（会话保留，回到无关联）→ 删 taskcard 节点 + 关联边 → 删卡行。

## 3. 前端改动

### 3.1 TaskCardShape 去工作台

- 展开态右侧 SessionWorkbench 面板 + 会话标题栏/navbar slot 删除；展开态 = 编辑表单（名称/描述/状态/优先级/截止/附件/前置关联/工作区）。
- 新增「定位执行会话」动作：点击把画布居中/高亮到 exec 线连着的会话卡（跳到独立卡看内容）。
- 空态文案：有 `session_id` 但画布暂未见会话卡时提示"执行会话卡同步中"（时序 bug 的可视化信号），而非"等待派发"。

### 3.2 任务卡展开即时 + running 快照驱动

- `useTaskCard` 删除 `pollMs` 8s 轮询；保留展开/挂载时立即 `reload()` 一次。
- 运行中 `sessionId` 改从 2.5s running 快照 `taskCards[]`（含 `sessionId`）取：`board.running.taskCards` 命中本卡且 `execStatus >= running` → 立即用其 `sessionId` 挂载/更新工作台入口，不等详情。
- `TaskCardShape` 展开空态必须区分 `loading`（拉取中）与"确实未派发"，不再把加载中误显示为"等待派发"（修复"已派发却显示等待派发"bug）。

### 3.3 reconcile 补卡（前端）

- `reconcileTaskSessions` 简化为：任务 `sessionIds` 与画布 session-card diff，缺则 `addSessionNode`；删除所有 occupied 相关逻辑。
- 执行会话卡随任务会话一并补（保证 exec 线落点）。

### 3.4 删除确认

- 删会话/删任务卡的确认弹窗（含关联关系提示），确认后调删除 API（事务，见 §2.3）。
- `SessionCanvas` 删除拦截 toast（`boards.deleteBlocked`）删除；`deleteShapes` 重写恢复原状。

## 4. 数据流（触发 → 动作 → 变化）

| # | 触发点 | 动作 | 变化 |
|---|--------|------|------|
| 1 | 用户发消息 / 调度器建会话 | `/api/agent/new`（带 taskId） | 服务端原子挂任务；前端事件 → 卡片转正 + 即时刷标题 |
| 2 | 任务卡勾"就绪" | saveCard → 调度器派发 | 建/复执行会话 → 挂任务 → 写 `session_id` → `syncExecEdge` 建线 → reconcile 补会话卡（若缺） |
| 3 | 进入看板 + 10s 兜底 | reconcile | 任务所有会话 vs 画布卡 diff → 缺的补卡（含执行会话） |
| 4 | `session_id` 写入/清空 | `syncExecEdge` | `board_edges` 建/删 `label='exec'` 边（派生、禁删） |
| 5 | 用户确认删会话 | 删除事务 API | 断 exec 线 → 清任务卡 session_id → 删画布卡/边 → 删 session_meta → 删会话文件（单事务） |
| 6 | 用户确认删任务卡 | 删除事务 API | 删依赖线 → 删 exec 线（会话保留）→ 删 taskcard 节点 → 删卡行（单事务） |
| 7 | 2.5s running 轮询 | 更新卡片 phase / 任务卡 execStatus | 会话卡运行状态、任务卡徽章；展开时从快照取 `sessionId` 挂载工作台入口 |

## 5. 删减清单

| 删什么 | 位置 | 原因 |
|---|---|---|
| occupied 去重：删 occupied 卡 + occupied 集合 + 补卡排除 | `useBoardCanvas.ts` reconcile；`app/api/tasks/[id]/route.ts` | 概念废除 |
| occupied 删除保护豁免（`occupiedSessionIdsRef` + 保护条件） | `useBoardCanvas.ts` | 失去意义 |
| 删除拦截 toast + `deleteShapes` 重写 + `deleteBlockedCount` | `useBoardCanvas.ts`、`SessionCanvas.tsx`、i18n `boards.deleteBlocked` | 改确认制 |
| 8s 详情轮询 | `useTaskCards.ts` pollMs；`TaskCardShape.tsx` `expanded ? 8000` | 运行中由 2.5s running + 展开即时接管 |
| 任务卡工作台（右面板 + SessionWorkbench 挂载 + 会话标题栏/navbar slot） | `TaskCardShape.tsx` | 任务卡退化为纯工作项卡 |
| 保留：draft 兜底轮询 | `useBoardCanvas.ts` `reconcilePendingDrafts` | 转正兜底 |

## 6. 清理清单（旧文档）

- `.agent/spec/2026-08-30-task-boards.md`：顶部加废弃标注（被本文 §1/§3/§4 取代），正文保留作历史；其中 reconcile 补卡语义以本文为准。
- `.agent/spec/2026-08-31-task-card-scheduler.md`：顶部加废弃标注；任务卡展开态"左表单右工作台"、专属执行会话占用语义以本文为准。
- `.agent/plan/2026-08-31-task-cards-s1.md`：顶部加废弃标注（S1 已完成部分保留，未完成部分按本文调整）。
- `docs/reference/boards.md`、`docs/reference/task-cards.md`：按本文更新为对齐新架构（occupied 废除、exec 线、删除确认、无工作台）。

## 7. 分阶段实施

- **S1 数据层**：exec 线模型（`syncExecEdge`）+ occupied 废除（API/reconcile）+ 删除事务。交付：关系可建可断、无孤儿，API 语义正确。
- **S2 前端**：任务卡去工作台 + 定位执行会话 + reconcile 补卡调整 + 展开即时（running 快照驱动 + 展开空态修 bug）+ 删除确认。交付：UI 对齐原子-链接。
- **S3 收尾**：`purge-orphans` 对 taskcard 孤儿兜底（指向 `task_cards` 不存在卡的 `kind='taskcard'` 节点清理）、遗留数据（历史 occupied 残留卡）迁移。
- 每阶段独立验收、滚动提交、可回滚。

## 8. 测试

- **数据层（.mjs，事务 + try/finally 回滚）**：`syncExecEdge` 建/删线、绑解绑、删卡删线；删除事务级联（删会话不留孤儿：断线/清 session_id/删节点/删 meta）；occupied 移除后 `/api/tasks/[id]` 不再返回 `occupiedSessionIds`。
- **API（.mjs）**：删除会话/任务卡事务一致性。
- **前端 e2e**（playwright + chrome-devtools 真浏览器）：任务卡就绪 → 画布出现执行会话卡 + exec 线；展开任务卡即时看到执行会话（不再"等待派发"）；删任务卡 → exec 线消失、会话卡保留；删会话 → 关联任务卡解绑、无孤儿卡。
- `npm test` / `node_modules/.bin/tsc --noEmit` / `npm run lint` 全绿。

## 9. 不做（YAGNI）

- 不做 exec 线的手动编辑（派生，改真相源才动）。
- 不做任务卡工作台（已废除）。
- 不做会话卡与任务卡的位置自动对齐（连线已表达关系，用户自摆）。
- 任务卡执行会话的生命周期自动回收不做（交给现有会话清理机制）。
