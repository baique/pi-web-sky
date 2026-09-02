# File Map（完整文件清单）

> AGENTS.md 的详细附录。新增 API 路由 / 组件 / hook / lib 时在此登记，保持单处维护。

## app/api/

```
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
task-cards/route.ts              GET 任务卡列表(?boardId) | POST 建卡（带 node/依赖/连线）
task-cards/[id]/route.ts         GET/PATCH/DELETE 任务卡（依赖替换同步边、级联删）
task-card-questions/route.ts     GET 待回答问题列表 | POST 记录提问
task-card-questions/[id]/answer/route.ts  POST 回答（写回会话并续 run）
tasks/route.ts                  GET/POST 任务元数据（session_meta 旁路）
tasks/[id]/route.ts             GET/PATCH/DELETE（改名同步看板名；删除级联删看板）
tasks/[id]/board/route.ts       GET 任务看板（懒创建，看板 id = 任务 id）
worktrees/route.ts              GET/POST/DELETE git worktrees
```

## lib/

```
agent-client.ts      typed fetch helper for /api/agent commands
board-store.ts       boards/nodes/edges/view CRUD（SDK-free，对照 task-store）
task-card-store.ts   任务卡元数据 CRUD（task_cards/links/questions，SDK-free）
board-purge.ts       孤儿看板卡片清理（排除 taskcard kind）
task-scheduler.ts    任务调度器（派发/审核冷却/巡检/问答队列，S2/S3）
audit-session.ts     会话审核快照读取（调度器用）
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
```

## components/

```
AppShell.tsx        layout + URL state + tab management
SessionSidebar.tsx  session tree + FileExplorer
SessionStatsSummary.tsx  session stats compact summary（统计弹层第一行，复用 AppShell 顶栏格式）
ChatWindow.tsx      chat composition + completion sound wrapper
canvas/             board mode components：SessionCanvas / SessionWorkbench / SessionNavBar /
                    CanvasStage / BoardSearch / ThemedSelect / BoardSection / BoardContextMenu
board/              RF 自定义节点：SessionCardNode / TaskCardNode / StickyNoteNode /
                    BoardCanvasContext / BoardContextMenu / BoardIdContext / nodePosition
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
```

## hooks/

```
useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
useAudio.ts         completion sound + browser AudioContext unlock
useBoardCanvas.ts   board canvas: yjs/Hocuspocus 绑定 + running/摘要轮询 + addNewSessionCard/deleteNode
useTaskCards.ts     task card 数据 hook（详情/候选卡/建卡/保存）
useBroadcast.ts     composer broadcast slots (left phase / right notices, P0-P3 priority)
useDragDrop.ts      shared drag/drop state
useIsMobile.ts      responsive breakpoint hook
useKeyboardShortcuts.ts  global keyboard shortcuts + module-level abort handler registry
useResizablePanel.ts    resizable side panel state
useTheme.ts         theme state
useViewportHeight.ts    visual-viewport height sync while the mobile keyboard is open
```
