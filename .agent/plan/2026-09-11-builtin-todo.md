# 内建 TODO（会话任务清单）调研与实施方案

> **For agentic workers:** 本 session inline 执行（app 上下文庞大，不派子代理）。Steps 用 checkbox 跟踪。
> 分支：`feat/todo`（worktree `/Users/baique/work/pi-web-sky-worktrees/feat-todo`，基于 main b39a28e）。
> ⚠️ 本 worktree 无 `node_modules`，动手前先 `npm install`。

**Goal:** pi-web-sky 自带 todo 能力——不装任何额外 pi 插件，会话内 `todo` 工具可用、状态落盘、顶栏右上角面板**实时增量**反映，全完成后 2 轮自动清空。

**Architecture:** 在 pi-web-sky 进程内以**内联扩展**（`resourceLoaderOptions.extensionFactories`，与已有的 `createProjectCommandBashExtension` 同一通道）注册 `todo` 工具；状态每次变更 `pi.appendEntry("pi-todo.state", …)` 落盘，`session_start/session_tree` 回放重建；UI 侧复用现有顶栏面板，数据来源改为「工具结果 SSE 增量推送 + 既有轮询兜底」。

**Tech Stack:** `@earendil-works/pi-coding-agent` ExtensionAPI（`registerTool` / `on` / `appendEntry`）、typebox（SDK 传递依赖，已在 node_modules）、React 19。

---

## 一、调研结论（事实 + 依据）

### 1. UI 已经完整，缺的只是「写入方」

- 顶栏右上角按钮 + 面板：`components/AppShell.tsx`（`renderTodoButton` ~2073、面板 ~3090-3186，读 `sessionTodos`）；看板工作台卡片顶栏同款：`components/canvas/SessionNavBar.tsx`（~216 / ~640）。
- 数据源：会话文件里的 custom entry `{"type":"custom","customType":"pi-todo.state","data":{"todos":[… ]}}`，由 `lib/session-reader.ts:532 extractTodosFromEntries()` 提取，经 `/api/sessions/[id]/context`、`/api/sessions/[id]/todos` 两路进前端（`hooks/useAgentSession.ts` → `ChatWindow` → `AppShell`；`AppShell` 运行中 6s 轮询）。
- **实际是死的**：`~/.pi/agent/sessions/` 全库 grep `"customType":"pi-todo.state"` = 0 条。原因：`@zhushanwen/pi-todo@0.8.9` 已改为「不用 appendEntry、改用框架自动记录的 toolResult entry」（其 README「持久化机制」+ `src/handlers.ts reconstructState`），而我们的 reader 只认 `pi-todo.state`。**即便装了插件，顶栏面板也一直是空的。**
- reader 还对每项要求 `typeof t.content === "string"`（字段名 `content`，不是插件侧的 `text`）。

结论：**内建实现 + 走 `pi-todo.state` 契约** = UI 零改造即通。

### 2. 参考实现 `@zhushanwen/pi-todo@0.8.9`（`~/.pi/agent/npm/node_modules/@zhushanwen/pi-todo`）

| 维度 | 事实（照抄） |
|---|---|
| 工具名/参数 | `todo`，4 action：`list` / `add`(`texts[]`) / `update`(`id`+`status`\|`text`，或 `updates[]` 批量) / `delete`(`ids[]`，部分缺失整体拒绝) |
| schema | 扁平 `Type.Object`（OpenAI 兼容：顶层 union 会被严格网关 400），字段全 Optional，**必填校验放 handler 运行时**（`text/texts`、`id/ids` 双形陷阱单独报错） |
| 状态 | 三态 `pending / in_progress / completed`，刻意无状态机约束；`nextId` 单调自增不复用 |
| 会话隔离 | 状态在扩展工厂闭包内（`createTodoSessionState()`），每个 AgentSession 一份 → 天然隔离 |
| 错误处理 | handler 直接 `throw`，不返回「错误成功模式」 |
| 提示词 | `promptSnippet` + `promptGuidelines`（不能写 "Use this tool when…"，LLM 不知道 this 指谁） |
| auto-clear | `agent_start` 计数 +1；全 completed 时记下当前计数；再过 **2 轮**清空 todos 且 `nextId` 复位 1（`handlers.ts handleAutoClear`）→ **本次保留，语义一致** |

