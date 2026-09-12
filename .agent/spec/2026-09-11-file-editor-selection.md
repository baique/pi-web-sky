# 文件面板内嵌编辑器选型调研（2026-09-11）

需求：右侧文件查看面板不止看，要能改。覆盖 html / js / md / txt / csv。可选"干脆找个轻量级 vscode"。

调研方式：本地代码结构 + npm 制品实测（下载 tarball / 实际 esbuild 打包量体积）+ 首方文档核对。
所有体积数字都是本次实测，不是社区传言。

---

## 0. 结论速览

| 定位 | 方案 | 一句话 |
|---|---|---|
| **推荐** | CodeMirror 6 | 226KB gz 拿到全部要的能力，0 个 worker、0 个打包配置，唯一代价是没有 JS/TS 真类型提示 |
| 想要"真 VSCode 手感" | Monaco 0.56 | 583KB gz（编辑器本体）+ 语言 worker，换来 IntelliSense；要处理 worker 与 Next 打包 |
| 真的想要 VS Code 整个 IDE | 另起 `openvscode-server` / `code serve-web` 进程 + iframe | 不是"内嵌编辑器"，是"应用旁边再挂一个应用"，与 pi-web 的 UI 完全割裂 |
| 不引依赖 | 现有只读视图 + 编辑态 | 只解决 txt/csv/html 少量小文件，体验上限很低（无高亮、无撤销栈、无跳行） |

**"轻量级 vscode" 这个说法要拆开看**：VS Code 值钱的东西（LSP、扩展宿主、终端、工作区）没有轻量版本。`@codingame/monaco-vscode-api` 是把完整 VS Code 服务层搬到浏览器，实测包体 32.8MB 解包、社区报告 Vite 产物 170MB 级——比装一个 code-server 更重。**要么 Monaco（只要编辑器），要么独立进程（要整个 IDE），中间没有第三个甜点。**

---

## 1. 硬数据对比（本次实测）

### Monaco Editor 0.56.0

`monaco-editor@0.56.0`（2026-07-20 发布，latest）

| 项 | 大小 |
|---|---|
| npm tarball | 18.3 MB |
| 解包 | 98 MB |
| `min/vs`（AMD 发行版） | 24 MB |
| **`min/vs/editor-*.js`（编辑器本体，minified）** | **2.3 MB raw / 583 KB gzip** |
| `min/vs/assets/ts.worker-*.js` | 7.03 MB raw / **1.47 MB gzip** |
| `min/vs/assets/css.worker-*.js` | 1.05 MB raw / 232 KB gzip |
| `min/vs/assets/html.worker-*.js` | 714 KB raw / 183 KB gzip |
| `min/vs/assets/json.worker-*.js` | 404 KB raw / 117 KB gzip |
| `min/vs/assets/editor.worker-*.js` | 273 KB raw |
| ESM `esm/vs/` 分目录 | editor 8.6 MB / languages 13 MB / base 2.6 MB / platform 1.4 MB / nls 1.7 MB |

**0.56.0 的好消息**（首方 CHANGELOG 已核对）：ESM 入口重构成可 tree-shake 的粒度——
`monaco-editor/editor`、`features/<feature>/register`、`languages/definitions/<lang>/register`、`languages/features/register.all`，可以只打包 html/css/json/ts 语言服务。同时 0.56 新增 "Exposes typed native LSP client and transport APIs"，Monaco 现在能直接对接语言服务器。

**必须付的集成成本**（首方 `docs/integrate-esm.md` 已核对）：语言服务跑在 worker 里，要自己产出 5 个 worker 包，并实现
```js
self.MonacoEnvironment = { getWorkerUrl(moduleId, label) { ... 5 个分支 ... } };
```
- webpack：`monaco-editor-webpack-plugin@7.1.1`（最后发布 2025-10-10，peer `webpack ^4.5.0 || 5.x`）——**不支持 Turbopack**，本项目 `next build --webpack` 能挂但属于给 Next 打补丁的活
- Vite：`?worker` 后缀；Parcel：另写构建脚本
- 绕开方式：把 `min/vs` 拷进 `public/`（~24MB，可按语言裁剪），用脚本标签加载 AMD loader，`loader.config({ paths: { vs: '/monaco/vs' } })`——等于自建 CDN，最省事但要往仓库塞静态资源

`@monaco-editor/react@4.7.0` 的默认行为（读源码 `@monaco-editor/loader@1.7.0/lib/es/config/index.js` 确认）：
```js
{ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs' } }
```
**默认走 CDN、且钉在 0.55.1**。零配置能跑起来，但离线不可用、版本滞后于本地 node_modules。对"本机开发工具"这类产品，CDN 依赖是个真实的失败点（断网、企业内网、CSP）。

### CodeMirror 6

实测：用 esbuild 打一个真实配置（`basicSetup` + html/javascript/css/json/markdown/python + oneDark 主题）：

