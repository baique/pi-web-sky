# File Map（完整文件清单）

> AGENTS.md 的详细附录。新增 API 路由 / 组件 / hook / lib 时在此登记，保持单处维护。
> **登记了但代码里已不存在的条目比漏登记更有害**——改路由 / 删文件时当场把对应行删掉或改对。
> lib 段按主题分组（组内无先后），查文件先看组名。

## app/api/

```
sessions/route.ts               GET ?project=<key> 单项目无分页 | 无参全量（看板/跨项目）
sessions/[id]/route.ts          GET/PATCH/DELETE session（PATCH name/pinned 同请求写 session_meta；DELETE 把子行 parent_id 改写祖父：磁盘 header + 库同请求，文件已丢失也归零）
sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf（?tail/?before 分页）
sessions/[id]/export/route.ts   GET exported HTML for a session（深链递归助手改迭代，防爆栈）
sessions/[id]/minimap/route.ts  GET ?leafId= 时间轴导航条（ChatMinimap）的轻量 turn 索引（只带标题摘要，不带 content）
sessions/[id]/state/route.ts    GET 运行中会话的实时 state（无 wrapper 时只回 running:false，不读文件；会话不存在 404）
sessions/[id]/todos/route.ts    GET 只取最新 pi-todo.state 快照（会话切换/开面板时拉一次，无轮询）
sessions/[id]/auto-name/route.ts POST 用模型生成会话标题（setSessionName 成功后同请求写 session_meta.title，失败 500 + 日志可见）
sessions/[id]/entries/[entryId]/thinking/route.ts  GET 单条 thinking 块按需取（长思考懒加载）
sessions/summary/route.ts       POST { ids } — 看板卡片摘要点查（库优先；该 id 在库内完全无行时才回退文件头尾读）
agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId?, id? （可指定会话 id）}
agent/[id]/route.ts             GET state | POST any command
agent/[id]/events/route.ts      GET SSE stream
agent/[id]/bash-output/route.ts GET ?path= 读该会话引用的 bash 输出临时文件（内联限长 / 下载流式）
agent/running/route.ts          GET currently-running session ids
app-update/route.ts             GET 与 npm 最新版比对（12h 缓存），返回是否有新版本 + release 链接
auth/all-providers/route.ts     GET API-key provider list
auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
auth/logout/[provider]/route.ts POST OAuth logout
auth/providers/route.ts         GET OAuth provider list
board-assets/route.ts           POST 上传画布图片 → { url }（服务端持久化到看板资源目录）
board-assets/[...path]/route.ts GET 读图（只读，不列目录）| DELETE 删图回收磁盘（删 ImageNode 时调；只放行纯文件名，拒目录穿越）
cwd/browse/route.ts             GET ?path= 列可读子目录（目录选择器；含 Windows 盘符）
cwd/validate/route.ts           POST validate/select a cwd
default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
file-index/route.ts             GET 仓库文件索引（git ls-files，@ 提及模糊搜索用；per-cwd 缓存）
files/[...path]/route.ts        GET 文件内容（预览 / 下载 / type=search 快速搜索）| POST 上传文件（upload / upload-check，带同名冲突策略）
git/diff/route.ts               GET 单文件 diff（cwd 须在允许根内）
git/status/route.ts             GET 工作区状态（worktree 目录已删则回退主项目根）
home/route.ts                   GET user home directory
mcp/route.ts                    GET 合并全局+项目 mcp.json | POST add/remove/enable/disable/update/move/test/get
models/route.ts                 GET { models, modelList, defaultModel, modelScopeWarnings }
models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
models-config/catalog/route.ts  GET models.dev pricing presets
models-config/discover/route.ts POST fetch a configured provider's upstream model list
models-config/test/route.ts     POST test a configured model/provider（真实握手）
plugins/route.ts                GET/POST package plugin management
project-trust/route.ts          GET/POST 项目信任状态（未信任时 SDK 用保守选项）
quota/route.ts                  GET provider 额度/用量（DeepSeek 峰谷计价）
search/route.ts                 GET 全局搜索（任务卡 + 会话，命中判别联合见 lib/search.ts）
skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
skills/install/route.ts         POST install skills through npx skills add
skills/search/route.ts          POST 搜 skills.sh（npx skills find）
skills/check/route.ts           POST 检查技能包是否可更新（逐技能状态）
skills/update/route.ts          POST 走 npx 更新技能包
boards/route.ts                 GET list（缺省全量，系统「运行中」看板恒前置）| POST create
boards/[id]/route.ts            GET | PATCH rename | DELETE（级联删节点/边/视图 + 销毁 yjs 文档；系统看板只读 403）
boards/[id]/add-session/route.ts POST { sessionId, title? } 侧栏把会话拖到「看板」行 → 服务端写 yjs 落一张会话卡（目标看板无需打开；系统看板 403）
boards/[id]/reconcile/route.ts  POST 触发该看板的后端派生 reconcile（「刷新画布」按钮；已连 provider 走 yjs 广播拿到结果）
boards/reorder/route.ts         PUT 手动看板排序
task-cards/route.ts             GET 任务卡列表(?boardId) | POST 建卡（readyStatus 默认 todo；不再写画布节点，nodeId 概念已废弃）
task-cards/[id]/route.ts        GET/PATCH/DELETE 任务卡（依赖替换同步边、级联删）
task-cards/unbind/route.ts      POST { sessionId } 解除任务卡与执行会话的绑定（普通看板移除执行卡时调：清 session_id，非终态卡结算「放弃」）
task-card-questions/route.ts    GET 问题列表（?status=pending|answered|all；提问记录由调度器/卡流程写库）
task-card-questions/[id]/answer/route.ts  POST 作答（置 answered；续跑由调度器回复队列拾取）
task-scheduler/status/route.ts  GET 调度器状态（当前派发中的任务 + 最近一次调度动作）
tasks/route.ts                  GET 任务列表（每任务附 session_meta 派生的会话详情分页 offset/limit + rootTotal/sessionTotal）| POST 建任务
tasks/[id]/route.ts             GET（可按 ?offset/?limit 取该任务会话分页）/PATCH（先补全列行再按子树闭包改归属；改名同步看板名）/DELETE（删该任务全部会话树 + 级联删看板）
tasks/[id]/board/route.ts       GET 任务看板（懒创建，看板 id = 任务 id；建板后立即 reconcile 补卡）
tasks/[id]/assign-session/route.ts POST { sessionId } 归属会话及其整棵子树到任务（先补全列行 + 祖先守卫，祖先属别的任务 409 / 会话解析不出 404）
tasks/reorder/route.ts          PUT { projectKey, orderedIds } 批量重排任务（按置顶/非置顶区分别调）
terminal/route.ts               GET 终端会话列表 | POST 新建终端 { cwd, cols?, rows? }
terminal/[id]/route.ts          GET 元信息 | POST { input | resize } | DELETE 杀进程
terminal/[id]/events/route.ts   GET SSE 输出流（?since=<byteOffset> 回放 + 实时）
worktrees/route.ts              GET/POST/DELETE git worktrees（dirty 未强制删除 → 409）
yjs-version/route.ts            GET yjs 文档全局版本号（重建一次 +1；前端连接时核对，防内存旧副本把历史同步回来）
subagents/[id]/route.ts         GET 子代理运行状态 | POST steer/abort
subagents/settings/route.ts     GET/PUT 内置 subagent 设置（启用开关/并发数）
subagents/profiles/route.ts     GET/PUT/PATCH/DELETE 子代理 profile（目录扫描 + 保存/启停/删除）
```

