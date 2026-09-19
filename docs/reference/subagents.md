# 内置 subagent 运行时（Agent 工具 / profile / 并发队列）

> 改 Agent 工具、profile 格式与加载、subagent 会话生命周期、AgentsConfig 设置页、subagent 的 UI 展示前阅读。上游移植背景见 [upstream-ports.md](../upstream-ports.md)「上游内置 subagent 运行时移植」。

## 是什么 / 边界

- **内置运行时本身不是扩展包**：`lib/subagent-extension.ts` 注册三个工具，`lib/subagent-runtime.ts` 负责执行；随 pi-web 一起装好。
- 每个 subagent = 一个**真实、可检查的 pi 会话**（独立 `.jsonl`、能在侧栏/看板里当普通会话打开、可 steer/abort），不是内存里的黑盒。
- **默认关闭**：`isBuiltInSubagentsEnabled()` 读不到设置时返回 `false`；开关在 设置 → 代理（`AgentsConfig`）。关着时 `start()`/`resume()` 直接抛 "Pi Web built-in sub-agents are disabled"。
- **与 legacy `pi-subagents` 包互斥**：`preferPiWebSubagentExtension()` 在扩展加载结果里摘掉「带同名工具（Agent / get_subagent_result / steer_subagent）的 legacy 扩展」以及它引发的 `Tool "Agent" conflicts with …` 报错——不这么做两套实现会抢同一个工具名。

## 会话文件契约（三个 custom entry）

subagent 会话文件里除常规条目外有三种 custom entry，**这是跨进程/跨重启的唯一真相源**：

| customType | 内容 |
|---|---|
| `pi-web:subagent` | meta（version 1）：`parentSessionId` / `parentSessionPath` / `parentToolCallId` / `profile` / `description` / `task` / `runInBackground` / `createdAt` / `resourceSnapshot` / `worktreePath?` / `worktreeBranch?` |
| `pi-web:subagent-status` | `{ version: 1, status: "queued" \| "running" }`（启动与转 running 时各写一条） |
| `pi-web:subagent-result` | `{ version: 1, status: "completed" \| "failed" \| "aborted", completedAt, result?, error?, worktreeCleanupError? }`（终态） |

- `readSubagentRun()` 取**最后一条 lifecycle 条目**（`-status` 或 `-result`，按文件顺序的最后一条）判定：那条是 result 且为终态 → 用它；是 status（需 `version: 1`）→ queued/running；都没有 → `interrupted`。**没有跨条目的优先级比较** —— resume 后新写的 status 会盖掉旧 result。
- `resourceSnapshot`（appendSystemPrompt / tools / loadSkills / loadExtensions / exactSystemPrompt）是**重建会话时的唯一依据**——`startRpcSession` 读它来恢复 noExtensions/noSkills/appendSystemPrompt/tools。改它的结构 = 改重建契约：老 snapshot 版本对不上会被判无效（返回 null），该会话被当普通会话重建，隔离静默失效。
- snapshot 的 `tools` 会被校验：**任何一个控制工具（Agent / get_subagent_result / steer_subagent）出现，整份 snapshot 即判无效**（返回 null，不是过滤掉那一项）—— 该会话随即按普通会话重建，隔离（prompt / 工具范围）静默失效；此外每个名字还必须满足「内置工具 **或** `loadExtensions` 为真」。重建时只按 `snapshot.tools` 当工具白名单（不再传 `excludeTools`），所以这层校验是唯一的守门人。

## Profile（子代理配置）

**来源与优先级**（同名覆盖，高者胜）：

```
builtin (代码内置) < global ~/.pi/agent/agents/*.md < workspace <cwd>/.agents/agents/*.md < project <cwd>/.pi/agents/*.md
```

- 内置三个：`general-purpose`（默认，全工具）、`explore`、`plan`（后两个只读工具集）。
- `listSubagentProfileSources()` 返回**全部来源**（含被高优先级影子覆盖的），供 UI 展示；`listSubagentProfiles()` 返回按优先级去重后的生效集合；`resolveSubagentProfile()` 只认 `enabled` 的。
- 名字规则：`[A-Za-z0-9][A-Za-z0-9._-]*`，文件即 `<name>.md`。

**frontmatter 托管键**（`MANAGED_FRONTMATTER_KEYS`，UI 拥有）：
`description` `display_name` `tools` `load_skills` `load_extensions` `enabled` `inherit_context` `run_in_background` `model` `thinking` `max_turns` `prompt_mode` `color` `isolation` `persist_session`

