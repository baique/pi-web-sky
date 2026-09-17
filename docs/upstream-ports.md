# 上游 PR 移植记录

本文件说明这个仓库（`@baique/pi-web-sky`）从上游 [agegr/pi-web](https://github.com/agegr/pi-web) fork 之后，**采纳了哪些上游 pull request（PR）**、各自做了什么改动，以及与上游**刻意不同**的地方。

> 先明确几个概念，阅读者无需依赖任何外部上下文：
> - **本仓库与上游的关系**：本仓库是 agegr/pi-web 的一个分叉（叫 pi-web-sky）。因为分叉后代码已大量改动（皮肤、终端等自研能力），上游合并的 PR 无法直接 `git merge`，只能把改动**手工搬过来**（下文叫「移植 / port」）。
> - **验证方式**：本项目按 `AGENTS.md` 约定，前端改动用真实浏览器（Playwright）做 e2e 验证，配合 `tsc --noEmit`、`npm run lint` 和单元测试。
> - 正文里提到的方法名 / 文件路径，都能在本仓库源码里找到，方便对照。

## 已移植的上游 PR 清单

以下 PR 的改动已经合入本仓库（提交 hash 见「本仓库提交」列）。

### #519 — 修复「关闭技能开关会把 SKILL.md 写坏」

- **问题**：`PATCH /api/skills` 开关 `disable-model-invocation` 时，若某 SKILL.md 里已显式写了 `disable-model-invocation: false`，旧代码用「值是否为真」判断 key 是否存在，于是把 `false` 当成「没有这个 key」，禁用时会在文件里**再写一行** `disable-model-invocation: true`，形成重复 key → YAML 解析失败 → 该技能从装载列表消失且 UI 无法再修复。
- **改动**：把开关逻辑抽到 `lib/skill-frontmatter.ts`（`setDisableModelInvocation`），改为「按 key 是否**存在**」判断，原地更新已有的行，只在前置块内编辑。
- **本仓库提交**：`04ac5bc`

### #590 — 大图附件压缩 + 渲染 toolResult 里的图片

- **问题**：原样把大图 base64 塞进会话历史，多轮累积会超网关请求体上限（HTTP 413）；且工具返回的图片在消息里不显示。
- **改动**：`components/ChatInput.tsx` 上传前把最长边超 1024px 的图降采样并转 JPEG（`compressImageFile`）；`components/MessageView.tsx` 渲染 toolResult 内的图片块；`hooks/useAgentSession.ts` 去掉 `deferMedia`，让历史里的图片来源随上下文返回。
- **本仓库提交**：`04ac5bc`

### #517 — 内置斜杠（`/`）命令派发优化

- **问题**：斜杠菜单打开且输入恰好等于某个内置命令（如 `/copy`）时，第一次回车只「套用补全」而不是执行，要再按一次才执行；并且 agent 运行中会把所有内置命令都隐藏。
- **改动**：`components/ChatInput.tsx` 精确匹配时一次回车直接执行；运行中仅保留只读命令（`/copy`、`/session`），Tab 仍走补全。
- **本仓库提交**：`04ac5bc`

### #536 — 支持从文件管理器复制/粘贴路径

- **改动**：新增 `lib/clipboard-paths.ts`（解析 `file://` URI、各平台剪贴板格式），并接入聊天输入框、目录选择器、插件面板、终端等粘贴场景。
- **本仓库提交**：`04ac5bc`

### #587 — 会话历史分页加载 + 修递归爆栈

- **问题**：超大会话（数千条消息）加载时要**整体传输**全部历史，且 `components/BranchNavigator.tsx` 用递归遍历树，线性深链会话会爆调用栈（`Maximum call stack size exceeded`）。
- **改动**：`lib/session-reader.ts` 的 `buildSessionContext` 支持 `tail` 切片（新增 `sliceActiveBranch`，迭代式回卷）；`app/api/sessions/[id]/route.ts` 与 `[id]/context/route.ts` 解析 `?tail` / `?before` 分页参数；`hooks/useAgentSession.ts` 支持向前补页；`components/ChatWindow.tsx` 顶部「加载更早」处触发取上一页；`BranchNavigator.tsx` 的树遍历改为迭代。
- **与上游的差异**：见下方专属说明。
- **本仓库提交**：`b5f18d9`

### #516 — 打开单个会话时不扫全量目录

- **问题**：路径缓存 miss 时，`resolveSessionPath` 会回退到 `listAllSessions()`，即解析目录里所有 `.jsonl`，打开一个会话很慢。
- **改动**：`lib/session-reader.ts` 新增 `findSessionPathByName`——按 `<timestamp>_<id>.jsonl` 的目录后缀定位候选文件，再读首行 header **校验 id**（不信任文件名），miss 才回退全量扫描。
- **与上游（竞争 PR #526）的关系**：见下方专属说明。
- **本仓库提交**：`5aa515f`

### #544 — 容忍 Chromium 去掉 Origin 端口

- **问题**：Chromium 150+ 对同源请求的非默认端口会省略 Origin 头里的端口，旧代码按「完整 canonical origin（含端口）相等」校验，于是把所有合法的 pi-web API 请求误判为跨站 → 页面报 `Error: HTTP 403`、侧边栏会话列表空白。
- **改动**：`lib/request-security.ts` 的 `isApiRequestOriginAllowed` 改为**只比较 hostname**（hostname 大小写不敏感），以 Host 头为准（Host 是请求实际去往哪里的权威来源）；host 白名单仍能拦截 DNS rebinding 和跨 loopback 名攻击。
- **与上游**：原样移植，无偏离。
- **验证**：单测新增「Origin 剥端口放行 / 跨名与 rebind 仍拒绝」；e2e 用 `Origin: http://127.0.0.1`（无端口）请求 → 200，跨主机名 → 403。

### #520 — 内联 SVG 预览加 script 拦截 CSP

- **问题**：`streamFile()` 用 `image/svg+xml` 内联输出，既无 `Content-Security-Policy` 也无 `X-Content-Type-Options`。SVG 是唯一会作为 document 执行的预览类型——仓库里的 SVG 若被直接导航（例如透过 transcript 里的链接）打开，可在 Pi Web origin 里跑脚本，进而访问任意 `/api` 路由（`PI_WEB_PASSWORD` 开启时还能碰到 Basic Auth 凭据）。
- **改动**：`app/api/files/[...path]/route.ts` 的 `streamFile`：所有 streamed 响应统一加 `X-Content-Type-Options: nosniff`；`contentType === "image/svg+xml"` 时加 `Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` 和 `Referrer-Policy: no-referrer`（与 DOCX 预览同一策略）。CSP 不影响 `<img>` 嵌入，应用内预览不变。
- **与上游**：原样移植，无偏离。
- **验证**：单测 3 条（nosniff / SVG CSP 指令 / 三种响应形态共享 headers）；e2e 直接导航带 `<script>` 的恶意 SVG → `window.__E2E520_EXECUTED__` 未执行；PNG 预览回归正常。

### #470 — 插件面板里管理 MCP server

- **问题**：本仓库此前只能在状态条看 MCP 启用了几个 server，没有 UI 管理 mcp.json（增删改查/测试连通）的入口。
- **改动**：新增 `app/api/mcp/route.ts`（GET 读全局+项目 mcp.json 合并；POST 支持 add/remove/enable/disable/update/move/test/get 8 个 action，test 会真实 spawn/请求握手并列出工具数）；`lib/api-types.ts` 加 `McpResponse`/`McpScope`/`McpServerInfo`；UI 独立组件 `components/McpConfigPanel.tsx`。
- **与上游的差异**：上游把 MCP 管理**塞进插件面板**（PluginsConfig 内加 plugins/mcp 双 tab）。本仓库 PluginsConfig 已自研（资源明细/粘贴支持等）且上游 patch 无法直接 apply，改把 MCP UI 做成**独立面板组件** `McpConfigPanel`（McpServerDetail/AddMcpServer/列表逻辑全部复用上游代码），挂在**顶栏 Terminal 按钮旁**的新入口按钮，portal 锚定触发按钮、仿终端弹窗样式。API 层（route.ts/types）原样移植。
- **本仓库提交**：（未提交）

### 上游 v0.8.10 / v0.8.11 版本级变更（4 项，合并自发布说明而非单个 PR）

以下 4 项来自上游 release notes（非独立可取 patch 的 PR），逐项手工移植，合并在同一个提交。

#### 扩展选择对话框可滚动并限制在视口内（`03dad64`，#609）

- **问题**：扩展通过 Extension UI 弹出的 `select` 对话框无上限地渲染全部选项，外层只有 `overflow: hidden`——选项多时直接溢出视口且无法滚动，选不到下面的选项。超长 `message`/`editor` 内容同理。
- **改动**：`components/ChatWindow.tsx` 的 `ExtensionDialog`：弹窗卡片改为纵向 flex（`maxHeight: 100%`），中间内容区 `flex:1 + minHeight:0 + overflowY:auto`，header/footer 固定不参与滚动。
- **注意**：该对话框仅在扩展调用 `ctx.select/confirm/input/editor` 时出现；当前已装扩展均未触发，属防御性修复。
- **本仓库提交**：`1a05cb2`

#### 删除无人消费的 `/api/agent/running/events` SSE 路由与广播器（`024be0b`）

- **问题**：侧边栏实际用可见页轮询 `/api/agent/running`（2.5s），SSE 路由和 rpc-manager 里的 running-status 广播器（`subscribeRunningSessions`/`notifyRunningChange` + 每次事件全量重算快照）没有前端消费者，纯死代码 + 无谓开销。
- **改动**：删路由、广播器及 rpc-manager 内 9 处 `notifyRunningChange()` 调用点与 `RUNNING_STATE_EVENT_TYPES`；保留轮询用的 `getRunningRpcSessionIds()`。相关单测同步收紧（断言源码中不再出现 `notifyRunningChange`）。
- **本仓库提交**：`1a05cb2`

#### 移除 `@lobehub/icons`，内联 provider 图标（`602b1b6`）

- **问题**：只为约 30 个品牌图标引入 `@lobehub/icons` 及其传递依赖。
- **改动**：新增 `components/ProviderIcons.tsx`——从包的编译产物提取 SVG path 数据生成本地组件（Mono 图标继承 `currentColor`，Color 图标 path 自带填充）；`ModelsConfig.tsx` 改引本地文件并从依赖中移除该包（净减 ~5300 行 lockfile）。
- **与上游的差异**：实现方式未对照（上游同样为「本地化图标」思路）；生成脚本为一次性用后即删。
- **本仓库提交**：`1a05cb2`

#### 文件浏览器快速搜索（`b24ecad`）

- **问题**：侧栏文件树只能逐层展开找文件，大项目里定位文件很慢。
- **改动**：服务端在 `app/api/files/[...path]/route.ts` 新增 `type=search`：从目标目录有界递归遍历（上限 20000 条目 / 12 层深 / 50 结果），复用现有允许根校验与 `IGNORED_NAMES` 忽略表，大小写不敏感子串匹配相对路径；客户端 `FileExplorer.tsx` 树上方加搜索框（200ms 防抖，Esc 清空），命中时以平铺列表替代目录树，点击直接打开文件。
- **本仓库提交**：`1a05cb2`

### 上游 v0.9.0 / v0.9.1 移植（6 项，2026-09，基于发布说明 + 单 PR）

#### #657 — Alt/Option+Enter 流式跟发

- **改动**：`ChatInput.tsx` 的 `handleKeyDown` 发送分支改为 `sendQueued((e.altKey && onFollowUp) || !onSteer ? "followup" : "steer")`——Alt+Enter 强制 followup，否则 steer 优先；follow-up 按钮 title 加快捷键提示 + `aria-keyshortcuts`。
- **与上游**：本仓库守卫（Shift 换行、IME、移动端 Ctrl/Cmd+Alt）原本已有，无额外改动。
- **本仓库提交**：（未提交）

#### #704 — 聊天内容宽度 + 字号设置

- **改动**：新增 `hooks/useChatAppearance.ts`（localStorage 持久化，CSS 变量 `--chat-content-max-width` / `--chat-content-font-size` 挂 `documentElement`，`useSyncExternalStore` 跨组件同步）；ChatWindow/ChatInput 消息与输入框 maxWidth 改 `var(...)`；MessageView 主要字号（用户气泡/md 正文/thinking/patch/compaction）加 `calc(x + var(--chat-font-size-offset, 0px))`；globals.css `:root` 加变量 + `.chat-content` 定义 offset + **`.markdown-body` / `.markdown-body table` 字号改 calc（正文字号生效的关键，漏了会导致调整不生效）**。
- **与上游的差异**：UI 入口不同，见「与上游刻意不同」。
- **本仓库提交**：（未提交）

#### #698 — 选中文本分支对话

- **改动**：新增 `lib/quoted-selection.ts`（buildQuotedSelection 转 markdown 引用）；`rpc-manager` 新增 `fork_branch` 命令（`createBranchedSession(entryId)` 复制选中 entry 到子会话，不替换源会话）；MessageView 的 AssistantMessageView 加 `data-message-role="assistant"` + `data-entry-id` 供选中定位；ChatWindow 选中助手文本弹菜单（在当前询问 → 插入主输入框；在新对话询问 → 内联引用输入框，发送读取用户编辑内容），新会话经 `initialPrompt` 自动发送；AppShell `quoteSelectionEnabled`（localStorage 开关，默认关）+ `onAskInNewChat`（fork_branch → 切新会话 + 预填 prompt）。
- **与上游的差异**：fork_branch 落盘补救、引用输入框实现、设置入口，均见「与上游刻意不同」。
- **本仓库提交**：（未提交）

#### #655 — 文件面板视频预览

- **改动**：`lib/file-types.ts` webm 从音频移入 `VIDEO_EXT_TO_MIME`（mp4/m4v/webm/mov/ogv）+ `getVideoMime`/`isVideoPath`；`app/api/files/[...path]` read/download/meta 三处 mime 合并加 video；`FileViewer.tsx` 新增 `VideoViewer`（复用 AudioViewer 的 watch/live 同步骨架），分支优先于文本预览。
- **本仓库提交**：（未提交）

#### #665 — 空闲超时可配

- **改动**：`lib/rpc-manager.ts` 新增 `resolveSessionIdleTimeoutMs()` 解析 `PI_WEB_IDLE_TIMEOUT_MS`（默认 10 分钟，`0` 禁用，上限 Node timer 2^31-1），`resetIdleTimer` 用常量且 0 时直接 return。
- **本仓库提交**：（未提交）

#### #636 — 附件给不支持图片的模型时警告

- **改动**：`app/api/models` modelList 带 `input` 模态字段（SDK 0.84.3 已支持）；`lib/models-cache.ts` 类型加 `input?: string[]`；`ChatInput.tsx` 新增 `modelSupportsImageInput()`，附加图片且选中模型明确不支持 image 时出黄色警告 banner；`hooks/useAgentSession.ts` 新会话默认模型只信 `d.defaultModel`，不再回退 `nextModelList[0]`（列表首个 ≠ 运行时默认会误报）。
- **与上游的差异**：本仓库 ModelNoticeBanner 已内置关闭按钮，未移植上游 onClose prop（行为一致）。
- **本仓库提交**：（未提交）

## 与上游刻意不同的地方（改动了原 PR 逻辑，阅读者需知悉）

### #587 分页 —— 额外增加服务端 `hasMore` 标记

- **为什么偏离**：上游实现里，`components/ChatWindow.tsx` 用「已渲染条数 ≥ 可见窗口」推断「是否还有更早的历史可加载」。但本仓库的聊天渲染会把一次工具的多个 entry **折叠成一个「Process details」块**，导致已加载的 50 条 entry 实际只产出几十个 UI 片段；当这个数字 < 50 时上层的判断就判定「没有更早」，顶部「加载更早」入口永不出现，用户无法继续向上翻历史（本仓库在一条 4382 条消息的会话上实测复现）。
- **本仓库做法**：改为服务端计算并返回 `hasMore`（`lib/session-reader.ts` 的 `hasOlderHistory()`，按 entry 链长度判断），客户端用这个布尔值决定是否显示「加载更早」。
- **注意**：用户停在顶部不动时，每次补页后入口仍在可视区，会连续加载多页直至 `hasMore` 为假——这是「上滚持续加载」的预期行为。

### #516 与 #526 —— 竞争 PR，本仓库选 #516

- 上游有两个对同一问题的 PR：#516 和 #526。二者核心思路相同（路径缓存 miss 时按文件名定位单条会话）。
- **为什么选 #516**：[#526](https://github.com/agegr/pi-web/pull/526) 额外改写了 `loadAllSessions`，只保留解析后位于默认 sessions 目录内的路径（用 `realpathSync` 过滤），这可能**误伤符号链接目录或自定义布局里的会话**；#516 不动列表逻辑、只优化正向查询，风险更低，热点路径的收益相同（PR 自测 7ms vs 322ms）。

### #698 fork_branch —— 补 SDK 惰性落盘 + 立即索引

- **为什么偏离**：本仓库 SDK（0.84.3）的 `SessionManager.createBranchedSession` **惰性落盘**——fork 点之前无 assistant 消息时不写文件（`flushed=false`），只返回路径字符串。上游 fork_branch 原样照抄（其 SDK 版本行为可能不同），在本仓库会导致返回的 newSessionId 对应文件不存在，session_meta 索引/侧栏列表/看板全部读不到，直到 30s 后台扫描删行——表现为「引用 fork 后数据库没更新」。
- **本仓库做法**：fork_branch 与既有 `fork` case 一致，手动把 header + entries 写入磁盘（`writeFileSync`），随后调 `indexSessionFileNow(forkedPath, parentSessionId)` 立即写 session_meta（不等 30s 扫描），新会话马上出现在列表。

### #698 引用输入框 —— 独立轻量 textarea 替代 ChatInput compact 复用

- **为什么偏离**：上游内联引用 composer 复用 ChatInput（`compact` 模式，改动 20 处条件分支）。本仓库 ChatInput 是打磨最狠的高频核心组件，逐处加 `compact ?` 分支回归风险高。
- **本仓库做法**：独立轻量 textarea（预填引用+问题，用户可编辑），发送时读 `textarea.value`；为空才回退默认引用文本。

### #704 / #698 设置入口 —— 暂用顶栏「偏好」弹窗，方案待定

- **上游**：宽度/字号/主题/语言等集中在 SettingsPanel（点「设置」按钮打开）。本仓库暂无 SettingsPanel（主题为顶栏按钮、语言在顶栏下拉）。
- **本仓库现状**：顶栏 Aa 按钮弹「偏好」面板，含聊天宽度、字号、选中文本询问开关。
- **待定**：是否按上游建设置面板（迁移主题/语言入口），下一轮与用户确认后再定。

## 已审查但未采用的上游改动

- **#526**：见上，被 #516 取代。
- **#581 / #319（斜杠面板中途触发 + 一次选多个 skill）**：上游至今未实现（#319 对应的 feature request 被标记 `not_planned`，仅 #581 作为 issue 存在）。要实现它需在应用层额外处理「pi 核心只展开消息开头的第一个 `/skill:`」这个限制，工作量与自制逻辑较多，暂缓（如之后要做，需单独设计）。

## 尚未移植的候选（按意愿而非优先级分组的清单，供后续排期）

- 大功能、动 UI 布局：`#522`（会话列表/文件浏览器间拖拽调分隔比例）、`#458`（侧边栏会话分组）。
- 大功能、动输入与插件：`#510`（内置 ask_user 工具 + 行内确认卡片）。

### 上游 v0.9.0 / v0.9.1 之后新增的候选（2026-09，按实用性整理）

- 文件编辑与管理：上游 v0.10.5 `0815194c`（文件手动编辑 + 文件/文件夹增删改）；git 工作区还原 `015b8ec6`（本仓库 git API 只有 diff/status）。
- 插件更新检查 + 批量更新：`#611`（本仓库 PluginsConfig 无版本检查；需抽 `lib/pi-cli.ts` 避免 child_process 进浏览器 bundle）。
- 大文本文件预览分页：上游 v0.9.1（本仓库 FileViewer 无分页，大文件一次渲染）。
- 平台/部署层：后台服务 + CLI（version/restart/logs）`abf960b5`；可读主题 v0.9.1；浏览器密码登录 v0.9.1（To G 部署场景）；内置 subagent 的 Agents 设置入口 v0.9.0/v0.9.1（本仓库 subagent 走 skill+fork，无 UI 管理入口，需评估兼容）。
- 性能/本地化：会话列表窗口化虚拟化 `#626`（本仓库已有 session_meta 缓存+索引，列表未虚拟化）；gzip 会话 JSON `#731`；繁体中文 locale `#512`。

## 移植流程备忘

若要继续从上游搬 PR：

1. 取补丁：`https://github.com/agegr/pi-web/pull/<编号>.patch`
2. 逐 PR 移植 → `tsc --noEmit` + `npm run lint` + 相关单元测试
3. 浏览器 e2e（`npm run dev`，默认端口 30143）
4. **任何对上游逻辑的偏离，都必须在本文件「与上游刻意不同」一节补一条说明**，写明为什么偏离、本仓库怎么做。