### 2.1 横向对比：提醒机制（关键调研）

| 实现 | 有「自动提醒」吗 | 机制 | 落盘/可见 |
|---|---|---|---|
| `badlogic/pi-mono` 官方示例 `examples/extensions/todo.ts` | **没有** | 只有工具 + `/todos` 命令 | — |
| **`@zhushanwen/pi-todo`（参考项目）** | **有**（有 pending 时**每轮**） | `before_agent_start` 返回 `custom_message`（`customType: "todo-context"`） | **落盘，且 pi-web 渲染成卡片** |
| `@tintinweb/pi-tasks`（8.2K/mo，Claude Code 风格） | 有（**节奏**：`REMINDER_INTERVAL=4` 轮未用 todo 工具且仍有 open work） | `context` 事件注入**瞬时** user 消息（`injectReminderMessage`） | 不落盘、不进会话 ✅ |
| `@nguyenquangthai/pi-todo`（OpenCode 风格） | 有（移植 pi-tasks 的 cadence + 冷启动/完成 nudge + systemPrompt 段落） | 同上，`context` 瞬时注入 | 不落盘 ✅ |
| `@pi-archimedes/todo` | auto-clear 用 **2 秒**延迟（非 2 轮） | widget 层 | — |

**结论：有提醒 → 保留**（用户决策）。但**机制改用 `context` 瞬时注入 + cadence**，理由：

- 参考实现的机制在 pi-web 里是有害的：`MessageView.tsx` 的 `CustomMessageView` **会渲染 `custom_message`**（`display:false` 只是半透明 + 折叠，`components/MessageView.tsx:1653`），所以「每轮注入」= 聊天流里每轮多一张卡片 —— 这正是需要避免的现象。
- `context` 事件注入的 user 消息**不进会话文件、不渲染、不占 entry**，只影响当次 LLM 请求（`@tintinweb/pi-tasks` / `@nguyenquangthai/pi-todo` 均如此）。
- cadence（4 轮 + 仍有 open work）比「每轮」更精准：模型在用 todo 时不会被废话打扰。

**不抄**：`completion-steer`（全完成后注入「检查交付质量」steer，`todo-context` 落盘消息）；以及 TUI 状态栏/widget、`/todos` 交互式视图、`renderCall/renderResult`（pi-web 有自己的渲染）、`buildGui`（依赖 `@xyz-agent/extension-protocol`）、`@nguyenquangthai` 的 prompt 意图分类（正则判 multi_step/trivial，过重且语言相关）。

### 3. 注入通道已在项目里跑通（无需新包、无需用户安装）

`lib/rpc-manager.ts:1676-1684` 创建 session 时传
`resourceLoaderOptions: { extensionFactories: [createProjectCommandBashExtension(…)], extensionsOverride: preferUserBashExtension }`。
内联扩展在加载列表**排在用户包之后**（`resource-loader.js`：`extensions.push(...inlineExtensions)`），工具重名时**先注册者胜**（`runner.js getAllRegisteredTools` 首个 `toolsByName.set` 生效）。

⇒ 共存期（`@zhushanwen/pi-todo` 还装着）**插件赢**，面板仍是空的；用户卸载后内建生效。启动列表会有一条 `Tool "todo" conflicts with …` 提示，无害。**用户自行卸载插件，本次不做排除逻辑。**

### 4. 增量推送的落点（已核实可零新增协议）

- pi 的 `tool_execution_end` 事件**带完整 `result`**（`pi-agent-core/dist/agent-loop.js:526` → `{type,toolCallId,toolName,result,isError}`）。
- pi-web 的 SSE 对该事件**原样透传**（`lib/agent-event-wire.ts` 仅特殊处理 `message_update`/`agent_end`/`tool_execution_update`，其余 `return event`）。
- 我们工具的 `execute` 返回 `details = {action, todos, nextId}`，与 session 文件里 `message.details` 形状一致（真实会话文件已确认）。
⇒ 前端在 `useAgentSession` 的 `tool_execution_end` 分支里读 `event.result.details.todos` 即可**每次工具调用即时刷新**面板，零新增事件类型。
- auto-clear 不经过工具调用，但它在扩展的 `agent_end` 里跑，而框架是**先发扩展、后发订阅者**（`agent-session.js:367-369`），前端 `agent_end` 分支本就会 `loadSession()` 重拉 → 清空同样能反映。故增量推送 + 既有 6s 轮询/agent_end 重拉即可覆盖全部路径。

