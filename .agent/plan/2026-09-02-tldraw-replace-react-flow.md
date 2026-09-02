# 任务卡 #24：tldraw 替代 —— React Flow + yjs 数据层方案（rev2）

> 日期：2026-09-02　范围：pi-web-sky 看板
> 状态：**方案 rev2（已废弃 rev1 的乐观锁数据层；rev1 见 git 历史）**
> rev2 变化：数据层从「前端全量保存 SQLite + 乐观锁」改为「yjs CRDT 文档（每看板一个 Y.Doc）+ Hocuspocus（MIT）」。
> 原因：rev1 的乐观锁方案与「后台随时写业务表 + 前端 reconcile 补画布」模型根本冲突，会重蹈当年踩坑（用户指正）。

---

## 0. 结论先行

| 项 | rev2 方案 |
|---|---|
| 渲染层 | `@xyflow/react`（12.11.6，MIT）替换 tldraw |
| **数据层** | **`yjs`（13.6.32，MIT，CRDT）+ `@hocuspocus/server` + `@hocuspocus/provider`（4.6.0，MIT）** |
| 画布文档 | 每看板一个 Y.Doc（nodes: Y.Map + edges: Y.Map），SQLite 持久化（Hocuspocus onLoad/onStoreDocument） |
| 多端协同 | ✅ 保留 CRDT 文档级合并（两个浏览器同时编辑自动合并） |
| **派生元素权威** | **后端**：服务端读业务表 → 直接 mutate Y.Doc（增量 set/delete，永不全量覆盖）。调度器写业务表后立即触发派生 reconcile |
| 孤儿清理 | 后端权威做（读业务表 → 删 Y.Doc 中不在任务会话的卡），前端不再做 → 消除多端互相删卡 |
| 任务初始化 | 纯后台：建看板 + 补卡由服务端写 Y.Doc，不依赖前端加载时机 |
| 前端加载窗口期 | CRDT 语义保证：前端"本地空 state"不会覆盖后端已写文档 |
| 玻璃 | 保留现有方案（scrim + 卡片内嵌模糊壁纸层，useCardGlass 改 RF 坐标） |
| 事件兼容 | RF 原生 `nowheel`/`nodrag`/`nopan`，去掉 tldraw 事件 hack |

---

## 1. 为什么 rev1（乐观锁）是错的 —— 用户场景逐条对质

用户指出的三个场景，本质是同一个模型：
**业务真相源（后端写）→ 画布派生（前端 reconcile 补）→ 用户布局（前端写）**，三者需要「文档级增量合并」，任何一方都不能用全量快照覆盖另一方。

| 用户场景 | rev1（乐观锁全量保存）为何必死 | rev2（yjs CRDT）如何解决 |
|---|---|---|
| **① 前端建任务卡 → 后台派发建会话** | 调度器写业务表 `session_id`/`execStatus` 后，前端要「读业务表→更新画布节点→全量保存」。后台持续改业务表（10s tick），前端保存的 `baseUpdated` 永远过期 → 409 冲突到死 | 画布文档 = yjs。调度器写业务表后**后端直接 mutate Y.Doc**（`edgesMap.set("exec-...")`、补会话卡），不经过前端保存；前端 yjs 自动收到并渲染。**无乐观锁，无 409** |
| **② 任务初始化（纯后台）** | 建看板 + 补卡若等前端 reconcile 时机，前端加载窗口期（还没加载完画布就保存）会把后台刚建的卡覆盖 | 补卡是**后端权威动作**：服务端建看板后立即写 Y.Doc。前端打开时 yjs 拉取的是完整文档（含已补的卡），本地空 state 不覆盖远端（CRDT 合并语义） |
| **③ 多端并发（多浏览器同看板）** | 每端都在 reconcile + 全量保存，互相 409 / 覆盖，大家都刷新 | yjs CRDT：派生元素增删由**后端唯一权威**执行（确定性 id 幂等），前端只做用户布局增量，CRDT 自动合并。孤儿清理不再由各端各自跑 → 不互相删卡 |

**rev2 核心不变式**：
1. 业务表（task_cards/session_meta/tasks）= 唯一真相源，后端写
2. 派生元素（会话卡存在性/exec线/依赖线）= **后端 reconcile 从业务表投影到 Y.Doc**（确定性 id 幂等，缺补多删）
3. 用户内容（布局/尺寸/便笺文本）= 前端写 Y.Doc（增量 set，CRDT 合并）
4. 画布文档永远「增量合并」，**不存在全量快照覆盖** → 没有乐观锁、没有 409、没有重灌

---

## 2. 目标架构