- **非托管键必须原样保留**（`unmanagedFrontmatter`）：`allowed_subagents`、`exclude_extensions` 这类键属于别的运行时读的。历史上丢键造成过真实行为变化——`allowed_subagents` 丢了编排器就再也派生不出子代理，`exclude_extensions` 丢了「排除」变「启用」。保存时托管键在前、非托管键按**原文件顺序**跟在后面。
- **别名同步有边界**（`syncFlagAlias`）：`skills` / `extensions` 只在原值是布尔、`none` / `all` / `true` / `false`（`OWNED_ALIAS_VALUES`），**或该键根本不存在**时才跟随 UI 的布尔改写；写成白名单（如 `extensions: pi-advisor-flow`）表达的是 UI 展示不出来的作用域，**原样保留**。
- `tools` 解析（`parseTools`）：`none` → 空；`all` / `*` → 全部内置工具；否则过滤到内置工具集合。`ext:<包>[/<工具>]` 选择器（`disallowed_tools` 亦可）不参与内置过滤，保存时由 `composeToolsField` 合并回写，不会因为一次 UI 保存被抹掉。
- 可写范围只有 `global` 与 `project`（workspace 只读）；project 目录必须落在 cwd 内（否则拒绝）。

## 启动流程（start）

按序，任一步失败都中止；已建的 worktree 在失败时尝试回收：

1. 开关检查（`isBuiltInSubagentsEnabled`）
2. 父会话必须存在、存活**且已落盘**（未落盘报 "Parent session must be persisted before starting a subagent"）
3. `resolveSubagentProfile(parent.cwd, profileName)` —— 未知或未启用即报错
4. `isolation: "worktree"` → `addWorktree(parent.cwd, "pi-web-agent-<uuid>")`，`childCwd` = worktree 路径（否则用父 cwd）
5. `inherit_context` → 序列化父会话上下文，**上限 50000 字符**（超出截断并标注）；仅作为背景交给子代理
6. `input_files` → `loadSubagentInputFiles`：≤ 8 个、总量 ≤ 512KB、必须落在父 cwd 内（realpath 校验，比 `/api/files` 白名单更严）、必须 UTF-8，拼成 `<documents>` 段落附在 task 后
7. `buildSubagentPromptPlan`：算 `chatOnly` / `appendSystemPrompt` / `delegatedTask` / `exactSystemPrompt`
8. `createAgentSessionServices`：`noPromptTemplates` / `noThemes` / `noContextFiles` 恒为真；`noExtensions` / `noSkills` 按 profile；`appendSystemPrompt` = profile 的 systemPrompt（+ 父上下文）
9. 工具集 = profile.tools + 扩展工具（`load_extensions` 时：有 `ext:` 选择器就按选择器取，否则取全部扩展工具）→ `resolveShellTools(...)`
10. `SessionManager.create(cwd, undefined, { parentSession: 父会话文件 })` → 写 meta entry → `appendSessionInfo(metadata.description)`（文件内会话名；空 description 时才用 profile.displayName）→ `ensureSubagentSessionRow()` 建 session_meta 行：`title` 只取 `description`（空则 NULL，展示回落 first_message）、`parent_id` = 父会话、`task_id` 继承父所在任务。
11. 模型 / 思考级别：`request > profile > 父会话`；模型写 `provider/modelId`，只写裸 id 且匹配多个时报「ambiguous」
12. `createAgentSessionFromServices({ tools, excludeTools: SUBAGENT_CONTROL_TOOL_NAMES })`
13. 入队（见「并发队列」）

**两条容易踩的铁律**：

- `excludeTools` 必须包含三个控制工具，snapshot 重建时也会过滤 —— 否则 subagent 可以无限嵌套开 subagent。
- profile 的 `tools` 决定一切：**subagent 会话的工具选择不允许手动改**（`rpc-manager` 直接抛 "Subagent tool selection is fixed by its profile"）。

**chatOnly 语义**：profile 工具为空且不加载 skills/extensions 时，会话按「纯聊天」跑（资源加载器用空 systemPrompt + 覆盖函数），prompt 首次 preflight 成功后再把 profile 的 systemPrompt 塞进 `agent.state.systemPrompt`。

**maxTurns 两段式**：第 N 轮（`turn_end` 计数）→ `steer("wrap up immediately…")`；第 N+1 轮 → `abort()`。达到上限结束的 run 记为 **completed**（不是 failed）。

**promptMode**：`replace` → 用 `exactSystemPrompt` 覆盖系统提示词；`append` → 走 appendSystemPrompt。

## 状态与生命周期

```
queued → running → completed / failed / aborted
```

