# pi-web · 会话看板 v2（卡片即工作台）设计细化

> 日期：2026-08-29　范围：pi-web-sky　状态：细化完成（**v2 替代** `2026-08-29-session-canvas.md`）
> 依据：用户 2026-08-29 反馈（5 点）+ v1 调研 + `../2026-08-24-glass-spec.md`（毛玻璃规范）+ `../2026-08-27-sidebar-tasks-search.md`（sqlite 旁路元数据地基）
> 与 v1 关键差异：**状态系统提前到本期核心**、**多看板含系统"运行中"看板**、**卡片展开即工作台（非弹窗）**、**tldraw 版本锁定 5.x**（v1 写的 3 已过时）

---

## 0. 用户反馈 → 设计决策对照

| # | 用户反馈 | v1 原方案 | v2 决策 |
|---|----------|-----------|---------|
| 1 | 会话状态**必须**本期完成 | 运行态徽标放 P1 | 状态系统进 P0 核心：运行中/等待输入/工具执行/空闲/刚结束 全量状态 + 实时更新 |
| 2 | 多看板管理**必要**，默认提供"运行中"看板，自动展示所有运行中任务 | P1 才做多看板 | 本期做 boards CRUD；系统级「运行中」看板默认存在、不可删除，**跨项目自动聚合**所有运行中会话 |
| 3 | 进入看板后消息区域被画布替代，上方或下方加一栏：看板信息/看板切换/工具按钮 | 画布替换主区域，工具在画布内顶部 | 同：看板模式**整体替换** ChatWindow 区域；画布上方固定「看板栏」（返回 / 看板名+切换 / 工具按钮） |
| 4 | **不是**双击进会话，而是**展开卡片**：扩展卡片本身宽高，把会话核心区域所有功能嵌入其中；至少 = 主体消息 + 输入组件 + 底栏部分功能；保留独立统计信息、底栏 widget + 通知；**不需要终端**；核心原则：**卡片即工作台** | 双击弹浮层面板（会话泡嵌 shape） | 卡片两态：收合卡 ↔ 展开工作台（**同一卡片放大**，非弹窗）；工作台 = 消息 + 输入 + 底栏（widget 区 + 通知 / quota）+ 统计入口；无终端 |
| 5 | 美观重中之重，不可忽略 | 一般性提及 | 全量套 glass 规范 + 统一动效语言（§7），明暗主题×壁纸×减弱透明四象限目测 |
| 6 | 底栏保留 widget 区 | 未涉及 | 卡片底栏左侧保留**扩展 widget 区**（pi-todo / MCP / subagent = 现有 `ExtensionStatusBar` 左侧），右侧通知 + quota；去掉终端按钮 |

## 1. 范围界定（本期 P0）

**做：**
1. 数据层：`boards / board_nodes / board_edges / board_view` 表 + 迁移 v3 + `lib/board-store.ts`（SDK-free）+ 看板 API
2. 侧栏：看板入口 + 看板列表（含系统「运行中」看板）+ 新建 / 改名 / 删除 / 切换
3. 画布：tldraw 5.x 集成（`next/dynamic` ssr:false），无限画布 / 缩放 / 平移 / 框选 / 多选 / 对齐线
4. 会话节点 shape：收合卡 + 展开工作台（卡片即工作台，§3）
5. 连线：节点间连线 + 颜色 / 线型 / 箭头 / 标签（纯元数据）
6. **状态系统**：全量状态 + 实时更新 + orb 动效 + 运行中看板（§4）
7. 持久化：防抖全量保存 + 加载 + 失效节点清理
8. 打磨：glass 规范、统一动效、i18n、lint / typecheck / 必要功能测试 + e2e

**明确不做（YAGNI，留给后续迭代）：**
- 文字便签 / 图形 / 分组框 / 自动布局 / 导出图片 / 协作
- 终端嵌入卡片
- 自研画布引擎

## 2. 布局

### 2.1 侧栏入口（会话 tab 增加「看板」分段）

