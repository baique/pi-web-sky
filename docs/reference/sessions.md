# 会话生命周期与文件格式

> 改会话加载 / 分支 / SSE / compaction / 运行状态轮询 / 会话归属 / 索引 / 会话文件读写前阅读。

## AgentSession lifecycle (`lib/rpc-manager.ts`)

- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

## Fork must destroy the wrapper immediately

fork 后 `inner` 状态即指向新会话（`AgentSession.fork()` **in-place mutate** wrapper 的 inner state，`inner.sessionId` 变成 *新* 会话 id）。If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` 用 `SessionManager.create/createBranchedSession` 造分支文件，拿到 `newSessionId` 后立即 `await this.shutdown()`（registry 里不能留已 fork 的 wrapper）；建 session_meta 行放在 shutdown 之后（`resolveProject` 的 await 不能落在这个窗口）。The next request for the original session reloads a clean AgentSession from the original file.

## Two kinds of branching — don't confuse them

- **Fork**（用户消息上的 Fork 按钮）：新建独立 `.jsonl` 并立即建 `session_meta` 全列行（`parent_id` = 源会话、`task_id` 继承源会话归属）；侧栏父子树按库 `parent_id` 建（磁盘 `header.parentSession` 只是镜像）。
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

## Session files can be fully rewritten

`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). 删会话的级联重挂必须同请求写两处：磁盘 header（`rewriteSessionParent`）与库内子行 `parent_id`（`reparentSessionChildren`，祖父反查不到则 NULL）。

## ToolCall field normalization

Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `hooks/useAgentSession.ts` 的 `handleAgentEvent()` (streaming).

## New session tool preset

Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the preset is inferred from `get_tools` → `getPresetFromTools()` only when the session is actually running (mount sees `agentState.running`, or after a `reload`); idle sessions are not re-inferred. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

## Specified session id + create-on-persist

