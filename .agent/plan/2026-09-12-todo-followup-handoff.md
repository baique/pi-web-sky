# Handoff：内建 TODO 收尾（复查问题修复）

> 写给接手这个会话的 agent。**先读「第 0 节 环境坑」，否则你会在验证环节重复上一个人的错。**
> 上一轮（2026-09-11 ~ 09-12）的调研与实施记录见 `2026-09-11-builtin-todo.md`。

## 0. 环境坑（必读，先做）

本机装了 RTK（`pi-rtk-optimizer`），它会把工具结果**替换成假的成功信息**：

| 开关 | 症状 |
|---|---|
| `buildOutputFiltering` | 含构建/类型检查命令的**整个工具结果**被换成 `✓ Build successful (0 units compiled)`——连你自己加的 `echo "EXIT=$?"`、`ls` 输出都看不到。命令其实执行了，你只是看不到结果。 |
| `testOutputAggregation` | `npm test` 的真实结果（847 pass / 0 fail）被汇总成 `✅ 0 passed ❌ 1 failed` |
| `gitCompaction` | `git status` 里改动的文件被抹掉，"工作区干净"是假的 |

**开工第一件事**：用 `rtk_configure` 关掉这些（会话级生效，不动盘上配置）：

```
rtk_configure: buildOutputFiltering=false, testOutputAggregation=false,
               gitCompaction=false, truncationEnabled=false,
               smartTruncationEnabled=false, searchResultGrouping=false,
               linterAggregation=false, sourceCodeFilteringEnabled=false
```

然后自检：`node_modules/.bin/tsc --noEmit; echo "EXIT=$?"` 必须**打印出 EXIT**，看不到 `EXIT=` 就说明过滤还开着。

对 `npm test` 再补一层保险：写文件再用 `grep -E "^ℹ (tests|pass|fail)"` 读，别信终端里那行汇总。

## 1. 仓库与分支现状

- 代码在 **`/Users/baique/work/pi-web-sky`（main）**，已经合并：
  - `d764276 feat(todo): 内建会话 todo 工具与顶栏面板`（squash 后的功能提交）
  - `2cd41f2 fix(todo): 补回 Todo 类型 import，修正 getBranch 方向与 auto-clear 文档`（P0 + 两处失真）
- **尚未 push**：origin 停在 `b39a28e`。P-log 全清之前不要推。
- worktree `/Users/baique/work/pi-web-sky-worktrees/feat-todo`（分支 `feat/todo`）**已落后**，是合并前的旧状态；它上面还跑着一个 dev server（30243）。别再在它上面开发，别拿它的内容对照 main。
- `feat/editor` worktree 是另一条不相关的线，不要动。

## 2. ⚠️ 第一件要确认的事：来源不明的代码

`d764276` 里有一部分**不是上一位 agent 写的、也未经它审查**的代码，是在并发写入场景下被 `git add -A` 一并提交进去的：

- `lib/todo-extension.ts` 的 `shouldAutoClear(entries: readonly BranchEntry[])`、`interface BranchEntry`
- `lib/todo-extension.test.mjs` 中引用 `shouldAutoClear` / `todoState` / `allDone` 的用例（上一位作者写的是 `evaluateAutoClear(state)` + `runCount`，`675c5cb` 的提交信息写的就是后者，而该提交的 diff 把前者删掉了 → 信息与 diff 自相矛盾）

**开工前先问用户：这段 `shouldAutoClear` 是不是他（或他授权的会话/服务）做的？**

- **是** → 按下面 P2 的「cadence 落分支」方案继续，与它保持一致。
- **不是 / 不确定** → 先复核这段代码要不要留，其余清理全部排在它之后。

## 3. 已完成（不要重做）

| 项 | 内容 | 状态 |
|---|---|---|
| P0 | `lib/todo-extension.ts` 的 `buildReminder(todos: readonly Todo[])` 用了 `Todo` 但 import 缺失（TS2304，`next build` 会挂） | ✅ `2cd41f2` |
| P1 | `app/api/sessions/[id]/todos/route.ts` 注释把 `getBranch` 方向写反（实为 root→leaf） | ✅ `2cd41f2` |
| P1 | `docs/reference/todo.md` 的 auto-clear 段仍在描述已被替换的内存计数实现 | ✅ `2cd41f2` |

## 4. 待修清单（按优先级）

### P1 —— 真实功能缺陷：节奏提醒在交互式使用下静默失效

`lib/todo-extension.ts`：
- `ReminderState`（`currentTurn` / `lastTodoToolUseTurn`）是**内存计数**；
- `reconstruct()`（挂在 `session_start` / `session_tree`）会 `resetReminderState(reminder)`；
- 而 pi-web 的 `AgentSession` 空闲 **10 分钟即销毁**（见 `lib/rpc-manager.ts` 的 idle timer）。