---

## 二、设计

### 工具契约（与参考一致，命名/参数/语义不变）

```
todo({ action: "list" | "add" | "update" | "delete",
       texts?: string[], text?: string, ids?: number[], id?: number,
       status?: "pending"|"in_progress"|"completed",
       updates?: {id, status?, text?}[] })
```
- `add` 只接受 `texts`（传单数 `text` 报专门的错）；`update` 批量 `updates[]` 优先于单条；`delete` 部分 id 存在即整体拒绝。
- 描述里保留：同一时间只有一个 `in_progress`；完成即标 `completed`；未真正完成不得标 `completed`；**全部完成后自动清理，无需手动 delete**（auto-clear 保留，故这条提示保留）。

### 持久化、重建、auto-clear

- 每次变更后：`pi.appendEntry("pi-todo.state", { todos: [{id, content, status}], nextId })`。
  - 用 `content` 而非 `text`：贴合 reader/UI 既有契约（`lib/session-reader.ts` 只收 `content` 为 string 的项）。
  - 快照式（非增量）→ 回放只取最后一条。
- `session_start` / `session_tree`：扫 `ctx.sessionManager.getEntries()`，取最后一条 `pi-todo.state` 重建（复用 `extractTodosFromEntries`，不另写解析）。
- auto-clear（`agent_start` / `agent_end` 两个 handler）：
  - `agent_start`：`userMessageCount++`；
  - `agent_end`：`todos.length > 0 && 全部 completed` → 首次记 `allCompletedAtCount = userMessageCount`；`userMessageCount - allCompletedAtCount >= 2` → 清空 todos、`nextId = 1`、复位计数，并 `appendEntry` 落盘空快照（UI 才不会残留）。
  - **不做任何消息注入**（无 completion-steer、无每轮 pending 提醒）。
- 不做 compaction 后补写：见下面「顺带修的既有缺陷 a」。

### 顺带修的既有缺陷（不修则功能看起来是坏的）

a. **compaction 会清空面板**：`buildSessionContext` 从 compaction 截断后的 `contextEntries` 提取 todos（`lib/session-reader.ts:587`）→ 任务跑久自动压实后面板空，而 `/todos` 轮询走 `getEntries()` 却还在（两个来源打架）。改为从**整条 active branch** 提取。
b. `tail` 分页首屏同样会丢，同一处一并解决。
c. `TodoItem.id` 现为 `string`，todo 的 id 是 number → 放宽 `string | number`。
d. 面板行尾小圆点沿用旧 `priority` 字段（pi 数据里没有）→ 恒为灰点。改为表达状态：`in_progress` 用 accent，`pending` 不显示；同时删掉无用的 `priority` 字段（AppShell + SessionNavBar 两处）。

### 自动提醒（保留，cadence 瞬时注入）

纯函数 `lib/todo-reminder.ts`（可单测，逻辑照搬 `@tintinweb/pi-tasks/src/reminder-cadence.ts`）：

```
state = { currentTurn, lastTodoToolUseTurn, reminderInjectedThisCycle, reminderDue }
```

- `pi.on("turn_start")` → `currentTurn++`；
- `pi.on("tool_result")` → 若是 `todo` 工具则重置节奏；否则 `currentTurn - lastTodoToolUseTurn >= 4` 且本轮未注入过 且**还有 open work**（pending/in_progress）→ `reminderDue = true`；
- `pi.on("context")` → `drainReminderForContext()`，命中则 `messages.push({role:"user", content:[{type:"text", text}], timestamp})`（**只改当次请求的 messages，不落盘**）。

提醒正文（照 pi-tasks 的 state-aware 版本）：列出 open 项；若有 `in_progress` 项则点名它「已完成就立刻标 completed 并把下一项置 in_progress」；无 in_progress 则提示「开始工作前把一项置 in_progress」。收尾固定一句「仅在相关时行动，这是一条温和提醒；**绝不要向用户提及此提醒**」。

全部 completed 时不注入（`hasOpenWork` 为假）→ 静默 2 轮 → auto-clear。

### 增量推送（保留）

