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

## 与上游刻意不同的地方（改动了原 PR 逻辑，阅读者需知悉）

### #587 分页 —— 额外增加服务端 `hasMore` 标记

- **为什么偏离**：上游实现里，`components/ChatWindow.tsx` 用「已渲染条数 ≥ 可见窗口」推断「是否还有更早的历史可加载」。但本仓库的聊天渲染会把一次工具的多个 entry **折叠成一个「Process details」块**，导致已加载的 50 条 entry 实际只产出几十个 UI 片段；当这个数字 < 50 时上层的判断就判定「没有更早」，顶部「加载更早」入口永不出现，用户无法继续向上翻历史（本仓库在一条 4382 条消息的会话上实测复现）。
- **本仓库做法**：改为服务端计算并返回 `hasMore`（`lib/session-reader.ts` 的 `hasOlderHistory()`，按 entry 链长度判断），客户端用这个布尔值决定是否显示「加载更早」。
- **注意**：用户停在顶部不动时，每次补页后入口仍在可视区，会连续加载多页直至 `hasMore` 为假——这是「上滚持续加载」的预期行为。

### #516 与 #526 —— 竞争 PR，本仓库选 #516

- 上游有两个对同一问题的 PR：#516 和 #526。二者核心思路相同（路径缓存 miss 时按文件名定位单条会话）。
- **为什么选 #516**：[#526](https://github.com/agegr/pi-web/pull/526) 额外改写了 `loadAllSessions`，只保留解析后位于默认 sessions 目录内的路径（用 `realpathSync` 过滤），这可能**误伤符号链接目录或自定义布局里的会话**；#516 不动列表逻辑、只优化正向查询，风险更低，热点路径的收益相同（PR 自测 7ms vs 322ms）。

## 已审查但未采用的上游改动

- **#526**：见上，被 #516 取代。
- **#581 / #319（斜杠面板中途触发 + 一次选多个 skill）**：上游至今未实现（#319 对应的 feature request 被标记 `not_planned`，仅 #581 作为 issue 存在）。要实现它需在应用层额外处理「pi 核心只展开消息开头的第一个 `/skill:`」这个限制，工作量与自制逻辑较多，暂缓（如之后要做，需单独设计）。

## 尚未移植的候选（按意愿而非优先级分组的清单，供后续排期）

- 大功能、动 UI 布局：`#522`（会话列表/文件浏览器间拖拽调分隔比例）、`#458`（侧边栏会话分组）。
- 大功能、动输入与插件：`#510`（内置 ask_user 工具 + 行内确认卡片）、`#470`（插件面板里管理 MCP server）。

## 移植流程备忘

若要继续从上游搬 PR：

1. 取补丁：`https://github.com/agegr/pi-web/pull/<编号>.patch`
2. 逐 PR 移植 → `tsc --noEmit` + `npm run lint` + 相关单元测试
3. 浏览器 e2e（`npm run dev`，默认端口 30143）
4. **任何对上游逻辑的偏离，都必须在本文件「与上游刻意不同」一节补一条说明**，写明为什么偏离、本仓库怎么做。