## lib/

```
# ---- 看板 / 画布 ----
board-store.ts       boards 表 CRUD（reorder / getOrCreateTaskBoard / deleteBoardCascade / renameTaskBoard / removeSessionFromBoards）；nodes/edges/view 是 tldraw 遗留表，只被级联清空与旧数据清理触及，画布渲染走 yjs
yjs-room-server.mjs  yjs 协同房间服务器（Hocuspocus 内嵌：documentName = boardId，持久化 sync.db，服务端权威写入口）
board-types.ts       看板类型定义 + SYSTEM_RUNNING_BOARD_ID = "__running__"
board-reconcile.ts   后端派生 reconcile（补会话卡 / exec 线 / fork 线 / 依赖线、会话卡与任务卡孤儿删、findFreeSpot）+ addSessionCardToBoard（拖入落卡）
board-reconcile-scheduler.ts  10s 定时兜底 reconcile（仅 leader 实例执行）
board-events.ts      看板跨组件事件桥（window.dispatchEvent：open-file/forked/renamed/…）
board-assets.ts      看板图片上传辅助（POST /api/board-assets → 图片 URL）
board-assets-dir.ts  看板图片落盘目录（~/.pi/agent/board-assets）
board-align.ts       画布对齐参考线（拖拽/缩放吸附计算）
card-emoji.ts        看板卡 emoji：默认值 / 状态跟随映射 / 随机集合（纯函数，状态 emoji 不落库）
card-time.ts         看板卡底栏时间格式（当天时:分，跨天 月/日 时:分）
note-time.ts         便笺默认标题时间格式

# ---- 会话读写 / 索引 / 归属 ----
session-reader.ts   SessionManager wrappers + 路径缓存 + buildSessionContext 适配 + loadProjectSessions / loadAllSessionIndex / loadSessionDetailsFromMeta（纯查 session_meta）+ loadTaskSessionsPage（任务成员与 fork 子树按库 task_id/parent_id 分页）+ loadSessionSummariesByIds（看板摘要点查，库优先、库内无行才读文件）+ resolveSessionPath / resolveSessionIdByPath（库 path 优先，名字兜底）
session-index-scanner.ts  后台扫描器：启动即扫 + 每 30s 全量扫磁盘（scanSessionFileMeta 递归）建/刷 session_meta，按 header 权威 id 建行、path 优先匹配、modified 单调、60s 年轻行保护 + 删除前磁盘复检、last_reply 三态回填、子继承父的归属收敛；indexSessionFileNow 供新文件立即索引
session-scanner.ts  会话文件定向读：scanSessionFileMeta（目录项+stat，递归，不读内容）/ scanOneSessionHead（header + 首条消息）/ readSessionTail（反向分块取名字 + lastReply）/ scanOneSessionFile（单文件详情，库内无行时的回退）；全量 scanSessionFiles / sessionScanner.scan 已删
session-path.ts     会话文件路径归一化 key（Windows 大小写不敏感）
session-delete.ts   删会话文件 + 递归收集/删除子会话（级联）
session-family.ts   会话家族：把可见会话与其 subagent 后代会话归为一家（relation.kind === "subagent"；listSessionFamilies / getSessionFamily）——**当前全仓无调用方**，列表 API 也不注入 relation，属于未接线的会话级 UI
session-search.ts   会话全文搜索（FTS5 trigram + LIKE 兜底）
session-stats.ts    会话统计行格式（in/out/cache/cost/context，与 AppShell 共用）
session-timing.ts   会话累计活跃时长（computeSessionTotalActiveMs）
session-time-group.ts  聊天列表时间分组（sessionTimeGroup：今天/昨天/本周/近一月/更久之前，纯分类不排序）
session-title.ts    AI 生成会话标题（提示词组装 + 解析并返回；持久化由 auto-name 路由负责）
session-file-references.ts  判断某文件路径是否被会话引用（删文件前校验）
session-file-references-core.ts  上者的纯逻辑（正则/边界判定，可单测）
session-row-context-menu.ts  会话行右键菜单事件桥（dispatchSessionRowContextMenu）
audit-session.ts    审核/阻塞判定（runAuditVerdict / runBlockCheck）+ 执行会话尾部反读快照 readSessionAuditSnapshot
workspace-memory.ts 每个工作区「上次打开的会话」记忆（切项目恢复现场）
prompt-recovery.ts  用户消息指纹（文本 + 图片签名）——重发/恢复判定用
initial-navigation.ts  URL 首屏导航参数解析（?cwd / ?session / ?board）

# ---- 会话运行（RPC / agent 事件）----
rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession + 子代理控制器接线
agent-client.ts     typed fetch helper for /api/agent commands
agent-event-wire.ts agent 事件线上格式（toClientAgentEvent / 快照包含判定）
agent-event-stream.ts 服务端 agent 事件流（createAgentEventStream）
agent-event-connection.ts 浏览器侧 SSE 连接封装（重连/错误状态/关闭）
session-activity.ts  会话活跃事件 → 库写入意图纯函数（agent_start→touch modified；message_end 只缓存本轮最后一条 assistant 文本；agent_settled→last_reply+modified，含用户取消；tracker 按 wrapper 实例持有，非模块级）
agent-phase.ts      会话相位 → 文案 + 思考球模式（phaseLabel / orbModeForPhase）
streaming-message.ts  流式消息状态机（streamReducer，纯函数）
tool-execution-progress.ts  从 partialResult 取工具执行最新一行进度（截断 500 字）
tool-names.ts       write/edit 工具名判定（含 MCP 前缀形式）
compaction-summary.ts  解析 compaction 摘要里的 read-files / modified-files 段
chat-only.ts        chat 专用小工具（chat-only 模式裁剪）
todo-store.ts       内建 todo 纯数据层（三态 + 快照解析 + 4 action 校验，可单测）
todo-extension.ts   内建 todo 内联扩展（注册 `todo` 工具 / 落盘 pi-todo.state / 回放 / auto-clear / 节奏提醒）
custom-ui-terminal.ts  扩展自定义 UI 的无头 TUI 终端（扩展 ctx.ui 桥接）
bash-output.ts      bash 输出临时文件解析与有界读取（内联展示限长）

# ---- 聊天展示 ----
message-display.ts 助手消息展示块拆分（可显示块 / 错误信息 / 尾部最终答案块）
message-text.ts     extractMessageMarkdown — 消息取 markdown 文本（钉卡快照）
turn-merge.ts       时间轴导航条回合拼装（DOM 回合 + 服务端 turnIndex 合并，纯函数）
turn-written-files.ts  本轮写入/修改的文件提取（TurnWrittenFiles 卡片）
patch.ts            unified diff 解析为 SplitDiff（并排 diff 视图）
markdown.ts         shared markdown helpers
frontmatter.ts      YAML frontmatter 解析/格式化（技能、提示词卡片）
file-links.ts       本地文件 href/path 解析（markdown 内链 → 打开文件）
file-fuzzy.ts       @ 提及的文件模糊搜索（索引构建 + 查询解析 + 插入文本）
clipboard.ts        copyText
clipboard-paths.ts  从剪贴板/拖放数据提取本地路径（Windows/macOS/Linux）
image-attachments.ts  图片附件大小/数量校验与 base64 字节数计算
chat-lazy-load.ts   聊天可见窗口与滚动恢复（分页渲染、尾部跟随、锚点占位）
quoted-selection.ts  buildQuotedSelection — 选中文本转 markdown 引用（#698）
slash-display.ts    技能展开内容还原成 `/skill:` 命令显示（只影响展示）
ansi.ts             ANSI 转义序列解析（终端输出 / 自定义面板行）
browser-notifications.ts  浏览器通知投递判定（可见性/焦点/抢占）

# ---- 任务与调度 ----
task-store.ts       任务 CRUD + session_meta 归属/索引写入（ensureSessionMetaRow/ensureSessionRows 建全列行、归属按子树 assignSessionSubtreeToTask/listDescendantIds、祖先守卫 hasForeignTaskAncestor、删会话 reparentSessionChildren、事件写入口 touchSessionActivity/recordSessionOutcome）
task-card-store.ts  任务卡元数据 CRUD（task_cards/links/questions，SDK-free）
task-scheduler.ts   任务调度器（派发/审核冷却/巡检/问答队列，S2/S3）
scheduler-leader.ts  多实例 leader 选举（10s 心跳 / 30s 过期接管）
search.ts           全局搜索：任务卡 + 会话（判别联合命中）
settings-navigation.ts  设置面板分区导航/路由态

# ---- 模型 / provider ----
models-cache.ts     models 列表缓存 + 安全失败兜底
models-config-store.ts  ~/.pi/agent/models.json 读写与成本归一化
model-catalog.ts    models.dev 目录（定价预设、匹配评分、推荐）
model-discovery.ts  拉取 provider 上游模型列表并解析
model-discovery-auth.ts  发现模型所需的鉴权选择
model-id-preference.ts  模型选择器「显示 id 而非显示名」偏好（localStorage）
model-scope.ts      enabledModels（--models 语法）解析——委托 SDK，绝不字面比较
provider-listing.ts provider 列表（按声明的鉴权能力，双鉴权 provider 只出现一次）
provider-listing-runtime.ts  ModelRuntime → provider 列表输入的适配
provider-credential-store.ts  写/删 provider 凭据（与 pi 存储同锁，按类型删）
provider-services.ts  provider 服务工厂（登录/凭据相关聚合）
deepseek-pricing.ts  DeepSeek 峰谷计价（北京时间，额度展示用）
startup-preferences.ts  会话启动时持久化显式选择的模型/思考级别（不重放 setter）
tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
tool-preset-preference.ts  browser-persisted default for fresh sessions

# ---- 文件 / 路径 / 安全 ----
file-access.ts      allowed file roots for /api/files and worktrees
path-security.ts    isPathWithinRoots / isExistingPathWithinRoots（文件白名单唯一实现）
allowed-roots.ts    额外允许根（allowFileRoot）+ 分隔符归一化
paths.ts            isWindowsAbsolutePath / toNativePath / toSlashPath / samePath
file-paths.ts       client/server path encoding helpers
file-types.ts       预览类型判定（文本/图片/音频/视频/文档 + mime 表）
file-upload.ts      上传冲突策略与目标校验（同名策略解析）
file-viewer-state.ts  文件查看器显示模式/换行/滚动位置态
file-dirent.ts      目录项类型兜底判定（符号链接等走 statSync）
bounded-form-data.ts  formData 体积上限保护（RequestBodyTooLargeError）
directory-browser.ts  目录浏览（Windows 盘符候选、父目录、解析）
atomic-file.ts      原子写私有文件（先写临时再 rename）
request-security.ts API 同源校验（hostname 比较 + JSON content-type）
web-auth.ts         浏览器密码登录（Basic Auth 校验，PI_WEB_PASSWORD）
http-dispatcher.ts  undici HTTP dispatcher 配置（idle timeout）
id.ts               前端 id 生成 newId()——别裸调 crypto.randomUUID（非安全上下文不存在）
api-types.ts        前端用 API 响应类型集合（各 route 的返回形状）
types.ts            shared TypeScript types
pi-types.ts         local structural types for pi SDK objects
normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types

# ---- 项目 / 工作区 / git ----
worktree.ts         project/worktree resolution and git worktree operations
project-groups.ts   最近项目列表与项目活动（侧栏项目切换）
project-identity.ts 项目身份 key（projectRoot 归一）
project-tree.ts     会话树投影（浅树 + 分支预览，供 BranchNavigator）
project-trust.ts    项目信任状态读写（未信任时 SDK 保守选项）
project-command-env.ts  项目命令环境净化 + bash 扩展（覆盖 pi 内置）
git-changes.ts      工作区改动 + 单文件 diff（服务端）
git-status.ts       git porcelain v1 解析与状态分类
git-types.ts        git 状态/diff 的共享类型

# ---- 终端 ----
terminal-manager.ts 终端会话管理（创建/写入/resize/环形缓冲/输出游标）
terminal-input.ts   键盘事件 → 终端输入序列（含 bracketed paste）

# ---- 技能 / 插件 ----
npx.ts              npx runner used by skill install
skills-service.ts   加载技能并附安装信息（与运行时同一加载器）
skill-frontmatter.ts  setDisableModelInvocation（按 key 存在与否原地改写，不写重复 key）
skill-lock.ts       全局技能锁文件路径 + 安装信息来源标注
skill-updates.ts    技能更新检测与更新参数组装

# ---- 设置与偏好 ----
wallpaper-settings.ts  壁纸与画布 scrim 设置（scrimAlpha/scrimBlur → --board-scrim-*，持久化 + CSS 变量 + 边缘取色）
bg-image.ts         useAppBackground：背景图 IndexedDB 读取
powershell-settings.ts  PowerShell 工具开关（settings.json 读写 + 工具替换）
pin-store.ts        钉卡 store（跨会话浮窗：内容快照 + 位置/尺寸，useSyncExternalStore）
draft-store.ts      内存态草稿缓存（get/set/clear/rekey；刷新即失，无持久化）
draft-stash.ts      草稿暂存（增删改查 + 相对时间）
panel-layout.ts     侧栏/右面板宽度常量与 clamp
dropdown-direction.ts  下拉展开方向判定（空间不足时向上）

# ---- 子代理（上游内置运行时；完整说明见 docs/reference/subagents.md）----
subagents.ts        子代理类型/常量（SUBAGENT_CONTROL_TOOL_NAMES / SubagentRunInfo / SubagentProfile）
subagent-runtime.ts 内置 subagent 运行时（子会话执行/恢复/收尾）
subagent-queue.ts   子代理 per-parent 并发队列
subagent-extension.ts   Agent/steer_subagent 工具注册 + 剔除冲突的 legacy pi-subagents 扩展
subagent-settings.ts    builtInEnabled / maxConcurrent 设置读写（isBuiltInSubagentsEnabled）
subagent-input.ts   子代理输入组装（文件/消息上下文）
subagent-prompt.ts  子代理提示词拼接
subagent-profile-precedence.ts  同名 profile 被更高优先级来源覆盖的判定（builtin < global < workspace < project）

# ---- 杂项 ----
i18n/registry.ts    语言包注册表（registerLocale / getSupportedLocales，见 docs/i18n.md）
i18n/types.ts       LocalePlugin / Locale 类型
i18n/format.ts      文案插值与回退（缺 key 先回落 en，再回落 key 本身）
i18n/messages/*.ts  内置语言包 en / zh-CN（键集以 en 为准，缺 key 开发期告警）
sqlite-db.ts        SQLite 单例 + 版本化迁移（SCHEMA_VERSION = 12；session_meta 13 列含会话索引列 + last_reply）
app-update.ts       版本比较与 release 链接
```