```
┌──────────────────────────┐
│ 会话   看板         文件  │ ← 三段分段 tab（沿用 SessionTabs 玻璃胶囊设计）
├──────────────────────────┤
│ 看板 tab（仅此侧显示）    │
│ ── 系统 ──              │
│   ● 运行中 (3)           │ ← 系统看板，跨项目聚合，不可删除
│ ── 项目 · <cwd 项目名> ──│ ← 按 projectKey 隔离，与任务一致
│   ☰ 默认看板             │ ← 首次进入自动创建
│   ☰ 登录重构             │
│   [+ 新建看板]            │
└──────────────────────────┘
```

- 看板行：名称 + 节点数；悬停 [改名] [删除]（删除需确认，级联删 nodes/edges）。
- 点「运行中」或某个看板 → 主区域切换为看板模式（AppShell 双栏右侧整体替换 ChatWindow，不覆盖侧栏）。

### 2.2 看板模式主区域（进入看板后）

```
┌──────────────────────────────────────────────────────────────┐
│ [← 返回]  ▾看板名    ●运行中(3)   [+ 新建] [改名] [删除]       │ ← 看板栏（chrome 材质）
│ [＋添加会话] [╱连线] [⟲自动布局] [🗑清理失效]                   │ ← 工具行（chrome 材质，同栏第二行）
├──────────────────────────────────────────────────────────────┤
│  ┌ 收合卡 ──────────┐      ┌ 展开工作台 ──────────────────┐  │
│  │ ● 登录接口重构    │      │ ● 数据库迁移                │  │
│  │ 32 条消息 · 2m    │─────▶│  (消息区 / 输入 / 底栏)      │  │
│  └──────────────────┘      └─────────────────────────────┘  │
│                        （无限画布：滚轮缩放 / 空白拖拽平移    │
│                          / 节点拖拽 / 框选 / 对齐线吸附）     │
└──────────────────────────────────────────────────────────────┘
```

- **看板栏**：返回（退回普通聊天模式）、看板名下拉切换、运行中徽标、新建 / 改名 / 删除；工具行：添加会话、连线工具、自动布局（本期不做则置灰）、清理失效节点。
- 画布缩放控件用小地图 + tldraw 自带左下角 zoom 控件；右侧小地图（tldraw 内置 MiniMap 风格）。
- 看板模式**不渲染** ChatWindow（消息区被画布替代）；侧栏保持可见（会话 / 文件 tab 可自由切换）。

## 3. 卡片两态（核心：卡片即工作台）

### 3.1 收合态

- 默认尺寸 280×120，圆角 14，`--panel-glass` 材质 + `--glass-blur-panel`。
- 内容（上→下）：状态行（orb + 状态文字 + 运行时长）· 标题（粗体，截断）· 元信息行（项目名 / 消息数 / 最后活动）。
- 交互：画布内拖拽移动；四角手柄拉伸改尺寸；**单击选中**（accent 描边环）；**双击展开**；悬停浮现 [展开] [添加会话到任务] [从看板移除]。
- 状态徽标：运行中（orb breathing/working + 状态文字）、等待输入（⌨ 待输入）、空闲（无 orb）、刚结束（脉冲 1 次）。

### 3.2 展开态（卡片即工作台）

- **同一张卡片**放大（默认 760×600，四角可继续拉伸，最小 520×420），画布上保留卡片外框 + 标题栏 + 状态条（占位视觉，可继续被拖动 / 连线 / 框选）。
- 工作台内容以 **portal 浮层**渲染于画布之上（§3.3），与画布上的卡片轮廓**视觉无缝**（同边框同圆角同材质，肉眼视为同一张卡）。
- 工作台内部结构（自上而下）：