⇒ 隔几分钟问一句的用法，`currentTurn` 永远数不到 `REMINDER_INTERVAL = 4`，**提醒等于没有**。
这正是 auto-clear 已经踩过、并被 `shouldAutoClear` 改成「从分支重算」的那个坑，cadence 没跟着改。

**修法（需先确认第 2 节）**：把轮数改成从活动分支重算，对齐 `shouldAutoClear(entries)` 的写法——
分支上「最后一条 todo 快照之后又过了几条 user 消息」；`shouldInjectReminder` 变成纯函数（顺带解决它"名为谓词却改 state"的问题，见 P3）。

**验收**：新增用例——`ReminderState` 每次求值都从传入的 entries 重算；构造「分支上 4 条 user 消息、最后一条 todo 快照很早」→ 注入；构造「刚用过 todo 工具」→ 不注入。

### P2 —— 同一份快照两套解析器

- `lib/todo-store.ts` 的 `parseTodoSnapshot`：校验 `id` / `content` / `status`
- `lib/session-reader.ts:532` 的 `extractTodosFromEntries`：只校验 `content` 是 string

同一份 `pi-todo.state` 格式，两处规则不一致。让后者委托前者（或共用一个小函数），字段名改动才不会漏。

### P2 —— 硬编码工具名

`hooks/useAgentSession.ts:1337` 写死 `"todo"`，而常量在 `lib/todo-extension.ts:32` 的 `TOOL_NAME`。
不能从 `todo-extension.ts` import（会把 typebox / `@earendil-works/pi-ai` 拽进客户端包）。
**修法**：把 `TOOL_NAME` 挪到纯数据的 `lib/todo-store.ts`，两边共用。

### P2 —— 两处空分节注释（重构残留）

- `lib/todo-store.ts:80` `// ── 增量推送 ──`：下面为空（函数已被删）
- `lib/todo-extension.ts:40` `// ── 运行态 ──`：紧接 `// ── auto-clear ──`（夹中间的声明已被删）

### P3 —— 其它

| 位置 | 问题 | 修法 |
|---|---|---|
| `TodoList.tsx:17`、`SessionNavBar.tsx:49`、`AppShell.tsx:2069` | 三处各算一遍"完成数/总数"并拼同一句文案 | 抽一个小函数（例如放 `todo-store.ts`：`formatTodoProgress(todos, t)`） |
| `lib/types.ts:333` | `TodoItem.status?: string` 与 store 的 `TodoStatus` 联合类型脱钩；`id?: string \| number` 的 string 分支是历史兼容 | 收紧到 `TodoStatus`；确认无历史数据后收紧 id |
| `lib/todo-extension.ts:112` | `shouldInjectReminder(state, hasOpenWork)` 名字像谓词，实际写 `state.lastTodoToolUseTurn` | 改名（如 `takeReminderSlot`）或改成纯函数（P1 一起做） |
| `lib/todo-store.ts:101` vs `:203` | `addTodos` 的空数组报错分支在生产路径不可达（`dispatchTodoAction` 先挡），且两条文案逐字重复 | 二选一：删 `addTodos` 里那份，或让 dispatch 直接调它 |
| `lib/todo-extension.ts:208` | `agent_end` 无条件 `getBranch()` + 建数组，没有 todo 的会话每轮白走 | 入口加 `if (state.todos.length === 0) return;` |
| `lib/session-reader.ts:559` vs `:592` | `buildSessionContext` 内 `byId` 在 559 建过一次，592 的 `sliceActiveBranch` 又建一次（内部 619） | 把已建好的 Map 传进去，或复用同一次切片结果 |

## 5. 不要再做的几件事

- **别信终端里的"成功"字样**，尤其构建/测试/git 类命令——先按第 0 节关 RTK。
- **别把 `next build` 跑在 dev 期间**（AGENTS.md 明确禁止，会污染 `.next/` 打断 `npm run dev`）。
- **别在并发写入的目录里用 `git add -A`**：这次的 provenance 事故就是这么来的。要么确认没有第二个写入者，要么逐文件 `git add`。
- **别急着 push**：得先跑一次 `npm run build` 确认能过（P0 修完才可以），再推。

## 6. 建议的开工顺序

1. 关 RTK + 自检（第 0 节）
2. 问清 `shouldAutoClear` 的来源（第 2 节）
3. P1 cadence 修（设计 + 用例）
4. P2 三条（机械改动，逐条独立提交）
5. P3 按需
6. 全绿后：`npm run build` → 通过再 push；`feat/todo` worktree 与分支的清理等用户发话（它上面还挂着 30243 的 dev server）

## 7. 参考

- 工具契约 / 持久化契约 / 三条数据路径 / 刻意不做的部分：`docs/reference/todo.md`
- 当初的调研与方案（含为什么不做落盘注入）：`.agent/plan/2026-09-11-builtin-todo.md`
- 验证提醒真的发出了的方法（spy 扩展 + `before_provider_request`，以及用 `getToolDefinition("todo").execute` 直接造状态）：`docs/reference/todo.md` 的「怎么验证提醒真的发出了」
