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
- 补会话卡（`session-<sid>`）、exec 线（`exec-<cardId>-<sessionId>`）、依赖线（`link-<from>-<to>-<kind>`）、fork 线（`fork-<parentSid>-<sid>`）——确定性 id 幂等，缺补多删，**绝不整表覆盖**。**任务卡不是派生元素**：它是用户画布内容（前端建/删），reconcile 只删「引用了已删业务卡」的孤儿节点。
- **任务卡派生对所有看板生效**（普通看板上的任务卡也派发执行，同样补执行会话卡 + exec 线）；**会话卡孤儿删仅任务看板**——普通看板的会话卡由用户拖入/新建管理（三个入口见下节），不因业务表无记录而删除。
- 孤儿删（业务表不存在的会话卡/任务卡节点）由后端唯一执行，前端不做 → 多端不互相删卡。
- 触发：调度器派发 / 建卡删卡 / 任务归属变化 / 任务初始化 / 10s 定时兜底（`board-reconcile-scheduler`，仅 leader 实例执行）。
- **任务初始化是纯后台动作**：`/api/tasks/[id]/board` 建看板后立即 reconcile 补已有会话卡，不依赖前端加载时机。

**前端职责**：用户内容（布局 / 尺寸 / 便笺文本 / 新建卡）+ **摘要字段**（标题 / 消息数 / lastReply / lastActivityAt）写 Y.Doc 增量；**高频运行态（phase / runningMs / execStatus）只走本地镜像不写 Y.Doc**；不做孤儿清理 / 派生 reconcile。

### 启动

```bash
npm run dev          # 单进程：HTTP + WS 同端口（yjs 房间内嵌，无需另起）
# 无独立 sync 进程；NEXT_PUBLIC_SYNC_WS 可覆盖前端连接地址（默认跟随当前 origin）
```

## 数据层铁律（yjs 版）

- **画布文档在 sync.db（yjs_documents）**，业务表在 pi-web.db。两库独立，业务进程写业务表，派生 reconcile 写画布。
- **前端编辑 = 增量 Y.Map.set**（按 id），无全量快照 / 乐观锁 / 409 / 重灌。
- **派生边**：exec 线（`data.execLink`）、依赖线（`data.taskLink`）、fork 线（`data.forkLink`）→ **禁删**（前端 onEdgesChange 跳过，后端 reconcile 兜底补回）。
- **孤儿卡删除**：后端 reconcile 删（业务表确认不存在 + 非新会话卡 cwd 非空）。
- **展示字段**：2.5s running 快照（phase/runningMs/execStatus，**本地镜像、不写 Y.Doc**）+ 5s 摘要（标题/消息数/lastReply）轮询 → 摘要写 Y.Map data，多端一致。

## 卡片即工作台（React Flow）

- 节点宽高由 `style.width/height` 控制；收合↔展开切换改 data.expanded + style 尺寸（两态手动尺寸保留在 data.collapsed*/expanded*）。
- **会话卡**：展开态嵌入 `SessionWorkbench`（ChatWindow），内部滚动用 `nowheel`，交互元素 `nodrag`。
- **新会话卡**：看板新建会话 = 带 UUID sessionId + cwd 非空；首条消息创建会话后由父节点清 cwd 转正。
- **改名**：内联输入 → PATCH /api/sessions/[id] → 事件桥刷左侧树。
- **节点 Handle**：连线端点（左 target / 右 source），exec/依赖线依赖它渲染。

## 会话入板（三个入口 + 出板）

会话卡进入画布有三条路，落点与归属规则不同——**归属必须先于落卡**，否则任务看板的 reconcile 会把这张卡当孤儿删掉：

| 入口 | 归谁写 | 落点 |
|---|---|---|
| 侧栏拖会话 → 画布 | `CanvasStage`（外层容器 capture 监听 drop）→ `board.addSessionNode` | 鼠标位置（`screenToFlowPosition`） |
| 侧栏拖会话 → 侧栏「看板」行 | `POST /api/boards/[id]/add-session`（**后端权威写**） | 服务端 `findFreeSpot` 找空位 |
| 工具栏拖出「会话卡」 | `board.addNewSessionCard` | 拖放点为中心（点击 = 视口中心）+ 级联偏移 |