```
┌ 卡片顶栏 ────────────────────────────────────────────────┐
│ ● 运行中 · 2m   数据库迁移                  [统计] [收合] [✕] │
├ 消息区 ─────────────────────────────────────────────────┤
│  （复用 MessageView 渲染 + chat-lazy-load + 滚动 + 自动滚动）│
├ 输入区 ─────────────────────────────────────────────────┤
│  （复用 ChatInput 完整组件：textarea / 发送 / abort-steer-  │
│    follow-up / 模型选择 / thinking / tools 预设 / 压缩）    │
├ 底栏 ───────────────────────────────────────────────────┤
│  （通知 NoticeDrawer + 常驻 quota + 上下文用量条）    │
└─────────────────────────────────────────────────────────┘
```

- **保留独立统计**：卡片顶栏「统计」按钮 → 浮层展示 `SessionStatsInfo`（tokens 输入/输出/缓存、cost、消息数、活跃时长），复用 AppShell 统计面板的样式语言，portal 到 body 锚定按钮。
- **底栏 = 现有 ChatWindow 底栏裁剪版（widget + 通知 + quota）**：左侧**复用 `ExtensionStatusBar` 的 widget 区与扩展状态文本**（pi-todo / MCP / subagent 等扩展在此显示，用户明确要保留）；右侧 = 通知（NoticeDrawer + 历史）+ 常驻 quota（QuotaView，额度/上下文）+ 上下文用量条。
- **不要**：终端按钮（ExtensionStatusBar 的 `tools` slot 不传）、终端面板。

> 注：用户反馈「底栏 weight」实为 **widget**（拼写误差），指终端左边显示 pi-todo / MCP / subagent 的扩展 widget 区 —— 即 `ExtensionStatusBar` 左侧。卡片底栏整体复用该组件（tools 传 undefined 去掉终端按钮，notice 传通知 + quota）。

### 3.3 缩放适配与 portal（关键技术决策）

画布允许滚轮缩放（zoom 20%~400%），若工作台直接渲染在画布 transform 内，消息文字会随缩放不可读。对策：

1. **展开态工作台 = portal 浮层**，挂载在画布容器之上的 overlay 层（不受画布 transform 影响），位置由卡片世界坐标换算屏幕坐标（`editor.pageToScreen`）驱动。
2. **反补偿保持恒常 UI 尺寸**：浮层内容按 `1/zoom` 反向缩放（`transform: scale(1/zoom)`），视觉尺寸不随画布缩放变化；滚动、输入、下拉浮层交互完全正常（不受画布 transform 干扰）。
3. **zoom < 60% 自动降级**：工作台内容收起为「骨架态」（仅标题 + 状态 + 提示"放大画布以展开交互"），避免内容缩到不可读；zoom ≥ 60% 恢复完整交互。
4. 拖动卡片时浮层位置 rAF 跟随（不阻塞主线程）；展开/收合有 200ms ease-out 过渡（interruptible，见 §7）。
5. 多张展开卡片并存：各自独立 portal 浮层，互不干扰（同一会话 id 只允许一张展开卡，重复展开聚焦已有卡）。

## 4. 会话状态系统（本期核心）

### 4.1 状态源

- **运行中集合**：现有 `GET /api/agent/running`（`getRunningRpcSessionIds()`，侧栏已按 2.5s 轮询）。
- **细分状态**（本期新增）：扩展 `/api/agent/running` 响应为 `{ runningSessionIds: string[], states: { [id]: { phase, state, model, startedAt } } }`；`lib/rpc-manager.ts` 新增 `getRunningSessionStates()`，从各 `AgentSessionWrapper.inner` 读取 `phase` / `state` / `model` / `startedAt`。
- 状态值对齐 pi 既有枚举：`waiting_model` / `running_tools` / `running_command` / `waiting_input` 等（读 `AgentSessionState` 类型），映射见 4.2。

### 4.2 状态展示

| 状态 | 展示 |
|------|------|
| `waiting_model` | orb `breathing` + "思考中…" |
| `running_tools` / `running_command` | orb `working` + "执行工具/命令" |
| `waiting_input` | ⌨ 图标 + "等待输入" |
| 空闲 | 无 orb，灰点 |
| 刚结束（≤30s） | 脉冲高亮 1 次 + 可选完成音效（复用 useAudio） |

