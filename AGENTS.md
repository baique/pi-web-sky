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

## Git 工作流（新功能合并规范）

**新功能一律从 main 拉分支开发，合并回 main 只保留一条提交**：

```bash
# 1. 从 main 拉开发分支
git checkout main && git pull
git checkout -b feat/<描述>
# 2. 开发…可多次提交（过程提交随意，最终会被 squash）
# 3. 合并回 main（squash，只留一条）
git checkout main && git pull
git merge --squash feat/<描述>
git commit -m "feat(<scope>): 一句话描述"
# 4. 删分支
git branch -D feat/<描述>
```

- 用 `git merge --squash` 而非 `--no-ff`：合并进 main 时**不带 merge 提交、不带功能分支历史**，main 保持线性。
- 提交信息遵循 conventional commits（`feat/fix/docs/chore/refactor` + 可选的 `<scope>`），一条提交描述完整功能。
- **`chore: release` 提交与版本 tag 是发布锚点，绝不 squash 或删除**（v0.1.x tag 指向 release 提交）。
- 复杂功能可在分支内多次提交，但**合并进 main 前必须压成一条**（`git merge --squash` 天然做到）。

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

**Board mode** (会话看板): selecting a board (`?board=`) replaces the ChatWindow area with the React Flow canvas (`SessionCanvas`) — the sidebar stays visible, exiting / clicking a session / new-session returns to chat. **画布已迁移到自研（React Flow + yjs，2026-09）**：每看板一个 Y.Doc（`@hocuspocus/server` 内嵌：`server.mjs` + `lib/yjs-room-server.mjs`，同端口），画布文档持久化到 `~/.pi/agent/sync.db` 的 `yjs_documents` 表；前端 `HocuspocusProvider` 连接（CRDT 自动合并，无全量保存/乐观锁/409）。业务派生边（exec/依赖线/会话卡/任务卡）由**后端 reconcile** 从业务表渲染（`lib/board-reconcile.ts`）。旧 `lib/board-store.ts` 的 nodes/edges 表废弃保留。`__running__` 系统看板已移除。

---

## 核心铁律（Top Traps）