| 项 | 大小 |
|---|---|
| **打包产物（minified ESM）** | **662 KB raw / 226 KB gzip** |
| 依赖解包 | `@codemirror/*` 3.2 MB + `codemirror` 44 KB |
| **worker 文件** | **0 个**（`find` 全包扫描确认） |
| **打包配置** | **0 行** |

单包体积（npm 解包 / bundlephobia）：
`codemirror`(元包) 364KB min / 116KB gz · `@uiw/react-codemirror` 147KB / 47.6KB gz · `@codemirror/lang-html` 77KB · `lang-markdown` 71KB · `lang-javascript` 63KB · `lang-css` 40KB · `lang-json` 10.5KB · `@codemirror/language-data` 70KB（按需懒加载全部语言）· `@codemirror/merge` 179KB（真三方 diff 视图）· `@codemirror/theme-one-dark` 19.6KB

**规模对比：Monaco 编辑器本体单块 583KB gz，CodeMirror 全套 226KB gz。Monaco 还要另加语言 worker（html+css+json 三项合计 532KB gz，js/ts 再加 1.47MB gz）；CodeMirror 一个 worker 都不需要。**

CodeMirror 的代价：没有 TypeScript 语言服务，`lang-javascript` 只做语法高亮 + 关键字补全，没有类型检查/跳转定义。要真智能提示得自己桥 LSP，那就与 Monaco 的复杂度持平了。

### 完整 VS Code 内嵌路线

| 方案 | 形态 | 代价 |
|---|---|---|
| `code serve-web`（VS Code 官方 CLI 内建命令） | 起 HTTP 服务，浏览器开真 VS Code workbench | 需本机装 `code` CLI；独立进程 + 端口 + token；已知 localhost + WebSocket 升级问题（microsoft/vscode#315003，2026-05 仍开着） |
| `gitpod-io/openvscode-server` | 同上游 VS Code，官方市场 | 另一个 Node 进程 + 端口；无官方 iframe 嵌入 API，跨帧通信只能 hack `workbench.html` + postMessage |
| `coder/code-server` | 同上，Open VSX 市场，配置项更多 | 同 |
| `Eclipse Theia` | IDE 框架，可裁剪 | 是"再写一个 IDE"，不是"给现有 UI 加编辑器" |
| `@codingame/monaco-vscode-api@36.2.7` | 把 VS Code 服务层塞进浏览器 | 解包 32.8MB；官方 issue #602 报告 Vite 产物 170MB；#136 报告 webpack 单包 1.05→1.55MB 后触发 JS 内存上限 |

**这几条都不是"轻量"。** 而且它们共同的问题是：与 pi-web-sky 现有的会话/看板/worktree 语义完全脱节——用户在 iframe 里改文件，侧边栏的 agent 会话、git diff、@ mention 全都感知不到。

---

## 2. 落到本项目必须处理的五件事（与选哪个编辑器无关）

读代码确认（`components/FileViewer.tsx` 1488 行 / `app/api/files/[...path]/route.ts` 710 行）：

1. **没有写接口。** `GET` 只支持 `read|download|meta|preview|watch|search|list`，`POST` 只有 `upload|upload-check`。要新增 `PUT`，并且必须复刻 `upload` 已有的三道闸：`getAllowedFileRoots()` → `isFilePathAllowed()` → `isExistingFilePathAllowed()`（realpath 防符号链接逃逸）。
2. **写盘要原子。** `lib/atomic-file.ts` 已有 `writePrivateFileAtomicSync`（临时文件 + rename + 0600）。但它是给凭据文件用的（权限 0600），业务文件直接复用会改掉原文件权限，要么加 `mode` 参数，要么另写一个。
3. **会与 agent 打架。** `FileViewer` 已经在挂 `type=watch` 的 SSE，agent 每次写文件都会推到前端。用户正在编辑时 agent 改了同一个文件 → 必须有脏标记 + 冲突提示（"磁盘已变更，重载 / 保留我的"），否则用户的编辑会被静默覆盖或静默丢弃。
4. **256KB 上限。** `TEXT_PREVIEW_MAX_BYTES = 256 * 1024`，`read` 直接 413。Monaco 打开大文件会卡（社区经验：>10k 行要特殊处理，模型不 dispose 会内存泄漏）；CodeMirror 的分段解析更耐受，但也要给编辑态单独设一个上限并把超限文件降级为只读。
5. **npm 分发形态。** 包以预构建 `.next` 发布（`files` 含 `.next`、`public`）。若走自建 CDN 方案，`public/` 里的 monaco 静态资源会一起进包（+20MB 级）；若走打包方案，worker chunk 会进 `.next/static`（同样进包）。**这是选型时必须一起决定的事，不是事后优化。**

---

## 3. 各文件类型的具体做法

