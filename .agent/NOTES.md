# 项目经验（pi-web-sky）

> 只记录隐含的、约定的、从代码中无法直接获取的信息。任务清单/验收报告类内容不在此保存。

## 毛玻璃（backdrop-filter）的坑

1. **嵌套 backdrop-filter 无效**：子元素再挂 backdrop-filter 时不会重新采样背景（父级已有 blur 时尤其明显），只会得到实心色块。做法：去掉嵌套层，把背景 alpha 调低让它读作玻璃片（2026-08 玻璃改造 q6 的结论）。
2. **topbar 的 backdrop-filter 会成为 fixed 后代的 containing block**：顶栏面板若内联渲染会被困在顶栏坐标系里、随右侧面板收窄而偏移。必须 portal 到 `<body>` 并用按钮 rect 锚定（AppShell.tsx 内有注释，todo/语言/系统面板均此模式，新面板照抄）。

## 预模糊壁纸切片（2026-09-01 玻璃优化）

方案：换壁纸 / 拖 offsetX / resize 时用 canvas 生成「视口对齐的模糊壁纸」图（气泡档 → `--glass-bg-image`，chrome 档固定 12px → `--glass-bg-image-heavy`），气泡 / 四边 chrome（侧栏 / 顶栏 / 文件面板 / composer / 状态栏）用 `background-attachment: fixed` 显示自己位置那一块 → 滚动 / 拖拽零实时 blur。无壁纸时一律纯色跟随主题，**不写 backdrop-filter 回退**（纯色背景 blur 无可见效果）。核心实现：`hooks/useGlassWallpaper.ts` + `.glass-canvas` class + 气泡 `bubbleSurface`。

### 坑 1：Turbopack dev 的 globals.css 不热更（改 CSS 必须重启）
- Next 16 官方确认 bug（vercel/next.js#93052，CSS HMR invalidation race，2026-08-31 关闭为 duplicate；16.3.2~16.3.4 均未含修复）。
- `experimental.turbopackFileSystemCacheForDev: false` **无效**（持久化缓存不是根因）。
- `next dev --webpack` **不可行**：本项目 `@earendil-works/pi-tui` 会被打进 browser bundle，webpack 解析 `fs`/`os` 失败——这正是 dev 只能用 Turbopack 的原因（build 用 webpack 走 production 路径不冲突）。
- 结论：**改 globals.css 后重启 dev；JS/TSX 改动 HMR 正常**。

### 坑 2：Lightning CSS 把 CSS 文件里的 backdrop-filter 转坏
- Tailwind 4 内置 Lightning CSS，会把 CSS 文件里的标准 `backdrop-filter` 转成 `-webkit-backdrop-filter` **并丢弃标准属性**；而 Chrome **不认 `-webkit-backdrop-filter`**（computed 返回 none）。→ 写进 globals.css 的 backdrop-filter 在 Chrome 全部失效（`.glass-panel` 等看似正常是背景色半透明在撑观感）。
- 绕法：**backdrop-filter 一律用 JSX 内联 style**（气泡一直如此所以没踩），或**干脆不写**（无壁纸纯色方案，见上）。

### 坑 3：canvas 模糊壁纸图不透明，盖住半透明背景色 → 透明度滑块失效
- 背景图（模糊壁纸）是不透明的，把 `background-color`（含 `--bubble-alpha` 的 token）完全盖住，调透明度没反应。
- 必须叠色层：`background-image: linear-gradient(var(--token), var(--token)), var(--glass-bg-image)`。token 本身含 alpha（如 `--user-bg-glass` 含 `--bubble-alpha`）→ 透明度生效且自动跟随深浅主题。

### 坑 4：滑块拖动卡顿的根因不是 canvas 生成，是 React 重渲染
- 实测：`onChange` 每格 → `updateWallSettings` → AppShell 巨型组件重渲染（单格 20ms+ 主线程阻塞，超 16ms 帧预算）；canvas 生成反而被防抖挡住、PNG 编码只要几 ms。
- 解（`GlassSlider` 组件）：滑块改「本地 state 即时显示 + 松手 / 键盘提交全局」→ 拖动中只重渲染面板小组件，AppShell 零重渲染。
- 拖动中实时预览：`previewBubbleBlur` 直接写 CSS 变量（不经过 React），防抖 120ms，**只重算气泡档不碰 chrome 档**；生成版本号递增防过期覆盖。
- 重生成防抖 400ms（连续拖 offsetX / 滑块时停顿后才生成）；生成降采样 0.5（模糊图对清晰度不敏感）。

### 坑 5：调试壁纸注入（playwright 环境 file chooser 受限）
- 调试时点壁纸按钮会弹 file chooser，playwright 安全限制无法选择文件（modal 卡住会拦截后续所有工具调用，需用 file_upload 处理或刷新）。
- 改用 IndexedDB 写入：`fetch('/test-assets/wallpaper-jinx.jpg') → blob → indexedDB('pi-web') store('bg-image') put(blob,'wallpaper')`，reload 即生效（走 useAppBackground 读取路径）。
- 测试壁纸已入库 `public/test-assets/wallpaper-jinx.jpg`（来源 `/mnt/d/Download/`），别删。

### 坑 6：进程操作自杀
- `pkill -f "next dev"` 会匹配到自身 bash 命令行（含 "next dev" 字样）→ 把自己杀了。用 `pkill -f "[n]ext dev"`（方括号正则）或精确 PID。
- **系统服务可能用 next-server 跑别的服务，不要全局杀 next-server**；只杀自己起的 dev（用 tmux 会话管理，见下）。

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