每轮开发几乎都会碰到，必须记牢。更完整的主题细则见 [参考索引](#参考索引docsreference)。

- **AgentSession wrapper 挂在 `globalThis.__piSessions`**：`globalThis` 存活 Next.js 热重载，模块级 Map 不行。并发 `startRpcSession()` 共享单个 start Promise（`__piStartLocks`），空闲 10 分钟超时。
- **fork 必须立即 destroy wrapper**：`AgentSession.fork()` 原地改内部状态——fork 后 `inner.sessionId` 已是新会话 id。wrapper 留在注册表会导致后续请求拿到已 fork 状态、fork 链损坏。`send("fork")` 拿到 `newSessionId` 后立刻 `this.destroy()`。
- **会话文件可整体重写**：`parentSession` 仅展示元数据，对聊天内容零影响；删会话级联重挂子节点可安全 `writeFileSync` 整文件。
- **ToolCall 字段归一化**：pi 存 `{type:"toolCall", id, name, arguments}`，组件用 `{toolCallId, toolName, input}`；`lib/normalize.ts` 的 `normalizeToolCalls()` 在文件加载和流式事件两处都要调。
- **看板空画布保护**：`PUT /api/boards/[id]/canvas` 默认拒绝空 nodes 覆盖已有内容（`empty-overwrite` → 409）——防客户端未加载完成把看板清空；用户显式清空才传 `allowEmpty: true`。
- **SQLite 事务铁律**：不支持嵌套 BEGIN。`deleteBoardCascade` / `renameTaskBoard` 必须无事务，由调用方（`deleteBoard` / `deleteTask` / `updateTask`）在自身事务内调用。
- **看板双源状态**：卡片内状态以展开卡的 `useAgentSession` SSE 为准，看板聚合态以 `/api/agent/running` 轮询为准——不要混用打架。
- **SSE 重连**：`ChatWindow` mount 时若 `state.isStreaming === true` 自动重连；compaction 事件新旧两套都要认（`compaction_*` / `auto_compaction_*`）。
- **运行状态轮询**：2.5s 轮询、后台 tab 暂停；prompt 用单调 run id，旧 run 的迟到 SSE / 慢 reconciliation 必须忽略，防复活过期流式气泡。
- **worktree 路径比较用 `samePath()` 绝不用 `===`**：git 在 Windows 也输出 POSIX 路径，读出来先过 `toNativePath()`；分支名不是路径，保留正斜杠。
- **文件白名单只有一个实现**：`isPathWithinRoots()`（`lib/path-security.ts`）是 `isFilePathAllowed()` 的唯一实现，重解析 + case-fold 两侧，别另起炉灶。
- **yjs 画布铁律**：① `nodeTypes`/`edgeTypes` 必须模块级常量（引用不稳定 → 每次渲染重建 → 连接堆积）；② 派生元素（会话卡/exec线/依赖线）由**后端 reconcile** 权威渲染（确定性 id 幂等），前端只做用户布局增量，**不做孤儿清理**（多端不互相删卡）；③ 节点内交互用 RF 原生 `nowheel`/`nodrag`/`nopan`（可滚动区 nowheel、按钮输入 nodrag）；④ 节点必须有 `<Handle>` 才能连线。详见 [boards.md](docs/reference/boards.md)。
- **RF 不设全局 `user-select:none`**：便笺/message 文本选中复制天然可用，无需 tldraw 时代的手动恢复/拦截 hack。
- **`enabledModels` 是 `--models` 语法**：minimatch glob / 模糊匹配 / `:thinkingLevel` 后缀，绝不能当字面字符串比较；交给 `lib/model-scope.ts` 委托 SDK 解析。

---

## 参考索引（docs/reference/）

详情都拆到 `docs/reference/`，**改什么读什么**，不要在 AGENTS.md 重复：

| 主题 | 文件 | 什么时候读 |
|---|---|---|
| 会话生命周期 | [docs/reference/sessions.md](docs/reference/sessions.md) | 改会话加载 / 分支 / SSE / compaction / 运行状态轮询 / 会话文件读写 / 会话文件格式 |
| 会话看板 | [docs/reference/boards.md](docs/reference/boards.md) | 改看板 / 画布 / **派生边 reconcile（后端权威）** / 任务即看板 / 便笺 / scrim / React Flow 节点 / yjs 数据层 |
| 看板交互与事件层 | [docs/reference/board-events.md](docs/reference/board-events.md) | 改卡片交互 / 滚轮 / 右键菜单 / 事件劫持 / 焦点 / 新增自定义 shape 卡片 |
| 认证与模型 | [docs/reference/auth-models.md](docs/reference/auth-models.md) | 改 provider 列表 / 登录 / models.json / 模型选择 / enabledModels / 思考级别 |
| Worktree 与文件白名单 | [docs/reference/worktrees-files.md](docs/reference/worktrees-files.md) | 改 worktree / 项目分组 / /api/files / 文件浏览权限 |
| 任务卡 | [docs/reference/task-cards.md](docs/reference/task-cards.md) | 改任务卡 / 任务卡数据模型 / 依赖线 / 执行会话线(exec) / 任务卡表单 / 任务卡删除 |
| 插件与技能 | [docs/reference/plugins-skills.md](docs/reference/plugins-skills.md) | 改 /api/plugins / /api/skills / 技能开关 / 插件安装移除 |
| 完整文件清单 | [docs/reference/file-map.md](docs/reference/file-map.md) | 新增 API 路由 / 组件 / hook / lib，或要查某文件职责 |
| CSS 变量体系 | [docs/reference/css-tokens.md](docs/reference/css-tokens.md) | 调 UI 观感 / 加样式 / 气泡 token / scrim / 思考球 |

---

## 文档约定

AGENTS.md 只保留每轮都需要的核心铁律与速览；长主题按上表拆到 `docs/reference/` 渐进式加载。新增一个主题时：先在 `docs/reference/` 建文件、内容归位，再在「参考索引」加一行指针（含触发分支），不要往 AGENTS.md 正文堆细节。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