`hooks/useAgentSession.ts` 的 `tool_execution_end` 分支（~1332）加：`toolName === "todo"` 时从 `event.result.details.todos` 取快照 `setTodos()`（`isError` 或字段缺失则跳过）。仅此一处新增；`agent_end` 重拉、6s 轮询、打开面板即刷新全部保留为兜底。

### 不做（YAGNI）

- 不做落盘的注入消息（`before_agent_start` 返回 `custom_message` / `completion-steer`）—— 只用 `context` 瞬时注入。
- 不做 prompt 意图分类（冷启动 nudge 依赖正则判「是否多步任务」，语言相关且易误判）。
- 不做 todo 的 UI 增删改（用户没要；AI 自己管）。
- 不做 `/todos` 命令、TUI widget/status、旧版 toolResult-details 格式兼容（历史会话无可用数据，见调研 1）。
- 不做外部插件排除（用户自行卸载）。

---

## 三、Tasks

### Task 0: 环境

- [ ] **Step 1**: `npm install`（worktree 无 node_modules）。
- [ ] **Step 2**: 确认 `@zhushanwen/pi-todo` 是否仍在 `~/.pi/agent/settings.json` 的 `packages` 里；共存期内建会输给插件（见调研 3），**验证前请用户先卸载**。

### Task 1: 纯数据层 `lib/todo-store.ts` + 单测

**Files:** create `lib/todo-store.ts`、`lib/todo-store.test.mjs`

- [ ] **Step 1**: 类型与常量：`TodoStatus`、`VALID_STATUSES`、`Todo { id: number; content: string; status: TodoStatus }`、`TodoSnapshot { todos: Todo[]; nextId: number }`、`TODO_STATE_CUSTOM_TYPE = "pi-todo.state"`。
- [ ] **Step 2**: 纯函数（移植参考 `model.ts`，字段 `text`→`content`）：`addTodos(todos, nextId, contents[])` / `updateTodos(todos, updates[])` / `deleteTodos(todos, ids[])`（原子）/ `formatTodoList(todos)` / `isAllCompleted(todos)`。校验失败 `throw`，文案与参考一致。
- [ ] **Step 3**: `parseTodoSnapshot(data: unknown): TodoSnapshot`（脏数据逐项降级跳过）。
- [ ] **Step 4**: `lib/todo-store.test.mjs`（node:test + jiti 载入 .ts，照抄 `lib/project-command-env.test.mjs` 写法）：add 连续 id / update 批量与非法 id / delete 原子性 / 双形陷阱（`add` 传 `text`、`update` 传 `ids`）/ 快照解析含脏数据。
- [ ] **Step 5**: `node --experimental-strip-types --test lib/todo-store.test.mjs` 通过。

### Task 2: 内联扩展 `lib/todo-extension.ts` + 接线

**Files:** create `lib/todo-extension.ts`、`lib/todo-extension.test.mjs`；edit `lib/rpc-manager.ts`

- [ ] **Step 1**: `createTodoExtension(): InlineExtension`（`name: "pi-web-todo"`, `hidden: true`）：
  - 闭包 `state = { todos, nextId, userMessageCount, allCompletedAtCount }`；
  - `pi.registerTool({ name: "todo", label: "Todo", description, promptSnippet, promptGuidelines, executionMode: "sequential", parameters, execute })`；
  - `execute`：dispatch 到 Task 1 纯函数 → 变更后 `pi.appendEntry(TODO_STATE_CUSTOM_TYPE, {todos, nextId})` → 返回 `{content:[{type:"text",text}], details:{action, todos, nextId}}`（变更动作文本附完整列表，list 只返回列表）；
  - `pi.on("session_start"|"session_tree")`：回放最后一条快照；`pi.on("agent_start")`：计数 +1；`pi.on("agent_end")`：auto-clear（含清空后落盘）；`pi.on("turn_start")` / `pi.on("tool_result")` / `pi.on("context")`：cadence 提醒（见设计）。
