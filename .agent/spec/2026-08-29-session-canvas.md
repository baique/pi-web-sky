# pi-web · 会话看板（Session Canvas / Whiteboard）设计

> 日期：2026-08-29　范围：pi-web-sky　状态：调研完成，待用户确认
> 样式依据：`../2026-08-24-glass-standard.md` / `../2026-08-24-glass-spec.md`
> 数据层依据：`../2026-08-27-sidebar-tasks-search.md`（sqlite 旁路元数据 + 迁移机制）

---

## 0. 需求（用户原话收敛）

1. 在 pi-web 中提供一个**无界会话看板**（无限画布）。
2. 可**任意添加会话**到看板上（不限于某个项目/任务，但按项目隔离视图）。
3. 会话之间可**连线建立关系**（如：A 会话产生了 B 会话 / A 依赖 B / 承接关系等）。
4. 会话节点可**展开为对话面板**：交互输入消息、查看历史。
5. 画布支持**缩放、拖拽**（平移/移动节点）。
6. 最好还能**添加文字、图形、分组**（便签、注释、分组框）。

## 1. 结论

- **可行性高**。项目已有「旁路元数据」地基（`pi-web.db`：tasks / session_meta / pinned / FTS5 / 版本化迁移），看板是**第三种会话组织方式**（前两种：fork 树、任务分组），不动 `.jsonl` 文件，只新增元数据表。
- **画布引擎首选 tldraw 3**：无限画布、缩放/平移/对齐线/小地图、文字/图形/分组 shape 全部内置，自定义 shape 可内嵌 React（消息泡渲染 + ChatInput 发送）。
- **React Flow 为备选**：适合纯图/流程图场景，但文字、分组、便签都要自造，且官方已于 2025 归档。
- 详见 §4 选型对比。

## 2. 布局与入口

### 2.1 入口（侧边栏「会话」区域顶部）

```
┌──────────────────────────┐
│ 会话                 看板 │ ← 分段 tab（沿用 08-27 的玻璃 tab 设计）
├──────────────────────────┤
│ ▾ 任务 (2)        [+新任务]│
│   📁 登录重构             │
│     💬 设计接口           │
│  ─────────────────────   │
│  临时会话 (3)            │
│     💬 修 bug             │
└──────────────────────────┘
```

- 「看板」tab 与「会话」tab 同级（文件浏览器 tab 不动）。
- 看板 tab 内：**项目选择器**（当前 cwd 的项目 = 默认）+ **看板列表**（可建多个看板，默认一个「默认看板」）+ 看板缩略/入口卡片。
- 打开看板 → 主区域（ChatWindow 所在区域）切换为看板视图（AppShell 双栏右侧），不覆盖侧边栏。

### 2.2 看板主视图

```
┌────────────────────────────────────────────────────────┐
│ [← 返回] 看板名 ▾   [添加会话] [文字] [图形] [分组] [自动布局] [导出] │
├────────────────────────────────────────────────────────┤
│                                                        │
│   ┌─文字────────┐        ┌─── 分组框 ────────────────┐  │
│   │ 本次重构主线 │        │ │ ┌─会话节点────────┐   │  │
│   └─────────────┘        │ │ │ 登录接口重构     │   │  │
│                          │ │ │ ⏵ 32 条消息     │   │  │
│   ┌─会话节点────────┐    │ │ └──────────────────┘   │  │
│   │ 需求梳理        │    │ │ ┌─会话节点────────┐   │  │
│   │ ⏵ 12 条消息     │───→│ │ 数据库迁移       │   │  │
│   └────────────────┘     │ │ ⏵ 8 条消息       │   │  │
│                          │ └──────────────────┘   │  │
│                          └────────────────────────┘  │
│                                                        │
│  （无限画布：滚轮缩放 / 拖拽平移 / 节点拖拽 / 框选）     │
└────────────────────────────────────────────────────────┘
```

- 顶部工具栏：返回、看板切换/重命名、添加会话、文字/图形/分组工具、连线工具、自动布局、导出图片。
- 右侧小地图（tldraw 内置 MiniMap 风格）。

## 3. 核心交互

### 3.1 添加会话到看板

| 方式 | 操作 | 复用点 |
|------|------|--------|
| 侧栏会话行「⋮」菜单 | 「添加到看板」→ 选目标看板 | 现有 SessionSidebar 行菜单 |
| 拖拽 | 会话行拖入看板视图（`text/session-id`） | 复用 08-27 原生 HTML5 DnD 模式 |
| 看板内 | 「添加会话」→ 搜索/选择已有会话；或「新建会话」→ 复用新建流程后落画布 | `pendingNewSessionTaskIdRef` 同款延迟绑定 |

- 同一会话可存在于多个看板 / 多次放置（各自独立位置，共享同一 jsonl 内容）。

### 3.2 连线建立关系

- 节点边缘拖出连线（tldraw 自定义 shape 的 handle 机制）或选中节点后「连接」工具点击目标。
- 连线属性：颜色、线型（实线/虚线/箭头方向）、标签文字（如「fork 自」「依赖」）。
- 连线是纯元数据（`board_edges` 表），不影响 jsonl 内容。

