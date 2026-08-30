# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30143
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.  

## 发布 npm

发布 / 发版 / `npm publish` / 升级版本号 / `npm run release` 时，先读 [`.agent/release.md`](.agent/release.md) — 发布方式、token 位置、版本同步约定、故障排查都在那里。

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

**Board mode** (会话看板): selecting a board (`?board=`) replaces the ChatWindow area with the tldraw canvas (`SessionCanvas`) — the sidebar stays visible, exiting / clicking a session / new-session returns to chat. Board layout (nodes/edges/camera) lives in SQLite via `lib/board-store.ts` (SDK-free, versioned migrations v3–v5), never in session files. Task boards mirror task sessions (`boards.task_id`): opening a task auto-creates its board and reconciles cards on open + 10s poll.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  boards/route.ts                 GET list (projectKey) | POST create
  boards/[id]/route.ts            GET | PATCH rename | DELETE (cascade nodes/edges/view)
  boards/[id]/canvas/route.ts     GET canvas | PUT save (乐观锁 + 空覆盖保护)
  boards/[id]/nodes/...           node CRUD（卡片/便笺布局）
  boards/[id]/edges/...           edge CRUD（连线）
  boards/reorder/route.ts         POST 手动看板排序
  tasks/route.ts                  GET/POST 任务元数据（session_meta 旁路）
  tasks/[id]/route.ts             GET/PATCH/DELETE（改名同步看板名；删除级联删看板）
  tasks/[id]/board/route.ts       GET 任务看板（懒创建，看板 id = 任务 id）
  worktrees/route.ts              GET/POST/DELETE git worktrees

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  board-store.ts       boards/nodes/edges/view CRUD（SDK-free，对照 task-store）
  board-types.ts       看板类型定义 + SYSTEM_RUNNING_BOARD_ID = "__running__"
  board-events.ts      看板跨组件事件桥（window.dispatchEvent：open-file/forked/renamed/…）
  board-utils.ts       看板工具（shouldRemoveEndedCard 等）
  board-scrim-settings.ts  画布 scrim 磨砂设置持久化
  session-stats.ts     会话统计行格式（in/out/cache/cost/context，与 AppShell 共用）
  task-store.ts        任务元数据 CRUD（session_meta 旁路，boards.task_id 联动的源头）
  sqlite-db.ts         SQLite 单例 + 版本化迁移（SCHEMA_VERSION = 5，boards 于 v3–v5）
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  SessionStatsSummary.tsx  session stats compact summary（统计弹层第一行，复用 AppShell 顶栏格式）
  ChatWindow.tsx      chat composition + completion sound wrapper
  canvas/             board mode components：SessionCanvas / SessionCardShape / SessionWorkbench /
                      StickyNoteShape / BoardSection / CanvasStage / SessionNavBar / BoardToolbar
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)
  ComposerHeader.tsx  composer resident top bar: left phase broadcast slot + right chips (outbox ⏳ / TODO) + quota slot
  DraftStash.tsx      input draft stash (Ctrl+S stash / Ctrl+Delete delete, cross-session)
  ExtensionStatusBar.tsx  bottom widget shelf container; hosts NoticeInline for temporary notices
  ExtensionWidgets.tsx    renders extension-injected widgets
  PinnedBubble.tsx    pinned-message floating bubble (global drag + resize)
  TerminalPanel.tsx   multi-session web terminal panel (xterm.js + server-side pty)
  McpConfigPanel.tsx  MCP server manager popover (global/project mcp.json, connectivity test)
  DirectoryPicker.tsx cwd directory picker for new sessions
  FrontmatterCard.tsx frontmatter card rendering in markdown
  ImagePreview.tsx    image preview lightbox
  MermaidBlock.tsx    mermaid diagram rendering
  ProjectTrustDialog.tsx  project trust confirmation dialog
  ProviderIcons.tsx   provider logo icons
  PwaRegistration.tsx PWA service-worker registration
  TurnWrittenFiles.tsx    files written this turn (buttons opening each in the viewer)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useBoardCanvas.ts   board canvas: load/save(防抖单飞)/running snapshot/reconcile/findFreeSpot/addDraftCard
  useBroadcast.ts     composer broadcast slots (left phase / right notices, P0-P3 priority)
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useKeyboardShortcuts.ts  global keyboard shortcuts + module-level abort handler registry
  useResizablePanel.ts    resizable side panel state
  useTheme.ts         theme state
  useViewportHeight.ts    visual-viewport height sync while the mobile keyboard is open
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### 会话看板（boards）—— 数据层铁律
- **迁移**：`lib/sqlite-db.ts` `SCHEMA_VERSION = 5`（v3 建 boards/board_nodes/board_edges/board_view → v4 `sort_order` → v5 `task_id`）。看板是旁路元数据，会话 jsonl 原地不动。
- **事务铁律**：SQLite 不支持嵌套 BEGIN。`deleteBoardCascade` / `renameTaskBoard` **必须无事务**，由调用方（`deleteBoard` / `deleteTask` / `updateTask`）在自身事务内调用。board-store 的 `deleteBoard` 保持"自开事务"行为。
- **任务即看板**：看板 id = 任务 id（`boards.task_id` 非空即任务型看板）。`GET /api/tasks/[id]/board` 懒创建；`deleteTask` 事务内级联删看板；`updateTask` 改名同步 `renameTaskBoard`。
- **系统「运行中」看板**：`SYSTEM_RUNNING_BOARD_ID = "__running__"`，只读、跨项目自动聚合运行中会话，不落 boards 表。

