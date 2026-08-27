# 项目经验（pi-web-sky）

> 只记录隐含的、约定的、从代码中无法直接获取的信息。任务清单/验收报告类内容不在此保存。

## 毛玻璃（backdrop-filter）的坑

1. **嵌套 backdrop-filter 无效**：子元素再挂 backdrop-filter 时不会重新采样背景（父级已有 blur 时尤其明显），只会得到实心色块。做法：去掉嵌套层，把背景 alpha 调低让它读作玻璃片（2026-08 玻璃改造 q6 的结论）。
2. **topbar 的 backdrop-filter 会成为 fixed 后代的 containing block**：顶栏面板若内联渲染会被困在顶栏坐标系里、随右侧面板收窄而偏移。必须 portal 到 `<body>` 并用按钮 rect 锚定（AppShell.tsx 内有注释，todo/语言/系统面板均此模式，新面板照抄）。

## 端口约定

- `npm run dev` / `start`：127.0.0.1:30143（见 package.json）；历史上有过 30141/30142 双实例并存时期，遇到旧文档提到这两个端口一律以 package.json 为准。

## 会话 / 目录（pi 硬约束）

1. **pi 新建会话必须选 cwd（目录）**，会话文件按 `sessions/<encoded-cwd>/<ts>_<id>.jsonl` 落盘；cwd 即物理归属。
2. **pi 没有会话 cwd 迁移/移动命令**：移动 .jsonl 会破坏引用。因此会话的组织归属（项目/任务）一律走旁路元数据，文件原地不动（2026-08-27 项目管理设计的地基）。
3. `~/pi-cwd-<YYYYMMDD>` 一键默认 scratch 目录机制已存在（`app/api/default-cwd/route.ts`：创建 + allowFileRoot），临时会话的零门槛入口复用它。

## web-search key 配置坑（2026-08-27）

- `web-search.json` 的 `tavilyApiKey` 优先级**低于**环境变量 `TAVILY_API_KEY`（`pi-web-access/credential-source.ts`：`return normalize(environmentValue) ?? source`）。
- 曾在 `.bashrc` 注入过一个旧 key，拦截所有搜索（Tavily 432 usage limit）；修复 = 从 `.bashrc` 删除该行，让 `web-search.json` 成为唯一真相源。不要在 shell 环境里重复配置搜索 key。

## node:sqlite 全文检索（2026-08-27 侧边栏任务/搜索）

- `node:sqlite` 22.13+ 免 flag（引擎要求 ≥22.19 满足）；本地 v25 验证 FTS5 + trigram 可用。
- **中文必须 trigram**：`unicode61` 把整段 CJK 当一个 token（"修复登录接口" 成一个词），子串搜不到；trigram 按 3 字符滚动索引，CJK 子串可命中。
- trigram 查询 **<3 字符不命中**（"登录" 搜不到）→ 用 FTS 表 `LIKE '%q%'` 兜底（trigram 对 LIKE 有索引加速，实测通过）。
- FTS5 `MATCH` 不能出现在 CASE 等表达式里（"unable to use function MATCH"）——titleMatch 用单独的 `title MATCH` 查询判定。
- 特殊字符查询需引号转义：`'"' + q.replace(/"/g,'""') + '"'`。
- **`.mjs` 测试文件不能写 TS 类型注解**：node `--experimental-strip-types` 只处理 `.ts`，`.mjs` 里的 `: Type`/`!` 直接 SyntaxError。
- 数据层 lib（sqlite-db/task-store/session-search）保持 **SDK-free**（getAgentDir 本地实现 `~/.pi/agent` + `PI_CODING_AGENT_DIR`），纯 node 测试不加载 pi-coding-agent（其 dist 无扩展相对导入在 node ESM 下解析失败）；测试用 jiti 加载 `.ts`（与现有测试一致），或注入 sessionsOverride 避免真实会话扫描。
- 单库 `~/.pi/agent/pi-web.db`：tasks / session_meta（会话↔任务归属，jsonl 不动）/ search_state / session_search(fts5 trigram)。
- 会话归属（tasks）按 `project_key`（= workspaceKeyOf），切目录任务即切换；搜索跨项目全局。