### 3.3 展开对话面板

- **双击会话节点** → 在画布上方（或右侧浮层）展开对话面板。
- 面板内容：完整复用现有 `MessageView` 渲染历史 + `ChatInput` 输入框（走现有 `useAgentSession` / `/api/agent/[id]` + SSE，聊天逻辑零改造）。
- 面板可拖拽移动、缩放；关闭后回到画布。
- 节点徽标：运行中（从 `/api/agent/running` 轮询）、未读、消息数、最后活动时间（同侧栏信息）。

### 3.4 缩放 / 拖拽

- 滚轮缩放、空白处拖拽平移、节点拖拽、框选多选、对齐线吸附（tldraw 内置，零开发）。
- 键盘：Delete 删除节点/连线（仅删元数据，不删会话）、Cmd/Ctrl+D 复制节点、方向键微调。

## 4. 画布引擎选型

| 维度 | tldraw 3 | React Flow (xyflow) | 自研 |
|------|----------|---------------------|------|
| 无限画布/缩放/平移 | ✅ 内置 | ✅ 内置 | 成本高 |
| 对齐线/吸附/框选 | ✅ 内置 | ⚠️ 需插件/自写 | 成本高 |
| 文字/便签/图形/分组 | ✅ 原生 shape | ❌ 全部自造 | 成本高 |
| 自定义节点（会话泡/消息嵌 React） | shape 机制 + `ShapeUtil` 内嵌 React | ✅ 强项（custom node） | — |
| 小地图 | ✅ 内置 | ✅ 内置 | — |
| 持久化快照 | 有（但本项目走自建表） | 无 | — |
| 协作 | 内置（本项目不需要） | 无 | — |
| 体积 | ~1MB（可 tree-shake，全量才这个数） | 较小 | — |
| 维护状态 | 活跃（2025-2026 主推 v3） | 2025 已归档，社区 fork 活跃 | — |
| 适配本项目 | 消息泡/会话节点走自定义 shape | 会话节点 custom node + 便签/分组自造 | 不推荐 |

**结论：tldraw 3 首选**。React Flow 归档且缺文字/分组，自研不划算。

## 5. 数据层（持久化）

### 5.1 设计原则

- 对齐 08-27 铁律：**会话 jsonl 原地不动，组织/关系一律旁路元数据**。
- 复用 `lib/sqlite-db.ts` 的 `DatabaseSync` 单例 + 版本化迁移机制（`SCHEMA_VERSION` 2 → 3）。
- 数据层 lib 保持 **SDK-free**（参照 `task-store.ts`），`.mjs` 测试不写 TS 类型注解。

### 5.2 Schema（新增）

```sql
-- 看板：按项目隔离（project_key = workspaceKeyOf(cwd)），与任务一致
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_key);

-- 画布元素：会话节点 / 文字 / 图形 / 分组框 统一一张表
-- kind: session | text | shape | group
-- ref_id: kind=session 时为会话 id，其余为 tldraw shape id
-- x/y/w/h 为画布坐标（世界坐标）；props 存 JSON（文字内容、颜色、样式、分组成员等）
CREATE TABLE IF NOT EXISTS board_nodes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- session | text | shape | group
  ref_id     TEXT,                      -- sessionId 或 shapeId
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  w          REAL NOT NULL DEFAULT 0,
  h          REAL NOT NULL DEFAULT 0,
  props      TEXT NOT NULL DEFAULT '{}',-- JSON
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_nodes_board ON board_nodes(board_id);

-- 连线：会话↔会话 / 会话↔便签 等
CREATE TABLE IF NOT EXISTS board_edges (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  from_id  TEXT NOT NULL,               -- board_nodes.id
  to_id    TEXT NOT NULL,               -- board_nodes.id
  label    TEXT,
  color    TEXT,
  dashed   INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_edges_board ON board_edges(board_id);
```

- 迁移追加到 `MIGRATIONS`（version 3，名称如 `session boards`），老库自动补齐。
- 会话被删除（jsonl 消失）：`board_nodes.ref_id` 指向失效会话 → 节点标记「失效」（灰化 + 角标），提供「清除失效节点」批量操作；不自动删，保留用户布局。

### 5.3 API

```
GET    /api/boards?projectKey=         列表
POST   /api/boards                     { projectKey, name }
PATCH  /api/boards/[id]                改名
DELETE /api/boards/[id]                删除（级联删 nodes/edges）

GET    /api/boards/[id]/canvas         整张画布（nodes+edges+view）
PUT    /api/boards/[id]/canvas         全量保存（防抖合并写，简化一致性问题）
POST   /api/boards/[id]/nodes          添加节点（kind/refId/x/y）
PATCH  /api/boards/[id]/nodes/[nid]    移动/改属性
DELETE /api/boards/[id]/nodes/[nid]
POST   /api/boards/[id]/edges          加连线
DELETE /api/boards/[id]/edges/[eid]
```