New sessions can carry a client-chosen id: `POST /api/agent/new` accepts an `id` field (validated against the SDK's `assertValidSessionId` rule: alphanumerics plus `-_.`, must start/end alphanumeric — the route rejects anything else with `Invalid session id`). `startRpcSession` passes it to `SessionManager.create(cwd, dir, { id })`, so the real session id equals the client-supplied one — the caller knows the id **before** the session is ready, which is what task/board bindings rely on (no draft-card waiting, no polling to "promote"). 前端一律用 `lib/id.ts` 的 `newId()` 生成（它同时兼顾非安全上下文）；**别拿目录/描述当 id**（2026-09-18 修的旧写法 `initial:<cwd>` 带 `:` 与 `/`，`?cwd=` 深链的第一条消息会被 400 挡下）。

Pi delays the first JSONL flush until an assistant message exists. Pi Web overrides this with `persistNewSessionFile()` in `startRpcSession`: the empty header is written immediately and the manager is marked `flushed`, so a session exists on disk from birth and survives page reloads. This also makes the old `persistBashOnlySession` fallback unnecessary (removed).

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

## New-session draft slots (`tmp_new_<项目>` / `task_<id>`)

新建会话输入框的**草稿槽不是会话 id**：会话 id 每点一次新建都换（必须唯一），拿它当草稿键就记不住；两者以 `newSessionId` / `newSessionDraftKey` 两个 props 分开传。草稿槽与会话 id 解耦、跨多次「新建」存活 —— 临时会话按**项目**一份 `tmp_new_<项目身份>`（同项目 worktree 共用；`projectKey` 未定时退回 `cwd`），任务新建 `task_<任务id>`（`lib/draft-store.ts` 内存表，发送成功由 `clearInput` 清空，组件卸载不清）。

两处容易弄反的地方：① 任务归属的 `draftId` 校验（`draftId === 本轮会话 id`）在 AppShell（显示/草稿槽）与 `useAgentSession.ensureNewSession`（创建请求）**必须同一个谓词**，AppShell 的 `newSessionTaskId` 只在新建会话态给出；② 提交失败回填要用**此刻**的草稿键（`composerDraftKeyRef`）——转正后键从槽变成会话 id，用发起提交那次闭包里的旧值会把文字写进看不见的槽（“迟到的提交失败”仍由 `restoreSubmission` 的 mounted/promoted 守卫拦住）。创建失败（`/api/agent/new` 报错）必须把 `sessionIdRef` 清回去，否则重试会绕过创建接口、丢掉任务归属。

## SSE reconnect on page refresh mid-stream

On `useAgentSession` mount, `GET /api/sessions/[id]/state` is called. If `state.isStreaming` **or** `state.isPromptRunning` is true, SSE is reconnected automatically (and `loadTools` runs for the running session). `thinkingLevel` and `isCompacting` are also synced from this response.

## Compaction SSE events

Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

## Running state polling + reconciliation

- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- **`sessionRunning` prop is the reattach signal — every `ChatWindow` host must pass it.** `useAgentSession`只在该 prop 为 true 时 `maintainEventsConnected()`（再加一个 30s grace）。会话空闲后 SSE 被关掉，之后子代理完成通知 / 别的客户端把这个会话重新跑起来时，唯一的重接信号就是这个 prop。
  - 主聊天（AppShell）传 `runningSessionIds.has(id)` ✓。
  - 看板卡（`SessionWorkbench`）曾**漏传** → 展开的会话卡在子代理通知唤醒后永不再接、内容停在断流那一刻，直到手动刷新/新发消息（2026-09-14 修）。看板的轮询快照在 `SessionRunningContext`（`useSessionRunning(sid)`），卡里 `phase !== "idle"` 即 running，把它传给 `ChatWindow` 即可。
  - 已知残留：唤醒轮次短于一个 2.5s 轮询节拍（或 tab 在后台、轮询暂停）时可能整个错过 → 仍会停住；外部发起的 `!bash` 也不会进消息列表（消息列表只由 `loadSession` 读文件刷新）。

- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

## Completion sound

- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

## Exported session HTML

- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

## Session list indexing (v2, 2026-09)

左栏聊天列表不再逐请求全量扫会话文件——`session_meta` 升格为会话完整索引，由后台扫描器维护。

- **`lib/session-index-scanner.ts`**：启动即扫 + 每 30s 全量扫磁盘（`scanSessionFileMeta` 递归到子目录），按 path 匹配、按 header 权威 id 建行（新行的 `task_id` 先为 NULL，随后由归属收敛从父继承——无父即临时会话），刷 `modified`（单调不回退，60s 年轻行保护 + 删除前磁盘复检），并对 `last_reply IS NULL` 的存量行读一次文件尾回填；`ensureSessionIndexReady` 供首请求前懒初始化（复用首轮 promise，不双跑），另提供 `indexSessionFileNow()` 单文件立即索引。
- **`GET /api/sessions?project=<key>`**：单项目聊天区列表，`loadProjectSessions` 纯查 session_meta（project_key 过滤 + 排除 task 会话 + 置顶/mtime 排序），union 运行中 runtime。
- **`POST /api/sessions/summary`**（body `{ids}`）：看板卡片摘要点查——画布有几张卡查几个 id，替代全量轮询自筛。
- 改名有三条路径（`PATCH /[id]`、`POST /[id]/auto-name`、RPC `set_session_name`）都「pi 成功 → 同请求写 `session_meta.title` → 失败可见」（路由 500 / RPC 记日志），不依赖扫描器。`last_reply` 也入库（schema v12）：`agent_start` 前移 `modified`，`message_end` 只在内存缓存本轮最后一条 assistant 文本，`agent_settled`（含用户取消）一次写 `last_reply + modified`；扫描器对 `last_reply IS NULL` 的存量行读一次文件尾回填（无回复写 `''`，三态：NULL=未回填/''=无回复/文本=回复）。
- 列表读取 = 纯查 session_meta（title/first_message/last_reply/modified/parent_id/project_key），**不读文件、不扫目录**；`/api/tasks` 的任务成员与 fork 子树按库 `task_id` + `parent_id` 递归（不再 readdir/读 header），`collectSessionDescendants` 同理；`resolveSessionPath` 先查库 `path`（命中且文件在 → 直接用），只在**库内无行**或**行内 path 的文件已不在**时按文件名兜底（每项目目录一次 readdir，不再全量扫）；看板卡摘要（`loadSessionSummariesByIds`）也全取库，只有该 id 在库内**完全无行**时才回退到文件头尾读。文件是存在性事实源（由后台扫描器写入），meta 是读取的事实源。
- **会话归属（2026-09）**：`session_meta.task_id` 是归属唯一事实源，按**整棵子树**存——子会话（fork / fork_branch / 内置 subagent）建行继承父 `task_id`；拖入/移出任务、删任务都连带子树（`updateTask` 的成员规范化确保「父走子不留」）；服务端在归属前用 `hasForeignTaskAncestor` 拒绝「祖先属于别的任务」（409），扫描器每轮做子继承父的收敛（自愈旧数据）。
- **聊天区时间分组（2026-09）**：前端把已排好序的根会话切成今天/昨天/本周/近一月/更久之前五段，只插小角标不改排序（`lib/session-time-group.ts` 纯分类函数：日历天判今天/昨天、周一为周首、近一月 = 滚动 30 天）。**置顶段不分组**，越过置顶分隔线后重新起头；fork 子会话跟着根所在段。