### 空画布保护（防看板被清空）
- `PUT /api/boards/[id]/canvas` **默认拒绝用空 nodes 覆盖已有内容的看板**（返回 `empty-overwrite` → 409）——客户端状态未加载完成时全量保存会把看板清空，这是血泪教训。
- 用户显式「清空画布」才传 `allowEmpty: true` 放行；客户端物化完成前禁止自动保存。
- 乐观锁：客户端必须带读取快照时的 `boards.updated`（`baseUpdated`），期间被他人保存过则拒绝写入。

### 任务即看板自动补卡
- `reconcileTaskSessions`：打开时 diff + 复用 10s 摘要轮询周期 diff，差集（任务会话中无卡片者）→ `addSessionNode`。
- `findFreeSpot(editor)`：收集现有 session-card 矩形，从 (60,60) 按行扫描（y 增 x 增），找与所有卡片**不重叠且间隙 ≥ 24** 的第一个空位——右下方向找空位，天然不遮挡。
- 任务看板**不提供"从看板移除任务会话卡片"**（要移除即移出任务），否则被 diff 补回造成语义冲突。
- `BoardSection` 列表**过滤 `taskId == null`**：任务看板不混入手动看板列表（任务行本身即入口）。

### 卡片即工作台（tldraw）
- tldraw 5.x，`next/dynamic` ssr:false 按需加载（体积 ~1MB，仅进看板时下载）。自定义 shape 用 `BaseBoxShapeUtil`。
- 卡片两态：收合卡（340×160）↔ **展开即工作台**（同一卡片放大，默认 760×600，非弹窗）。展开态工作台 = portal 浮层 + `1/zoom` 反补偿，`zoom < 60%` 降级骨架态。
- **draft 卡**：`sessionId` 为空的卡（新建会话），输入消息绑定真实会话后转正（`bindDraftSession`）。
- 卡片内改名：内联输入 → `PATCH /api/sessions/[id]` → `dispatchBoardSessionRenamed` 事件桥刷左侧树 + 摘要轮询刷新标题。

### tldraw 集成陷阱
- tldraw 全局 `user-select:none` 会禁用画布内文本选中——工作台消息区与便笺 markdown 必须显式恢复选中（根因同源）。
- 便笺是**自研 markdown 便笺**（`StickyNoteShape`），不要用 tldraw 内置 Note（拖拽会出两个控件）。
- 看板卡片内的 `position:fixed` 弹层（如 BranchNavigator 下拉）会被 `backdrop-filter` 容器劫持导致漂移 → portal 到 body；卡片内展开时用 `[data-session-titlebar]` 定位对齐标题栏。
- 便笺 `createdAt` 用 `useState` 惰性初始化，禁止 render 期 `Date.now()`（lint purity）。
- 卡片状态以展开卡内 `useAgentSession` 的 SSE 为准，看板聚合态以 `/api/agent/running` 轮询为准——双源不打架。
- 看板 URL `?board=` 持久化；退出看板 / 点会话 / 新建即回聊天。

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
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

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