```
                         ┌─────────────────────────────────────────────┐
                         │            Next.js server (同进程)           │
  Browser (RF 画布)      │                                             │
  ┌────────────────┐     │  ┌───────────────────────────────────────┐  │
  │ ReactFlow       │     │  │ @hocuspocus/server (内嵌, MIT)         │  │
  │ nodes/edges     │◄───►│  │  - 每看板一个 Document (Y.Doc)         │  │
  │  ← Y.Map/Y.Array│ ws  │  │  - onLoad/onStore → SQLite (sync.db)  │  │
  │  onNodesChange  │     │  │  - handleConnection ← server upgrade  │  │
  │   → Y.Map.set   │     │  └───────────────────────────────────────┘  │
  └────────────────┘     │             │ 直接 mutate Y.Doc              │
                         │             ▼                               │
                         │  ┌───────────────────────────────────────┐  │
                         │  │ 派生 reconcile（后端权威）               │  │
                         │  │  读 task_cards/session_meta/tasks      │  │
                         │  │  → 补会话卡 / exec线 / 依赖线 / 孤儿删   │  │
                         │  └───────────────────────────────────────┘  │
                         │             ▲                               │
                         │             │ 写业务表（真相源）              │
                         │  ┌───────────────────────────────────────┐  │
                         │  │ task-scheduler（调度器，10s tick）      │  │
                         │  │ 派发→建会话→session_id/execStatus      │  │
                         │  └───────────────────────────────────────┘  │
                         └─────────────────────────────────────────────┘
```

**server.mjs 变更**：upgrade 分流从 TLSocketRoom 换成 Hocuspocus `handleConnection`（拿 URL 里 boardId），HTTP 仍交 Next。与现有 `npm run dev` 单进程同端口保持一致。

**数据流（关键时序）**：
1. 调度器派发卡 → 写业务表 `session_id`/`execStatus` → **立即调派生 reconcile**
2. 派生 reconcile（后端）→ mutate Y.Doc：补会话卡（`session-<sid>`）+ 建 exec 线（`exec-<cardId>`）→ Hocuspocus 广播到所有连接客户端
3. 前端 yjs observe → setNodes/setEdges → 渲染
4. 用户拖卡 → onNodesChange → `nodesMap.set(id, {...position})` → CRDT 合并 + 广播 + SQLite 持久化

**孤儿清理（后端权威）**：reconcile 读 `/api/tasks/[id]` 的 sessionIds → Y.Doc 里存在但业务表没有的 session-card（非新会话卡 cwd 非空）→ 后端 delete。确定性、幂等、唯一执行者。

---

## 3. yjs 绑定模式（已验证，来自 synergycodes/reactflow-yjs-integration 开源实现）

```ts
// 画布文档：每看板一个 Y.Doc
const ydoc = provider.document;
const nodesMap = ydoc.getMap<Node>("nodes");   // id -> Node（含 position/style/data）
const edgesMap = ydoc.getMap<Edge>("edges");   // id -> Edge

// 前端编辑：增量写回 yjs（非整表覆盖）
const onNodesChange = useCallback((changes: NodeChange[]) => {
  const next = applyNodeChanges(changes, Array.from(nodesMap.values()));
  for (const c of changes) {
    if (c.type === "add" || c.type === "replace") nodesMap.set(c.item.id, c.item);
    else if (c.type === "remove" && nodesMap.has(c.id)) nodesMap.delete(c.id);
    else nodesMap.set(c.id, next.find((n) => n.id === c.id)!);
  }
}, [nodesMap]);

// yjs 变化 → 渲染
useEffect(() => {
  const obs = () => setNodes(Array.from(nodesMap.values()));
  obs();
  nodesMap.observe(obs);
  return () => nodesMap.unobserve(obs);
}, [nodesMap]);
```

**现有 tldraw 逻辑平移映射**：

| 现有（tldraw） | rev2（yjs + RF） |
|---|---|
| `useSync` + `TLSocketRoom` | `HocuspocusProvider` + `Hocuspocus server` |
| `editor.createShape({id:"session-<sid>"})` | 后端 `nodesMap.set("session-<sid>", {...})` |
| `editor.createShape(arrow) + createBindings` | `edgesMap.set("exec-<cardId>-<sid>", {...})`（custom edge） |
| `editor.deleteShapes(orphanIds)`（前端孤儿清理） | 后端 reconcile 读业务表 → `nodesMap.delete(id)` |
| `editor.updateShape(props)` | `nodesMap.set(id, {...props})` |
| `editor.centerOnPoint`（搜索定位） | `useReactFlow().setViewport({x,y,zoom})` |
| `editor.getViewportPageBounds`（新卡居中） | `useReactFlow().getViewport()` |
| 删除确认（deleteShapes 拦截） | 前端删 Y.Map + 调删除 API（确认制保留） |
| useCardGlass `pageToScreen` | `flowToScreenPosition`/`screenToFlowPosition` |

---