- 运行态在内存：`globalThis.__piSubagentRuns`（Map `sessionId → { run, completion, abortRequested, cancelQueued }`）—— 用 globalThis 是为了存活 Next.js 热重载（与 `__piSessions` 同理）。
- 查询 `get(sessionId)` **三级回退**：内存 → 活 wrapper 的 entries（若 wrapper 在跑，状态强制为 running）→ 打开会话文件读 entries。
- 取消：`queued` → `cancelQueued()`（触发 `finishQueuedAbort` 落 aborted 结果）；`running` → `inner.abort()`。
- `run_in_background: false`（前台）时把 `request.signal` 绑到取消：父工具调用被中断 → 子代理跟着中断；后台模式**不绑**（父会话结束不该杀掉后台任务）。
- 后台完成 → `notifyParent()`：父会话不存活则先 reopen，然后以 `deliverAs: "followUp"` + `triggerTurn: true` 发一条 `pi-web:subagent-notification` 自定义消息唤醒父会话（内容由 `subagentFinalText()` 生成）。
- worktree 回收：run 结束（含失败/取消）调 `removeWorktree`；**失败不强制删**，把 worktree 留在磁盘并写进 `worktreeCleanupError` 交给用户处理。

## 并发队列

- `lib/subagent-queue.ts` 的 `SubagentQueue`：**per-parent FIFO**，不同父会话互不阻塞；父队列清空后从 Map 移除。
- 并发上限 = 设置里的 `maxConcurrent`（默认 10，范围 1..32），在每次入队时读取。

## 设置文件

`~/.pi/agent/agents/settings.json`：`{ version: 1, builtInEnabled: boolean, maxConcurrent: number }`

- 文件缺失 → 两者取默认（`builtInEnabled: false`（**默认关**）、`maxConcurrent: 10`）；**JSON 非法 / 不是对象 → `readSubagentSettings()` 直接抛错**（无兜底），只有 `isBuiltInSubagentsEnabled()` 把异常吞成 `false`。
- 写入走 `writePrivateFileAtomicSync`（原子写 + 私有权限），并保留文件里其他未知键。

## API 与 UI 入口

```
GET  /api/subagents/[id]             子代理运行态（get）
POST /api/subagents/[id]             { action: "steer" | "abort" }（"not running" → 409）
GET  /api/subagents/settings         开关 + 并发数
PUT  /api/subagents/settings         改开关/并发（过 request-security + JSON content-type 校验）
GET/PUT/PATCH/DELETE /api/subagents/profiles   profile 列表 / 保存 / 启停 / 删除（cwd 须在允许根内）
```

- 设置 → **代理**分区（`components/AgentsConfig.tsx`）：开关、并发数、profile 列表与编辑/启停/删除。
- 模型对话里：`Agent` / `get_subagent_result` / `steer_subagent` 三个工具，结果以工具结果文本呈现（详情在 `details` 里，形如 `{kind:"pi-web-subagent", sessionId, profile, status, …}`）。

### 未接线部分（2026-09 现状，别当成已有功能）

这几处**代码存在但没有任何调用方**，subagent 的「会话级 UI」实际是空的：

- `components/AgentSessionPanel.tsx`（子代理会话切换列表）—— 全仓无引用、未挂载。
- `lib/session-family.ts`（把 subagent 会话归到父会话的家族聚合）—— **无生产调用方**（只有 `lib/session-family.test.mjs` 在调）。
- `SessionInfo.relation`（`kind: "subagent"`）只由 `getRpcSessionInfos()`（**运行中**快照）产出；磁盘列表路径（session-reader / session_meta）不产出。更彻底的是 `mergeSessionLists()`（`/api/sessions` 用）：**磁盘条目覆盖运行时条目**，子代理会话一旦落盘，就算运行态快照带了 relation 也会被丢掉。
- 结果：subagent 会话目前**在侧栏表现为一个普通会话**（名字 = description），没有父子树聚合、没有专用面板。要补齐就是接这三处（面板挂载点 + 列表 API 注入 relation + 家族树）。

## 坑与纪律（改之前先看）

1. **改 `resourceSnapshot` 结构 = 迁移问题**：旧会话重建会失效（隔离静默丢）。要改就加版本号并处理老版本。
2. **父上下文 50000 是序列化字符数**，不是 token —— 大 history 会被硬截断。
3. **profile 前端保存必须走非托管键保留逻辑**：直接在 UI 里重写整个 frontmatter 会破坏别的运行时的键。
4. **`input_files` 的白名单比 `/api/files` 严**：只有父 cwd 一个根，且要 realpath 后仍在其中（符号链接逃逸会被拒）。
5. **开关默认关**：新环境里 Agent 工具不存在，是因为没打开，不是坏。