### 消息气泡内层级 token（`--bubble-*`）

气泡内所有表面共用一套层级 token，定义在 `:root`（引用 `--border` / `--tool-bg-glass` 的会自动跟随明暗主题，无需在 `.dark` 重复）。整体调观感改这一处即可，组件里不要散落 magic number：

```
--bubble-pad-x / -pad-y / -pad-end   气泡内边距
--bubble-gap                         气泡内块间距
--bubble-radius                      气泡卡片圆角（12）
--bubble-inner-radius                气泡内嵌套块（工具/思考/代码）圆角（7）
--bubble-meta-fs / -title-fs         元信息 vs 强调行（模型名）字号
--bubble-border                      气泡边框色（border 60%）
--bubble-hairline                    所有 hairline 分隔线（border 55%）
--bubble-tool-bg / -hover / -fold    工具/思考块玻璃底三态（58/80/28%）
--bubble-code-bg                     代码块近实底（bg 92% + panel）
--bubble-th-bg                       表格表头 / 代码 header 次级底（bg-panel）
--bubble-file-bg / -file-chrome      文件预览阅读区近实底 / chrome 加深层
```

组件约定（工具块 `ToolCallBlock` / 思考块 `ThinkingBlock`）：
- 工具块：折叠态是无背景的轻行，展开才浮现玻璃块（`--bubble-tool-bg`）；两态 header 的 padding 必须一致，避免展开时边距 / 高度跳变。
- 思考块：折叠态同样是轻行（✧ 图标 + 思考 + 时长）；展开后是**纯文本注记**——零背景零边框，仅左侧一条细线标识思考区。思考是长文本阅读区，不用玻璃 / 卡片，最长文也舒服。
- 工具 / 思考块**不加整圈彩色边框**，状态用圆点 / 图标表达，只用一根极淡 `--bubble-border` 中性描边。
- header 内不两端对齐：时长紧跟文字（不用 `marginLeft:auto`）。

### 画布 scrim（`--board-scrim-*`）

画布内容层之下、壁纸之上的一层磨砂（SessionCanvas），右上角滑块驱动：

```
--board-scrim-alpha / -bg / -blur
```

- 磨砂只为 blur 不动饱和度（深浅色一致观感）；`blur` 为 0 时把 `backdrop-filter` 置 `none`，避免 `saturate` 残留仍去饱和背景。
- token 在 `:root` 定义，明暗主题共用同一套，不用在 `.dark` 重复。

### 思考球 loading（`thinking-orbs`）

Agent 运行状态用 [`thinking-orbs`](https://www.npmjs.com/package/thinking-orbs)（0.3.1，MIT）做加载球：
- **agent 状态行**：玻璃胶囊 `.chat-status-pill`（近实底 `--bubble-code-bg` + 文字 `--text`），内嵌 `ThinkingOrb size=20`。状态映射：`waiting_model → breathing`、`running_tools / running_command → working`。
- **思考块**：`isStreaming` 时折叠行 ✧ 换成 `ThinkingOrb state="breathing" size=20`；展开区 `deferred` 内容拉取中（loading）用 `state="searching"`。
- **模型载入 / 切换中**（`ChatInput` 模型槽）**不用 orb**：用普通转圈（13px 弧线 svg + 全局 `@keyframes spin`）。orb 专供「模型正在跑」，载入态要与之区分。
- **主题必须显式传** `theme={isDark ? "dark" : "light"}`（来自 `useTheme().isDark`），不要用库默认 `auto`——项目主题由 `localStorage` 强制，`auto` 会误判。
- **浅色主题对比度**：库 light 主题墨色上限只有 ~158 中灰，浅底上太淡。浅色（`!isDark`）下给 orb 加 `filter: brightness(0.57) contrast(1.15)`（墨色≈90 近黑），深色不加。
- orb 的 size 只有 tuned 的 `64 | 20` 两种，行内一律用 20。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