- [ ] **Step 2**: `lib/todo-extension.ts` 里**不出现** `sendMessage` / `before_agent_start` / `appendEntry` 的提醒用法（源码级约束，测试断言）：提醒只走 `context` 的瞬时 messages。
- [ ] **Step 3**: `lib/rpc-manager.ts`：import `createTodoExtension`；`extensionFactories: [createProjectCommandBashExtension(…), createTodoExtension()]`（`extensionsOverride` 保持 `preferUserBashExtension` 不动）。
- [ ] **Step 4**: `lib/todo-extension.test.mjs`：
  - fake `pi`（收集 registerTool 定义 + 记录 appendEntry 调用）+ fake ctx（`sessionManager.getEntries` 返回含快照的 entries）→ 断言 add/update/delete 的三态与落盘快照、回放重建；
  - **auto-clear 语义**：3 次 `agent_start`/`agent_end` 序列后 todos 清空、`nextId` 复位 1、且落盘了空快照；
  - **cadence 断言**（`lib/todo-reminder.test.mjs` 纯函数 + 扩展层各一份）：第 4 轮且仍有 open work → `context` 注入一次；用了 todo 工具即重置；全 completed 时**不注入**；
  - **无落盘断言**：源码不含 `sendMessage`/`before_agent_start`（防回归到「不停地发扩展消息」）。
- [ ] **Step 5**: 测试跑通（顺带 `lib/project-command-env.test.mjs` 仍绿）。

### Task 3: 前端接线与既有缺陷修正

**Files:** edit `hooks/useAgentSession.ts`、`lib/session-reader.ts`、`lib/types.ts`、`components/AppShell.tsx`、`components/canvas/SessionNavBar.tsx`

- [ ] **Step 1**: 增量推送：`tool_execution_end` 分支加 todo 快照 → `setTodos`（`toolName === "todo"` + `!isError` + `details.todos` 数组校验）。
- [ ] **Step 2**: `lib/session-reader.ts` `buildSessionContext`：todos 改从整条 active branch 提取（`sliceActiveBranch(entries, leafId ?? null, entries.length)`），注释写明「compaction 截断的是 LLM 上下文，不是 UI 面板的数据源」。
- [ ] **Step 3**: `lib/types.ts` `TodoItem.id?: string | number`，删 `priority`。
- [ ] **Step 4**: 两处面板行尾圆点改状态色。
- [ ] **Step 5**: `node_modules/.bin/tsc --noEmit` + `npm test` 全绿。

### Task 4: 文档 + 端到端验证

**Files:** create `docs/reference/todo.md`；edit `AGENTS.md`（参考索引加一行）、`docs/reference/file-map.md`、`README.md`（特性一句话）

- [ ] **Step 1**: `docs/reference/todo.md`：工具契约、持久化契约（`pi-todo.state` / `content` 字段）、注入通道、auto-clear 语义、增量推送路径、与参考实现的差异（**刻意不做**的部分）、compaction 注意事项。
- [ ] **Step 2**: AGENTS.md 参考索引加 `| 会话 TODO | docs/reference/todo.md | 改 todo 工具 / 顶栏 todo 面板 / pi-todo.state 契约 |`；file-map 补新文件。
- [ ] **Step 3**: 端到端（playwright，`npm run dev` port 30143；**先确认插件已卸载**）：新建会话 → 让其做一件多步小任务（要求用 todo 工具）→ 断言 ①聊天出现 `todo` 工具调用 ②顶栏右上角出现 TODO 按钮与计数 ③**工具调用后无需刷新，面板立即更新**（增量推送）④会话文件出现 `pi-todo.state` entry ⑤**全程没有** `todo-context` 隐藏消息 ⑥再走 2 轮对话后 todo 自动清空、按钮消失。
- [ ] **Step 4**: 提交（`feat(todo): 内建会话 todo 工具与顶栏面板对接`），按仓库规范合并回 main 只留一条 squash 提交。

## 验收标准

1. 全新环境（不含任何 todo 插件）装 pi-web-sky 即有 `todo` 工具，AI 自发用于多步任务。
2. 顶栏右上角 TODO 按钮/面板反映当前会话状态，**工具调用后即时更新**；跨刷新、跨会话切换、任务中途 compaction 后都不丢。
3. 会话文件中有 `pi-todo.state` 快照；**无任何 `todo-context` 等注入 entry**（提醒只以瞬时 user 消息出现在 LLM 请求里）。
5. 模型连续 4 轮没用 todo 工具且仍有未完成项时，下一轮请求里出现一次 `<system-reminder>` 提醒，且**聊天界面不出现对应卡片**。
4. 全部完成后再过 2 轮，todo 自动清空且 `nextId` 复位（按钮从顶栏消失）。