| 类型 | 编辑 | 预览 | 备注 |
|---|---|---|---|
| `.txt` | 编辑器裸用 | — | 无脑 |
| `.md` | CodeMirror/Monaco 源码编辑 | 现有 react-markdown + mermaid + katex 全复用 | 已经有 `source/preview/diff` 三态切换，加编辑就是第四态；预览不用动 |
| `.html` | 源码编辑 | 已有 `preview` 模式 | 可选加"源码\|预览"分屏（需 iframe sandbox，注意 CSP） |
| `.js/.ts/.json/.css` | 源码编辑（CodeMirror 有高亮，无类型提示） | — | 想要真 IntelliSense 只有 Monaco + ts.worker（+1.47MB gz） |
| `.csv` | **没有现成方案是占优的** | — | 见下 |

**CSV 单独说**：官方 `@codemirror/lang-csv` 不存在（社区 `@cookshack/codemirror-lang-csv` 存在但极小众），Monaco 也没有 CSV 语言。三条路：

- a) 当纯文本编辑，写个 20 行 `StreamLanguage` 做分隔符/引号着色 —— 最省
- b) `papaparse@5.7.0` 解析 + 自绘表格，双向编辑 —— 编辑体验最好，但要多写一整套单元格编辑/行列增删/脏数据回写
- c) b 的省事版：`source` 态用编辑器、`preview` 态用只读表格（sort/filter），不要求表格可编辑

给出建议：(c)。CSV 用户的真实诉求多数是"想看一眼结构 + 改几个值"，可编辑表格是另一档投入。

---

## 4. 建议

**主线：CodeMirror 6。**
- `@uiw/react-codemirror`（或直接用 `codemirror` 元包 + 自写 React 胶水，省一个依赖），语言包按需 `import()` 懒加载
- 语种映射现成的：`EXT_TO_LANGUAGE` 已在 `app/api/files/[...path]/route.ts:97`，复用同一张表（目前 `text` 兜底，改成映射到 CodeMirror 语言包即可）
- 冷启动只有打开编辑态才加载编辑器 chunk，不影响首屏
- 不需要 worker、不需要 `MonacoEnvironment`、不需要动 `next.config.ts`

**顺带能白拿的两件事（如果决定动这块）**：
- `@codemirror/merge` 可以取代 `FileViewer.tsx` 里手写的 `diffLines`/`DiffView`（179KB 解包，换来标准 diff 视图 + 折叠）
- 项目已经有 `yjs@13` + `@hocuspocus/*`（看板画布在用），`y-codemirror.next` 是现成的协同绑定。将来"人 + agent 同编一个文件"有现成路径，Monaco 侧对应 `y-monaco`。这条不影响当下选型，但选 CodeMirror 不会把路堵死。

**若你明确要 JS/TS 的类型提示**，再上 Monaco，并接受：worker 产出 + `MonacoEnvironment` 配置 + 决定"自建 CDN 塞 public"还是"webpack 插件塞 .next"。这一档的增量是 +583KB gz（本体）+532KB~(2MB) gz（worker）。

---

## 5. 待你决策

1. **要不要 JS/TS 的真 IntelliSense？** 不要 → CodeMirror（建议）；要 → Monaco，且接受上表的集成活
2. **CSV 做到哪一档？** 源码编辑（建议） / 源码 + 只读表格 / 双向表格编辑
3. **是否接受"另起一个 openvscode-server 进程 + iframe"？** 我的判断是不值得（与现有 UI 割裂、多一个进程和端口、无嵌入 API），但如果你想要的是"随手开个完整 IDE"，它是唯一诚实的答案，且应该做成"在新标签页打开"而不是内嵌
4. **编辑态的写入策略**：直接在原文件上写（走 atomic rename）？还是先落到改动区、用户确认再写？（后者对 agent 并发更安全，但多一层 UI）

---

## 附：核验过的来源

| 事实 | 来源 | 类型 |
|---|---|---|
| monaco 0.56.0 可 tree-shake 入口 / LSP API | 随包 `CHANGELOG.md`（0.56.0 段） | 首方制品 |
| Monaco worker 集成方式 | https://github.com/microsoft/monaco-editor/blob/HEAD/docs/integrate-esm.md | 首方文档 |
| monaco-editor-webpack-plugin 最后发布 2025-10-10，peer webpack 4.5/5 | registry.npmjs.org | 首方 registry |
| `@monaco-editor/react` 默认 CDN + 钉 0.55.1 | `@monaco-editor/loader@1.7.0/lib/es/config/index.js` | 首方源码 |
| 各包体积 / worker 清单 | 本次下载 tarball + `find` / `gzip` 实测 | 实测 |
| CodeMirror 打包体积 | 本次 esbuild 实测（basicSetup + 6 语言 + 主题） | 实测 |
| CSV 无官方 CM6 语言包 | https://discuss.codemirror.net/t/.../8545 + 社区包 `@cookshack/codemirror-lang-csv` | 社区 |
| monaco-vscode-api 体积问题 | https://github.com/CodingGame/monaco-vscode-api/issues/602 、#136 | 维护方 issue |
| `code serve-web` localhost 故障 | https://github.com/microsoft/vscode/issues/315003 | 首方 issue，2026-05 仍未关 |
| 本项目现状（无写接口 / 256KB 上限 / watch SSE / 原子写 / npm 分发） | 本地代码 | 实测 |
