# 会话看板（boards / 任务即看板）— tldraw sync 版

> 改看板 / 画布 / 任务即看板 / 便笺 / 派生边前阅读。tldraw 5.x + 自定义 shape + sync 协作的坑都在这里。

## ⚠️ 架构迁移（2026-09 已完成）

看板画布数据层已从「前端全量保存 SQLite」迁移到 **tldraw sync**（CRDT 协作 + SQLite 持久化）：

- **画布即文档**：每看板一个 `TLSocketRoom`（内嵌 Next.js server，`lib/sync-room-server.mjs`，同端口 30143），文档（shape/binding/camera）由 sync 管理，SQLite 持久化到 `~/.pi/agent/sync.db`（`tablePrefix=board_<id>_` 隔离）。
- **前端 `useSync`** 连接文档：任何编辑（拖拽/增删/缩放）经 CRDT 自动同步到所有客户端并持久化。**无防抖全量保存 / 乐观锁 / 409 冲突 / 重灌**。
- **业务派生边（exec 线 / 依赖线）由前端 reconcile 渲染**：读业务数据（`/api/tasks/[id]` 任务会话、`/api/task-cards?boardId=` 任务卡 sessionId + links）→ diff 画布 → `editor.createShape`（确定性 id 幂等，CRDT 合并）。后端只写业务表，不写画布。
- **删除**：确认制 → `editor.store.remove`（CRDT 同步）+ 调业务 API（清 `task_cards.session_id` / `session_meta` / 会话文件）；侧栏删会话的孤儿卡由 reconcile 清理。
- 旧 `board_nodes` / `board_edges` / `board_view` 表**废弃**（不再写，保留作回滚）。
- **`__running__` 系统看板已废弃**（2026-09-02 用户决定移除）。

### 启动

```bash
npm run dev          # 单进程：HTTP + WS 同端口 30143（sync 房间内嵌，无需另起）
npm run migrate-boards  # 一次性：旧 board_nodes/edges → sync.db（重迁移需先删 sync.db）
# 可选：拆独立进程（端口 30144）→ npm run sync，前端需设 NEXT_PUBLIC_SYNC_WS=ws://127.0.0.1:30144
```

前端连接地址 `NEXT_PUBLIC_SYNC_WS`（默认 `ws://127.0.0.1:30143` 同端口）。

## 数据层铁律（sync 版）

- **画布文档在 sync.db**（SQLiteSyncStorage），业务表（boards/task_cards/task_card_links/session_meta）仍在 `pi-web.db`。两库独立，业务进程不写画布。
- **reconcile 触发**：任务看板打开 + 10s 轮询 + running 快照发现新 running 任务卡（2.5s）→ 补会话卡 / 补 exec 线 / 补依赖线 / 删孤儿卡。
- **派生边**：exec 线（任务卡 ↔ 执行会话，`meta.execLinkLabel`）、依赖线（任务卡 ↔ 任务卡，`meta.taskLinkLabel`）→ **禁删**（deleteShapes 拦截跳过，reconcile 补回）。
- **孤儿卡删除**：任务看板下，会话卡 sessionId 不在任务会话集合 → 删（任务看板会话卡由任务驱动）。普通看板不清理（用户手动管理）。
- **摘要/运行状态**：轮询更新 shape props（标题/phase/runningMs），同步到文档，多端一致。

## 卡片即工作台（tldraw）

- tldraw 5.x，`next/dynamic` ssr:false 按需加载。自定义 shape 用 `BaseBoxShapeUtil`。
- 卡片两态：收合卡（340×160）↔ **展开即工作台**（同一卡片放大，默认 760×600）。展开态工作台 = portal 浮层 + `1/zoom` 反补偿，`zoom < 60%` 降级骨架态。
- **新会话卡**：看板新建会话 = `sessionId` 为发起时生成的 UUID + `cwd` 非空的卡（不再有 `sessionId` 为空的 draft 占位）。用户在卡内发首条消息时 `ensure_session` 携带该 UUID 创建会话（`POST /api/agent/new` 的 `id` 字段），创建成功（文件落盘）后清 `cwd` 字段转正为普通卡（CRDT 同步）。
- 卡片内改名：内联输入 → `PATCH /api/sessions/[id]` → 事件桥刷左侧树 + 摘要轮询刷新标题。

## 看板内搜索（Ctrl+F）

- 常驻搜索框（画布顶部居中玻璃胶囊），匹配会话卡标题 + 便笺正文，命中后 `centerOnPoint` 居中定位 + accent 描边渐隐。纯前端：不写 store、不落库、刷新即消失。
- 高亮状态走 React context；Ctrl+F 仅看板模式生效。

## tldraw 集成陷阱

- tldraw 全局 `user-select:none` 会禁用画布内文本选中——工作台消息区与便笺 markdown 必须显式恢复选中（根因同源）。
- 便笺是**自研 markdown 便笺**（`StickyNoteShape`），不要用 tldraw 内置 Note。
- 看板卡片内的 `position:fixed` 弹层（如 BranchNavigator 下拉）会被 `backdrop-filter` 容器劫持导致漂移 → portal 到 body。
- 便笺 `createdAt` 用 `useState` 惰性初始化，禁止 render 期 `Date.now()`（lint purity）。
- 卡片状态以展开卡内 `useAgentSession` 的 SSE 为准，看板聚合态以 `/api/agent/running` 轮询为准——双源不打架。
- 看板 URL `?board=` 持久化；退出看板 / 点会话 / 新建即回聊天。
- **useSync 连接稳定性**：`useSync` 的 shapeUtils 必须是模块级常量（引用稳定），否则每次渲染重建连接 → session 堆积 + push_result 死循环（血泪教训，见踩坑）。
- **sync-server 接线**：`handleSocketConnect` 会自动给 ws 挂 message/close/error 监听（ws 支持 EventTarget）——**绝不手动再 `ws.on("message")`**，否则每条消息处理两次 → push_result 双发 → 重连死循环。sessionId 必须复用客户端 TAB_ID（不能每次随机生成）。
- **内嵌架构**：`server.mjs`（自定义 Next server）把 HTTP 交 `next.getRequestHandler()`，upgrade 分流——`/connect/:boardId` 交 `handleSyncUpgrade`（`lib/sync-room-server.mjs`），其余（HMR）交 `next.getUpgradeHandler()`。`npm run dev` / `npm start` 均走此文件，单进程同端口。

## 派生边 reconcile 细节（useBoardCanvas）

- `reconcile`：读任务会话 + 任务卡（含 links）→ ① 补/清会话卡（孤儿删除）② 补 exec 线（`createExecEdge`，端点匹配去重）③ 补/删依赖线（`createLinkEdge`）。
- 确定性 id：会话卡 `session-<sid>`、exec 线 `exec-<cardId>`、依赖线 `link-<from>-<to>-<kind>` → 幂等。
- exec/依赖线创建 = `editor.createShape(arrow)` + `editor.createBindings`（arrow→两端 shape，随卡片移动）。