- **拖到看板行为什么走后端**：目标看板可能根本没在当前页面打开（前端没有那个 Y.Doc），只有服务端能写。前端只管看板行的拖放视觉（accent 底色 + 左侧竖线，落卡成功后闪一下作受理反馈）。
- 任务看板（`board.taskId` 非空）两个拖入入口都**先写归属再落卡**：画布入口走 `addSessionNode` 内部，侧栏入口走 `assignSessionToTask()`，失败就不落卡（不留无保护窗口卡）。
- 侧栏入口**幂等**：画布已有同 sid 卡 → 不动（保留用户的布局/展开态），返回 `{ ok: true, added: false }`；重复拖同一会话不会把用户拖过位置重置。
- 系统「运行中」看板是虚拟视图（不落库、内容由运行态派生）→ 侧栏入口一律 403。
- 落卡 data 的 **`cwd` 必须留空**：非空在 reconcile 语义里 = 「新会话卡（会话还没创建）」，会被当成待创建占位处理。标题随拖拽源（`text/session-title`）带入，后续摘要轮询可覆盖。
- **出板**：把会话卡拖回侧栏的「临时会话」区 → `handleUnassignSession`（清归属，卡由 reconcile 清理）；删除画布上的执行会话卡 → `POST /api/task-cards/unbind` 清 `session_id`（否则 reconcile 立刻补回来）。

## 顶栏功能区与调度器面板

- **BoardTopbar（左上）**：看板名（只读，改名在侧栏看板行）+ 刷新 / 新建会话 / 磨砂调节 / 清空画布。看板全局共享：列表/新建/排序不再跟随选中目录（projectKey）变化。
- **进行中面板在左下角**（`BoardControls`，与缩放控制同区）：列出运行中 + 工作中（展开态）的会话卡，点击定位。
- **SchedulerPanel（右上）**：调度器状态面板——状态字加深，任务队列为具体任务可点击定位到画布对应卡。
- 缩放控制（Controls）在左下角，小地图留右下（带玻璃框：board-card-glass 背景 + 磨砂 + 1px 边框 + 圆角阴影）。

## 看板内搜索（Ctrl+F）

- 常驻搜索框（画布顶部居中玻璃胶囊），遍历 RF nodes（会话卡标题 + 便笺正文），命中后 `setCenter` 居中 + accent 描边渐隐（BoardSearchContext 驱动）。定位成功后经 `onViewportSave` 写回 yjs view map（与手动平移/缩放同一持久化通道），非「纯前端不落库」。

## 便笺编辑（TipTap WYSIWYG）

- **编辑态**：双击进入，TipTap WYSIWYG（ProseMirror 内核 + 官方 `@tiptap/markdown` 双向转换），无工具栏，所见即所得（复用 `.markdown-body` 观感）。
- **存储格式不变**：便笺文本永远是 markdown 字符串（yjs `data.text`），解析/序列化只在编辑态内存发生（`latestMdRef` 镜像），blur/Ctrl+Enter 不丢尾输入；Esc 取消、失焦自动保存（textarea 时代语义保留）。
- **实现**：TipTap 直接落在 `StickyNoteNode` 内（编辑态分支替换 textarea），不做受控反推（外源 text 只在进入编辑时重置）。设计见 `.agent/spec/2026-09-02-sticky-note-wysiwyg-design.md`。
- 非编辑态预览仍用 `react-markdown` + `.markdown-body`（`app/globals.css`）。

## React Flow 集成要点

- **nodeTypes / edgeTypes 必须模块级常量**（引用不稳定 → 每次渲染重建，连接堆积）。
- **节点内交互**：可滚动容器加 `nowheel`（滚轮不缩放画布）、交互元素加 `nodrag`（不触发节点拖动）、`nopan`（不触发平移）。RF 不设全局 user-select:none → 便笺/消息文本选中复制天然可用（无需 tldraw 那套 hack）。
- **右键菜单**：onNodeContextMenu / onPaneContextMenu / onEdgeContextMenu 给坐标 → 自绘玻璃菜单（BoardContextMenu）。
- **删除语义**：Delete/Backspace → onBeforeDelete → 按节点类型确认制（会话/任务卡弹确认，便笺直接删）；派生边跳过（reconcile 补回）。
- **玻璃**：`useCardGlass` 内嵌模糊壁纸层（flowToScreenPosition 定位，替代 tldraw pageToScreen），数学同源。
- **节点 Handle 必须存在**，否则 RF 无法连 edge（报 error#008）。

## 派生边 reconcile 细节（board-reconcile）

- reconcile 读业务表 → mutateBoard（openDirectConnection.transact）→ Y.Doc 增量增删。
- 确定性 id：会话卡 `session-<sid>`、exec 线 `exec-<cardId>-<sessionId>`、依赖线 `link-<from>-<to>-<kind>`、fork 线 `fork-<parentSid>-<sid>` → 幂等。
- 补卡落点：优先锚定锚点右侧（exec 卡锚任务卡、fork 卡锚源会话卡，`findSpotNearAnchor`），无锚点才回退 4 列 `findFreeSpot`。
- 孤儿删：画布有、业务表无 → 删节点 + 级联删边（幂等，唯一执行者）。
- 前端 onEdgesChange 对 exec/依赖/fork 边跳过删除；后端 reconcile 负责一致性。