## 4. 实施计划

### Phase 1：数据层落地（yjs + Hocuspocus）
1. `package.json`：删 tldraw/@tldraw/*，加 `yjs` + `@hocuspocus/server` + `@hocuspocus/provider` + `@xyflow/react`
2. `lib/yjs-room-server.mjs`：Hocuspocus server 内嵌（每看板一个 Document，SQLite 持久化到 sync.db 或新建），`server.mjs` upgrade 分流改为 `handleConnection`
3. **后端派生 reconcile** `lib/board-reconcile.ts`：读业务表 → mutate Y.Doc（补卡/exec线/依赖线/孤儿删），确定性 id 幂等
4. 调度器 `dispatchCard` 写业务表后调派生 reconcile；`/api/tasks/[id]/board` 建看板后调补卡
5. 验证：任务看板打开，后端自动补卡/建线，多端 yjs 同步

### Phase 2：画布骨架（RF 替换 tldraw 渲染）
1. `CanvasStage.tsx` → ReactFlow（viewport/Background/Controls/拖放添加会话）
2. `useBoardCanvas.ts` 改造：useSync → HocuspocusProvider + Y.Map 绑定；删除前端孤儿清理（后端权威）
3. `SessionCanvas.tsx` 保持（scrim/搜索/悬浮按钮/看板名）

### Phase 3：自定义节点（卡片）
1. `SessionCardNode`：收合↔展开工作台（ChatWindow），NodeResizer，改名，玻璃
2. `StickyNoteNode`：markdown 便笺（nowheel 内部滚动）
3. `TaskCardNode`：编辑表单全量搬移（含各 picker）
4. 删掉 tldraw 事件 hack（copy 拦截/激活态/canScroll）

### Phase 4：连线 + 派生边 + 删除语义
1. RF edge：手绘线 + exec 线（虚线）+ 依赖线（实线 label=kind）
2. 删除语义：确认制 + 后端 reconcile 兜底（孤儿清理由后端权威做）

### Phase 5：搜索 + 右键菜单 + 工具栏
1. `BoardSearch`：collectSearchable 遍历 RF nodes + `setViewport` 定位 + 高亮
2. 自绘右键菜单（玻璃配方）
3. 自绘工具条：便笺/任务卡/连线/文本

### Phase 6：玻璃 + 打磨 + e2e
1. `useCardGlass` 适配 RF 坐标（数学不变）
2. 清理 tldraw CSS / 文档 / THIRD_PARTY_NOTICES
3. e2e 回归 + 多端协同验证

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 新增依赖（yjs/Hocuspocus/RF） | 全部 MIT（刚需满足）；yjs 2.3MB、Hocuspocus 小，tldraw 移除净减 |
| Hocuspocus 内嵌 Next 的升级分流 | 已验证 `handleConnection` API；与现 TLSocketRoom 同模式 |
| 后端派生 reconcile 与前端布局并发 | 派生元素确定性 id（`session-<sid>`/`exec-<cardId>`）与用户节点 id（UUID）不冲突；CRDT 合并 |
| 后端补卡时机 | 调度器写业务表即触发 reconcile；建看板即补卡；无窗口期依赖 |
| 便笺/文本选中复制 | RF 不设全局 user-select:none，天然无此问题 |
| RF attribution 水印 | MIT 免费版水印不能配置隐藏（`hideAttribution` 仅 Pro）——**决策点** |
| sync.db 旧 CRDT 数据 | 用户已确认不需要迁移（最后一步再说），新看板从 yjs 文档开始 |

---

## 6. 决策点（rev2 需确认）

1. **数据层用 yjs + Hocuspocus（CRDT，保留文档级合并）** —— 这是对 rev1 乐观锁的核心修正。同意？
2. **派生元素 reconcile 移到后端权威**（调度器写业务表即补卡/建线/孤儿删，前端不再做孤儿清理）—— 这是解决场景①③的关键。同意？
3. **RF attribution 水印**：MIT 免费版有右下角小 logo。选项 a. 保留（合规）b. CSS 隐藏（轻微违规）c. 买 Pro。建议 a 或 c。
4. **工具栏范围**：保留便笺/任务卡/连线/文本，去掉基础图形工具。同意？
5. **旧数据**：不做迁移（按你说的最后再说）。同意？

---

## 7. 工作量估计

| 阶段 | 预计 |
|---|---|
| P1 数据层（yjs+Hocuspocus+后端 reconcile） | 1.5 天 |
| P2 画布骨架 | 1 天 |
| P3 自定义节点（3 类卡） | 2 天 |
| P4 连线/reconcile/删除 | 1 天 |
| P5 搜索/右键/工具栏 | 1 天 |
| P6 玻璃/打磨/e2e/清理 | 1 天 |
| **合计** | **~7.5 天** |