- 会话节点展示所需摘要（标题/消息数/最后活动/运行态）由现有 `listAllSessions()` + `/api/agent/running` 提供，看板 API 只存布局。

## 6. 前端结构

```
components/canvas/
  SessionCanvas.tsx        看板视图容器（挂载 tldraw，Toolbar 装配）
  BoardList.tsx            看板 tab 列表（侧栏内）
  SessionCardShape.tsx     自定义 shape：会话节点卡片（标题/徽标/摘要）
  SessionCardUtil.ts       自定义 ShapeUtil（handle 出线、双击展开、拖拽）
  TextNoteShape.tsx        文字/便签 shape（tldraw 原生 text 二次包装）
  GroupBoxShape.tsx        分组框 shape（tldraw 原生 group 二次包装）
  CanvasEdgeShape.tsx      连线 shape（标签/箭头/样式）
  SessionChatPanel.tsx     展开的对话面板（复用 MessageView + ChatInput）
  CanvasToolbar.tsx        顶部工具栏
  CanvasMiniMap.tsx        小地图（tldraw 内置）
lib/
  board-store.ts           SDK-free：boards/nodes/edges CRUD（对照 task-store）
  board-types.ts           看板类型定义（客户端可用）
hooks/
  useBoardCanvas.ts        画布加载/保存防抖/会话摘要注入
```

- tldraw 以 `next/dynamic` 动态加载（ssr:false，参照 TerminalPanel 的 xterm 做法），避免 SSR 问题与首屏体积。
- 消息泡复用现有 `MessageView`；输入复用 `ChatInput` 逻辑（抽一个可内嵌的输入组件，避免与主聊天区耦合）。

## 7. 阶段划分

### P0 — 最小闭环（核心价值）
1. sqlite 迁移 v3 + `board-store.ts` + 看板 API
2. 侧栏「看板」tab + 看板列表 + 新建看板
3. tldraw 集成（`SessionCanvas` 动态加载，缩放/平移/节点拖拽/框选）
4. 会话节点自定义 shape：拖入/按钮添加会话、双击展开对话面板（消息历史 + 输入）
5. 连线 shape：节点间连线、标签/箭头/颜色
6. 全量保存/加载（防抖写 `PUT /canvas`）

### P1 — 体验增强
- 小地图、对齐线微调、多选批量操作（删除/移动/对齐）
- 文字便签、基础图形（矩形/椭圆/箭头）、分组框（成员高亮、整体拖动）
- 连线样式编辑（颜色/线型/箭头/标签编辑）
- 节点运行态徽标、消息数、最后活动时间实时刷新
- 多个看板 + 重命名 + 删除（含确认）

### P2 — 锦上添花
- 自动布局（d3-force 力导向，参照 React Flow force-layout 示例）
- 看板导出图片（html-to-image）
- 「新建会话并落到画布」一键流
- 失效会话节点清理、会话重命名联动
- 看板搜索/快速定位（Ctrl+F 定位节点）
- 看板内 mini 聊天（不弹窗，画布内嵌小窗）

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| tldraw 3 大版本较新，文档/示例少 | 自定义 shape 开发踩坑 | P0 先行技术验证（§9）；参考 tldraw 官方 custom-shape 示例与 `examples` 仓库 |
| 会话消息泡嵌 shape 的渲染性能 | 大会话节点卡顿 | 节点只显示摘要，消息泡仅在展开面板渲染；节点内容 memo |
| 画布保存竞态（多标签/多设备） | 布局丢失 | 全量保存 + 单飞请求（参照 `listAllSessions` 的 coalescing 模式）；updated 时间戳乐观锁 |
| 体积增大 ~1MB | 首屏变慢 | `next/dynamic` + 按需加载；仅在进入看板时下载 |
| 与 tldraw 内部状态同步 | 外部添加节点/拖拽冲突 | 全量画布 → tldraw 快照（`store.serialize()`）→ 增量事件回写 db |

## 9. P0 技术验证（进入开发前先做）

1. 本地起 demo（或直接在项目里搭分支）：tldraw 3 + 自定义 `ShapeUtil`，渲染一个「会话卡片」（标题 + 消息数 + 状态点）。
2. 验证双击 shape 打开浮层（React portal），浮层内渲染现有 `MessageView` + 简单输入框，不破坏画布交互。
3. 验证连线 handle 拖拽 + 标签/箭头。
4. 验证 `store.serialize()` / `loadSnapshot` 与 sqlite 全量保存的往返。
5. 验证 `next/dynamic` ssr:false 下 tldraw 正常（Next 16）。

## 10. 开放问题（待用户确认）

1. 看板是否**跟随项目**（projectKey 隔离，与任务一致）还是**全局**？
2. 会话节点展开交互：**双击弹层** vs **画布内嵌面板**（类似 Figma 注释窗）？
3. 连线关系是否需要**语义类型**（fork/依赖/承接/自定义）还是纯自由标签？
4. P0 是否包含**文字/图形/分组**（若含，则 tldraw 原生能力直接送）还是先只做会话节点+连线？