- orb 用 `thinking-orbs`（0.3.1）：**必须显式传** `theme={isDark ? "dark" : "light"}`（useTheme().isDark），浅色下 `filter: brightness(0.57) contrast(1.15)`；尺寸一律 20。
- 状态刷新：看板打开期间轮询 `/api/agent/running`（沿用 2.5s、后台 tab 暂停策略）+ 展开卡内 `useAgentSession` 自带 SSE 事件为准（避免双源打架：**卡片内状态以 SSE 为准，看板聚合态以轮询为准**）。

### 4.3 「运行中」系统看板

- 系统看板 id 固定（如 `__running__`），**不落 boards 表**（或落库但标记 `system=1`，见 §5），不可改名 / 删除 / 手动添加节点。
- 内容 = **自动聚合**：轮询运行时把每个运行中会话实时物化为收合卡片（可展开工作台直接交互），按运行开始时间排序；会话结束后卡片保留 30s（灰化"已结束"）后自动消失。
- 看板名旁显示 `(N)` 运行数徽标，全局跨项目计数。

## 5. 数据层

### 5.1 Schema（追加迁移 v3）

对齐 08-27 铁律：**会话 jsonl 原地不动，组织/关系一律旁路元数据**。复用 `lib/sqlite-db.ts` 的 `DatabaseSync` 单例 + 版本化迁移（`SCHEMA_VERSION` 2 → 3）。

```sql
CREATE TABLE IF NOT EXISTS boards (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,  -- 1 = 运行中看板（只读元数据）
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_key);

CREATE TABLE IF NOT EXISTS board_nodes (
  id         TEXT PRIMARY KEY,
  board_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- session | text | shape | group（本期只落 session）
  ref_id     TEXT,                      -- sessionId（kind=session）
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  w          REAL NOT NULL DEFAULT 0,
  h          REAL NOT NULL DEFAULT 0,
  expanded   INTEGER NOT NULL DEFAULT 0, -- 展开态（工作台）标记
  props      TEXT NOT NULL DEFAULT '{}', -- JSON：标题色/固定状态等
  created    INTEGER NOT NULL,
  updated    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_nodes_board ON board_nodes(board_id);

CREATE TABLE IF NOT EXISTS board_edges (
  id       TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  from_id  TEXT NOT NULL,               -- board_nodes.id
  to_id    TEXT NOT NULL,
  label    TEXT,
  color    TEXT,
  dashed   INTEGER NOT NULL DEFAULT 0,
  created  INTEGER NOT NULL,
  updated  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board_edges_board ON board_edges(board_id);

CREATE TABLE IF NOT EXISTS board_view (
  board_id   TEXT PRIMARY KEY,
  camera_x   REAL NOT NULL DEFAULT 0,
  camera_y   REAL NOT NULL DEFAULT 0,
  camera_z   REAL NOT NULL DEFAULT 1,
  updated    INTEGER NOT NULL
);
```

- 迁移追加到 `lib/sqlite-db.ts` 的 `MIGRATIONS`（version 3，name `session boards`），老库自动补齐。
- 会话被删除（jsonl 消失）：`board_nodes.ref_id` 失效 → 节点灰化 + 「失效」角标，「清理失效节点」批量移除。

### 5.2 API

```
GET    /api/boards?projectKey=          列表（含 is_system；system 看板始终返回）
POST   /api/boards                      { projectKey, name }
PATCH  /api/boards/[id]                 改名（system 看板 403）
DELETE /api/boards/[id]                 删除（级联删 nodes/edges/view；system 看板 403）

GET    /api/boards/[id]/canvas          整张画布（nodes+edges+view camera）
PUT    /api/boards/[id]/canvas          全量保存（防抖合并写，单飞请求）
POST   /api/boards/[id]/nodes           添加节点（kind/refId/x/y/w/h/expanded）
PATCH  /api/boards/[id]/nodes/[nid]     移动/改属性/展开标记
DELETE /api/boards/[id]/nodes/[nid]
POST   /api/boards/[id]/edges           加连线
DELETE /api/boards/[id]/edges/[eid]
```

