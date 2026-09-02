# 会话看板（boards / 任务即看板）— React Flow + yjs 版

> 改看板 / 画布 / 任务即看板 / 便笺 / 派生边前阅读。自研画布（无 tldraw）的实现要点都在这里。

## ⚠️ 架构迁移（2026-09-02 已完成，tldraw → React Flow + yjs）

**背景**：tldraw 为 source-available 自有许可（商用受限），决定移除，画布完全自研。

**新数据层（yjs CRDT）**：
- 每看板一个 **Y.Doc**（`@hocuspocus/server` 内嵌，documentName=boardId），结构 `nodes` / `edges` / `view` 三个 Y.Map。
- 持久化：SQLite `~/.pi/agent/sync.db` 表 `yjs_documents`（onStoreDocument 存全量 update）。
- 内嵌：`server.mjs` 的 upgrade 分流——仅 `/connect` 交 Hocuspocus（`handleYjsUpgrade`），其余（HMR）交 Next。前端 provider URL `ws://host/connect`，`name` 参数 = boardId。

**渲染层（React Flow）**：
- `CanvasStage` → `<ReactFlow>` 受控组件（nodes/edges 绑定 Y.Map，CRDT 增量合并）。
- 节点 = 自定义 React 组件（SessionCardNode / TaskCardNode / StickyNoteNode），RF 原生 `nowheel`/`nodrag`/`nopan` 解决卡片内部滚动/输入 vs 画布手势冲突。
- 连线：RF edge（exec 线虚线 / 依赖线实线 / 手绘线），节点须有 `<Handle>`。

**派生元素由后端权威 reconcile**（`lib/board-reconcile.ts`）：
- 业务表（tasks / task_cards / task_card_links / session_meta）= 唯一真相源，后端写。
- 补会话卡（`session-<sid>`）、补任务卡（`task-<cardId>`）、exec 线（`exec-<cardId>-<sessionId>`）、依赖线（`link-<from>-<to>-<kind>`）——确定性 id 幂等，缺补多删，**绝不整表覆盖**。
- 孤儿删（业务表不存在的会话卡/任务卡节点）由后端唯一执行，前端不做 → 多端不互相删卡。
- 触发：调度器派发 / 建卡删卡 / 任务归属变化 / 任务初始化 / 10s 定时兜底（`board-reconcile-scheduler`）。
- **任务初始化是纯后台动作**：`/api/tasks/[id]/board` 建看板后立即 reconcile 补已有会话卡，不依赖前端加载时机。

**前端职责**：用户内容（布局 / 尺寸 / 便笺文本 / 新建卡）+ 展示字段（phase / runningMs / 标题）写 Y.Doc 增量；不做孤儿清理 / 派生 reconcile。

### 启动

```bash
npm run dev          # 单进程：HTTP + WS 同端口（yjs 房间内嵌，无需另起）
# 无独立 sync 进程；NEXT_PUBLIC_SYNC_WS 可覆盖前端连接地址（默认跟随当前 origin）
```

## 数据层铁律（yjs 版）

- **画布文档在 sync.db（yjs_documents）**，业务表在 pi-web.db。两库独立，业务进程写业务表，派生 reconcile 写画布。
- **前端编辑 = 增量 Y.Map.set**（按 id），无全量快照 / 乐观锁 / 409 / 重灌。
- **派生边**：exec 线（`data.execLink`）、依赖线（`data.taskLink`）→ **禁删**（前端 onEdgesChange 跳过，后端 reconcile 兜底补回）。
- **孤儿卡删除**：后端 reconcile 删（业务表确认不存在 + 非新会话卡 cwd 非空）。
- **展示字段**：2.5s running 快照（phase/runningMs/execStatus）+ 10s 摘要（标题/消息数）轮询 → 写 Y.Map data，多端一致。

## 卡片即工作台（React Flow）

- 节点宽高由 `style.width/height` 控制；收合↔展开切换改 data.expanded + style 尺寸（两态手动尺寸保留在 data.collapsed*/expanded*）。
- **会话卡**：展开态嵌入 `SessionWorkbench`（ChatWindow），内部滚动用 `nowheel`，交互元素 `nodrag`。
- **新会话卡**：看板新建会话 = 带 UUID sessionId + cwd 非空；首条消息创建会话后由父节点清 cwd 转正。
- **改名**：内联输入 → PATCH /api/sessions/[id] → 事件桥刷左侧树。
- **节点 Handle**：连线端点（左 target / 右 source），exec/依赖线依赖它渲染。

## 看板内搜索（Ctrl+F）

- 常驻搜索框（画布顶部居中玻璃胶囊），遍历 RF nodes（会话卡标题 + 便笺正文），命中后 `setViewport` 居中 + accent 描边渐隐（BoardSearchContext 驱动）。纯前端，不落库。

## React Flow 集成要点

- **nodeTypes / edgeTypes 必须模块级常量**（引用不稳定 → 每次渲染重建，连接堆积）。
- **节点内交互**：可滚动容器加 `nowheel`（滚轮不缩放画布）、交互元素加 `nodrag`（不触发节点拖动）、`nopan`（不触发平移）。RF 不设全局 user-select:none → 便笺/消息文本选中复制天然可用（无需 tldraw 那套 hack）。
- **右键菜单**：onNodeContextMenu / onPaneContextMenu / onEdgeContextMenu 给坐标 → 自绘玻璃菜单（BoardContextMenu）。
- **删除语义**：Delete/Backspace → onBeforeDelete → 按节点类型确认制（会话/任务卡弹确认，便笺直接删）；派生边跳过（reconcile 补回）。
- **玻璃**：`useCardGlass` 内嵌模糊壁纸层（flowToScreenPosition 定位，替代 tldraw pageToScreen），数学同源。
- **节点 Handle 必须存在**，否则 RF 无法连 edge（报 error#008）。

## 派生边 reconcile 细节（board-reconcile）

- reconcile 读业务表 → mutateBoard（openDirectConnection.transact）→ Y.Doc 增量增删。
- 确定性 id：会话卡 `session-<sid>`、任务卡 `task-<cardId>`、exec 线 `exec-<cardId>-<sessionId>`、依赖线 `link-<from>-<to>-<kind>` → 幂等。
- 补卡落点：findFreeSpot（4 列布局，每行 4 卡逐行找空位）。
- 孤儿删：画布有、业务表无 → 删节点 + 级联删边（幂等，唯一执行者）。
- 前端 onEdgesChange 对 exec/依赖边跳过删除；后端 reconcile 负责一致性。
