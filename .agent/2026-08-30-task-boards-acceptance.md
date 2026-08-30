# 任务即看板 · 验收报告

> 日期：2026-08-30　范围：pi-web-sky　依据：`.agent/spec/2026-08-30-task-boards.md`

## 交付内容

| # | 功能 | 实现 |
|---|------|------|
| 1 | 数据层 | 迁移 v5（`boards.task_id` + 索引）；`getOrCreateTaskBoard` 懒创建（看板 id = 任务 id）；`deleteBoardCascade` / `renameTaskBoard` 无事务函数供 task-store 事务内调用 |
| 2 | 任务生命周期联动 | `deleteTask` 级联删看板（nodes/edges/view）；`updateTask` 改名同步看板名 |
| 3 | API | `GET /api/tasks/[id]/board` 懒创建返回看板（幂等） |
| 4 | 任务行交互 | 点任务行 → 打开该任务看板；左侧 chevron 保留会话列表展开/收起 |
| 5 | 自动补卡 | 任务看板打开时 diff（任务根会话 − 画布已有卡片）+ 10s 轮询顺带 diff；新卡 `findFreeSpot` 从 (60,60) 逐行扫描不遮挡 |
| 6 | 手动看板区 | 过滤 `taskId == null`，任务型看板不重复展示；拖拽排序同步过滤 |
| 7 | 刷新兜底 | URL `?board=` 恢复任务看板时，从 `board.taskId` 识别任务型并继续自动补卡 |

## 验收项证据

- [x] 点任务行 → 主区域切换为画布，URL 带 `?board=<任务id>`
  - e2e `scripts/e2e-taskboards.mjs`：`click task opens board mode (?board=)` ✓
- [x] 任务内会话自动成卡（旧会话坐标从 board_nodes 恢复）
  - e2e：`session cards auto-added — 3 cards (task has 3)` ✓
- [x] 新会话加入任务 → 自动补卡不遮挡
  - e2e：`assigned new session to task via API` ✓ + `new session auto-added to board — cards=4 expected=4` ✓
  - `findFreeSpot` 逐行扫描（y 递增、x 递增，与现有卡间隙 ≥ 24）
- [x] 坐标持久化：移动卡片 → 刷新 → 位置保持
  - e2e：`position persisted after reload — {"x":800,"y":500}` ✓
- [x] 手动看板区不重复展示任务型看板
  - e2e：`task board row NOT rendered in sidebar boards — rows=0` ✓
- [x] 删任务连带删看板 / 改名同步看板名
  - 单测：`lib/task-store.test.mjs` → `deleteTask cascades to its task board` ✓、`updateTask rename syncs task board name` ✓
- [x] 懒创建幂等
  - 单测：`lib/board-store.test.mjs` → `task board: lazy create (upsert)` ✓
- [x] 测试 / 类型 / lint 全绿
  - `npm test` 736/736 通过；`tsc --noEmit` 无错误；`npm run lint` 0 errors（18 warnings 为既有代码）

## 提交记录（里程碑粒度）

```
d839152 feat(task-boards): 数据层 — boards.task_id 迁移 v5 + 任务看板懒创建/级联删除/改名同步 + API
5186f75 feat(task-boards): 点任务行打开该任务看板 + 左侧 chevron 保留会话列表入口
b6ea376 feat(task-boards): 任务看板自动补卡 — 打开时 diff + 10s 轮询 + findFreeSpot 不遮挡摆放
88f5a0a feat(task-boards): 手动看板区过滤任务型看板（taskId==null）不重复展示
ad7916b fix(board): 便笺 createdAt 兜底改用 useState 惰性初始化 — 消除 render 期 Date.now()（lint purity）
9d839f0 test(e2e): 任务即看板验证脚本
```

## 备注

- 测试残留已清理：e2e 在 `bug` 任务上创建的看板已删除（任务与 3 个会话完好，用户下次点击自动重建）。
- 遗留未提交改动（BranchNavigator / SessionNavBar / SessionWorkbench / board-events / SessionStatsSummary / session-stats）为之前会话的工作，未触碰。