- 会话摘要（标题/消息数/最后活动）由现有 `listAllSessions()` + `/api/agent/running` 提供；看板 API 只存布局与状态标记。
- 并发：全量保存 + 单飞请求（参照 `listAllSessions` coalescing 模式）；`updated` 时间戳乐观锁。

## 6. 组件与文件地图

```
lib/
  sqlite-db.ts              Modify：SCHEMA_VERSION → 3 + MIGRATIONS 追加 v3
  board-store.ts            Create：boards/nodes/edges/view CRUD（SDK-free，对照 task-store）
  board-types.ts            Create：看板类型定义（客户端可用）
  rpc-manager.ts            Modify：getRunningSessionStates()
app/api/agent/running/route.ts  Modify：响应加 states 细分
app/api/boards/route.ts · app/api/boards/[id]/route.ts
app/api/boards/[id]/canvas/route.ts · .../nodes/route.ts · .../nodes/[nid]/route.ts · .../edges/route.ts · .../edges/[eid]/route.ts

components/canvas/
  SessionCanvas.tsx         Create：看板模式容器（tldraw + 看板栏 + 工具行 + 浮层宿主）
  BoardList.tsx             Create：侧栏看板列表（含运行中系统看板）
  SessionCardShape.tsx      Create：收合卡 shape 渲染（标题/状态/元信息）
  SessionCardUtil.ts        Create：自定义 ShapeUtil（双击展开、拖拽、拉伸、出线 handle）
  WorkbenchOverlay.tsx      Create：展开态工作台浮层（portal + 反补偿缩放 + 位置跟随）
  SessionWorkbench.tsx      Create：工作台本体（卡片顶栏 + 消息区 + 输入区 + 底栏 + 统计浮层）
  CanvasToolbar.tsx         Create：看板栏 + 工具行
  CanvasEdgeShape.tsx       Create：连线 shape（标签/箭头/样式）
hooks/
  useBoardCanvas.ts         Create：画布加载/保存防抖/状态轮询/运行中看板聚合
  useRunningStates.ts       Create：/api/agent/running 细分状态轮询
```

- **复用边界（重要）**：`SessionWorkbench` 内嵌复用 `MessageView`（消息渲染）、`chat-lazy-load`（懒加载）、`ChatInput`（完整组件，传必要 props）、`NoticeDrawer` + `QuotaView`（底栏）、`useAudio`（完成音效）。`useAgentSession` 是否可直接复用于卡片：**实施第一步先做复用可行性验证**（读其 props/依赖，确认与 AppShell 解耦程度）；若耦合过深，抽 `useSessionMessages` 核心子集给工作台 + ChatWindow 共用，避免双实现。
- tldraw 以 `next/dynamic` ssr:false 动态加载（参照 TerminalPanel xterm 做法）；体积 ~1MB 仅在进入看板时下载。

## 7. 视觉与动效（美观，重中之重）

**玻璃规范（强制）：**
- 看板栏 / 工具行 = chrome 材质（`--frame-glass` + `--glass-blur-heavy` + `var(--glass-saturate)`）。
- 收合卡 = L-panel 材质（`--panel-glass` + `--glass-blur-panel`）；展开工作台外壳与卡片同材质，内部消息/输入沿用现有气泡与 composer token（`--bubble-*`、`--frame-glass`）。
- 禁用硬编码 rgba/px 玻璃值；新面板走 `--panel-glass` / `.glass-popover` 配方；`prefers-reduced-transparency` / `prefers-contrast` 降级自动生效（引 token 即得）。
- 浮层若浮在画布之上但**不贴栏** → `.glass-popover` 配方（统计浮层）；贴画布下方（卡片底栏无浮层）不涉及顶栏 containing-block 坑。

