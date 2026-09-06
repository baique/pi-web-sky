# 会话生命周期与文件格式

> 改会话加载 / 分支 / SSE / compaction / 运行状态轮询 / 会话文件读写前阅读。

## AgentSession lifecycle (`lib/rpc-manager.ts`)

- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

## Fork must destroy the wrapper immediately

`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

## Two kinds of branching — don't confuse them

- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

## Session files can be fully rewritten

`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

## ToolCall field normalization

Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

## New session tool preset

Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

## Specified session id + create-on-persist

New sessions can carry a client-chosen id: `POST /api/agent/new` accepts an `id` field (validated against the SDK's `assertValidSessionId` rule: alphanumerics plus `-_.`, must start/end alphanumeric). `startRpcSession` passes it to `SessionManager.create(cwd, dir, { id })`, so the real session id equals the client-supplied one — the caller knows the id **before** the session is ready, which is what task/board bindings rely on (no draft-card waiting, no polling to "promote").

Pi delays the first JSONL flush until an assistant message exists. Pi Web overrides this with `persistNewSessionFile()` in `startRpcSession`: the empty header is written immediately and the manager is marked `flushed`, so a session exists on disk from birth and survives page reloads. This also makes the old `persistBashOnlySession` fallback unnecessary (removed).

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

## SSE reconnect on page refresh mid-stream

On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

## Compaction SSE events

Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

## Running state polling + reconciliation

- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
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

- **`lib/session-index-scanner.ts`**：启动即扫 + 每 30s 全量扫磁盘（`scanSessionFileMeta`），建行/刷 mtime/删行，幂等。`ensureSessionIndexReady` 供首请求前懒初始化（复用首轮 promise，不双跑）。
- **`GET /api/sessions?project=<key>`**：单项目聊天区列表，`loadProjectSessions` 纯查 session_meta（project_key 过滤 + 排除 task 会话 + 置顶/mtime 排序），union 运行中 runtime。
- **`GET /api/sessions/summary`**（POST `{ids}`）：看板卡片摘要点查——画布有几张卡查几个 id，替代全量轮询自筛。
- 改名 `PATCH /[id]` 同步写 `session_meta.title`（不依赖扫描器）。lastReply 不入库，列表/卡片尾读文件。
- 列表读取 = stat(存在/mtime) + meta(title/pinned) + 尾读(lastReply) 结合；文件是存在性事实源，meta 是标题/归属持久层，不做主动补行。