## components/

```
AppShell.tsx        layout + URL state + tab management
SessionSidebar.tsx  session tree + FileExplorer + 会话/文件 tab（SessionTabs）
session-sidebar-list.ts  侧栏会话列表纯规则（段内排序：置顶段 → 运行中浮顶 → modified 降序；时间分组角标与置顶分隔线；拖拽深度 SESSION_DEPTH_MIME / parseSessionDepth / 归属落点守卫 membershipDropAllowed / sessionRowDraggable）
session-membership-feedback.ts  assignmentFailureDetail：归属/落卡失败响应的「人话细节」（服务端 error 文本优先，取不到回退状态码；永不抛）
SessionStatsSummary.tsx  session stats compact summary（统计弹层第一行，复用 AppShell 顶栏格式）
SidebarGlobalSearch.tsx  侧栏全局搜索结果浮层（会话 + 任务卡命中，跨项目）
TaskArea.tsx        任务区（项目任务树、拖拽排序、新建/改名/删除、拖入会话归属）
TodoList.tsx        会话 TODO 面板内容本体（表头/空态/条目），顶栏右上角与看板卡片顶栏两处共用
SessionTabs.tsx     侧栏「会话 / 文件」tab 切换
ChatWindow.tsx      chat composition + completion sound wrapper
NoticeDrawer.tsx    通知抽屉（浮层展示历史通知，portal 到 body）
AnimatedDropdown.tsx  带动画的下拉外壳（开启动画 + 关闭后卸载，方向可翻转）
canvas/             board mode components：SessionCanvas / SessionWorkbench / SessionNavBar /
                    CanvasStage / BoardSearch / BoardSearchContext / BoardControls / BoardLoading /
                    BoardTopbar（左上功能区）/ SchedulerPanel（右上调度器状态面板）/
                    ThemedSelect / BoardSection（侧栏看板栏目，含会话拖入落卡）/
                    ConfirmDialog（命令式确认，Promise 化）/ EmojiPickerField / GlassScopeContext /
                    TaskCardMultiSelect / WorktreePicker / board-glass
board/              RF 自定义节点：SessionCardNode / TaskCardNode / StickyNoteNode / ImageNode（贴图）/
                    RenameButton（改名铅笔）/ SendNoteEdge（便笺→会话发送线）/ BoardCanvasContext /
                    BoardContextMenu / BoardIdContext / memoNode
ChatInput.tsx       input bar + model/thinking/tools/compact controls
MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
BranchNavigator.tsx in-session branch switcher
ChatMinimap.tsx     scroll minimap alongside the message list
MarkdownBody.tsx    markdown renderer
ModelsConfig.tsx    models.json 编辑（设置面板"模型"分区嵌用，侧栏底部按钮为入口）
PluginsConfig.tsx   已安装包插件管理（设置面板"插件"分区嵌用）
SkillsConfig.tsx    已加载/可搜索/可安装技能（设置面板"技能"分区嵌用）
FileExplorer.tsx    file tree inside sidebar
FileIcons.tsx       file icon helpers
FileViewer.tsx      file content in a tab (source / preview / diff)
TabBar.tsx          右栏文件 tab 条（仅打开的文件 tab；样式与顶栏 tab 一致）
file-tab-state.ts   文件 tab 打开/复用 + 查看器状态保存（openFileTab / saveFileViewerState）
models-config-helpers.ts  模型配置表单辅助（成本字段、兼容性条目、header 行增删）
ComposerHeader.tsx  composer resident top bar: left phase broadcast slot + right chips (outbox ⏳ / TODO) + quota slot
DraftStash.tsx      input draft stash (Ctrl+S stash / Ctrl+Delete delete, cross-session)
ExtensionStatusBar.tsx  底部 widget 槽容器；通知抽屉（NoticeDrawer）的宿主
ExtensionWidgets.tsx    renders extension-injected widgets
PinnedBubble.tsx    pinned-message floating bubble (global drag + resize)
TerminalPanel.tsx   multi-session web terminal panel (xterm.js + server-side pty)
McpConfigPanel.tsx  MCP server manager popover (global/project mcp.json, connectivity test)
SettingsPanel.tsx   设置弹窗主体（通用/模型/技能/代理/插件分区，SettingsUi 提供布局件）
SettingsUi.tsx      设置面板布局件（ConfigPanel/ConfigSplitView/ConfigSidebar/…）
AgentsConfig.tsx    内置 subagent 设置（启用开关 + 并发数 + profile 管理）
AgentSessionPanel.tsx   子代理会话列表/切换器（搜索 + 状态 + 选中切换）——**当前未挂载**，全仓无引用
ToolDefinitionsPanel.tsx  工具定义详情浮层（视口 45% 宽）
ModelSelector.tsx   模型选择器（内置模型搜索/分组）
WorktreeSelector.tsx  worktree 选择器（侧栏，分支/主 checkout + 新建）
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
useChatAppearance.ts  聊天宽度/字号设置（localStorage + CSS 变量，#704）
useAudio.ts         completion sound + browser AudioContext unlock
useBoardCanvas.ts   board canvas: yjs/Hocuspocus 绑定 + running/摘要轮询 + addNewSessionCard/addSessionNode/deleteNodeWithConfirm
useTaskCards.ts     task card 数据 hook（详情/候选卡/建卡/保存）
useBroadcast.ts     composer broadcast slots (left phase / right notices, P0-P3 priority)
useCardGlass.ts     卡片玻璃（节点内嵌视口对齐的模糊壁纸层，flow→屏幕坐标换算）
useGlassWallpaper.ts  预模糊壁纸切片（气泡档/chrome 档 CSS 变量生成）
useProviderQuota.ts  provider 额度轮询与展示态
useI18n.tsx         文案 i18n（字典 + 语言切换）
useDragDrop.ts      shared drag/drop state
useIsMobile.ts      responsive breakpoint hook
useKeyboardShortcuts.ts  global keyboard shortcuts + module-level abort handler registry
useResizablePanel.ts    resizable side panel state
useTheme.ts         theme state
useViewportHeight.ts    visual-viewport height sync while the mobile keyboard is open
```