**动效语言（统一，interruptible）：**
- 收合 ↔ 展开：200ms ease-out（scale + 圆角 + 阴影同步过渡），中途可打断（CSS transition 天然可中断；portal 浮层位置用 rAF 跟手）。
- 卡片被拖拽：带弹性缓动（略滞后于指针，`transition: transform 60ms ease-out`）；松手回正。
- 状态切换：orb 用 thinking-orbs 内置动画；"刚结束"脉冲 1 次（keyframes 120ms 高亮环）。
- 选中环：accent 描边 + 2px 外发光（`box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent)`）。
- 尊重 `prefers-reduced-motion`：全部动效降级为 0ms / 纯透明度。

**主题验收四象限**：浅色 × 深色 × 壁纸开 × 系统"减弱透明/高对比"，观感一致方可交付。

## 8. 里程碑（实施顺序，每完成一个停下汇报）

- **M0 数据层 + API**：迁移 v3 + board-store + boards/canvas/nodes/edges API + running states（含测试：`lib/board-store.test.mjs` 事务回滚、`app/api/boards/*-route.test.mjs`）
- **M1 侧栏看板入口**：SessionTabs 加「看板」段 + BoardList（列表/新建/改名/删除/系统看板）+ 进入看板模式的路由与布局切换（AppShell）
- **M2 画布 + 收合卡 + 连线**：tldraw 集成（dynamic ssr:false）+ SessionCardShape/Util（收合态）+ 拖放添加会话 + 连线 + 持久化（防抖 PUT /canvas）+ 失效清理
- **M3 卡片工作台**：WorkbenchOverlay（portal + 反补偿 + 位置跟随）+ SessionWorkbench（消息/输入/底栏/统计）+ useAgentSession 复用验证与抽取
- **M4 状态系统 + 运行中看板**：running states API 接入 + 卡片状态徽标 + 运行中系统看板自动聚合
- **M5 打磨**：动效语言统一、四象限主题目测、i18n 补全、`npm test` / `tsc --noEmit` / `npm run lint` 全绿、playwright e2e（建看板→添加会话→展开工作台发消息→状态刷新→刷新页面布局不丢）

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| tldraw 5.x 较新，自定义 shape API 与 v1 调研的 3.x 有差异（3→5 breaking 集中在 collaborator user-id 类型，ShapeUtil 主体稳定） | M2 先做 20 分钟技术验证（tldraw@5 + react19 + Next16 + dynamic ssr:false + 自定义 shape 渲染 1 张卡），验证通过再铺开 |
| 工作台 portal 浮层与画布坐标同步（拖动/缩放时错位） | 统一走 `editor.pageToScreen` 换算 + rAF 跟手；展开卡拖动时浮层不阻塞主线程；M3 单测 + e2e 验证 |
| `useAgentSession` 与 AppShell 耦合深，卡片复用成本高 | M3 第一步做可行性验证，必要时抽 `useSessionMessages` 核心子集，ChatWindow 与工作台共用（一次重构，双处受益） |
| 多卡片同时展开 → 多 wrapper / SSE 连接开销 | rpc-manager 按 sessionId 复用 wrapper（已有）；同 id 只允许一张展开卡；展开卡上限 3 张（超出提示收合） |
| 体积 +1MB | dynamic 按需加载，仅进看板时下载 |
| 画布保存竞态（多标签） | 全量保存 + 单飞 + updated 乐观锁 |

## 10. 待确认（/goal 前）

1. **底栏 widget**：按用户确认 = 现有 `ExtensionStatusBar` 左侧扩展 widget 区（pi-todo / MCP / subagent）整体保留进卡片底栏；右侧通知 + quota + 上下文。
2. **运行中看板范围**：默认**跨项目全局**聚合（用户原话"所有运行中的任务"）；如需按当前项目过滤请说明。
3. **tldraw 版本**：锁定 `tldraw@^5.3.2`（react19 兼容，最新维护版）。
4. 自动布局按钮本期置灰（不做），仅占位。
