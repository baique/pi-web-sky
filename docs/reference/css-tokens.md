# CSS 变量体系（`app/globals.css`）

> 调 UI 观感 / 加样式前阅读。主题由 `localStorage` 强制，明暗共用 token 时不用在 `.dark` 重复。

## 基础 token

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

## 消息气泡内层级 token（`--bubble-*`）

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

## 画布 scrim（`--board-scrim-*`）

画布内容层之下、壁纸之上的一层磨砂（SessionCanvas），右上角滑块驱动：

```
--board-scrim-alpha / -bg / -blur
```

- 磨砂只为 blur 不动饱和度（深浅色一致观感）；`blur` 为 0 时把 `backdrop-filter` 置 `none`，避免 `saturate` 残留仍去饱和背景。
- token 在 `:root` 定义，明暗主题共用同一套，不用在 `.dark` 重复。

## 看板加载中遮罩（`--board-loading-*`）

三处加载态（AppShell/SessionCanvas 的动态 chunk 加载 + CanvasStage 的 board.loading）共用 `BoardLoading` 组件与同一套 token：

```
--board-loading-bg   rgba(0,0,0,0.55) 与 scrim 同源的黑色半透明（深浅主题都用深色，浅色会发灰）
--board-loading-text rgba(255,255,255,0.88) 浅色常量（遮罩是深色，浅色文字在两主题下都清晰）
```

- 只用颜色语义，不加 backdrop-filter（与 scrim “不是技术类似”）；alpha 比 scrim 底色略深，保证文字清晰。
- token 在 `:root` 定义，明暗主题共用，不在 `.dark` 重复。

## 思考球 loading（`thinking-orbs`）

Agent 运行状态用 [`thinking-orbs`](https://www.npmjs.com/package/thinking-orbs)（0.3.1，MIT）做加载球：
- **agent 状态行**：玻璃胶囊 `.chat-status-pill`（近实底 `--bubble-code-bg` + 文字 `--text`），内嵌 `ThinkingOrb size=20`。状态映射：`waiting_model → breathing`、`running_tools / running_command → working`。
- **思考块**：`isStreaming` 时折叠行 ✧ 换成 `ThinkingOrb state="breathing" size=20`；展开区 `deferred` 内容拉取中（loading）用 `state="searching"`。
- **模型载入 / 切换中**（`ChatInput` 模型槽）**不用 orb**：用普通转圈（13px 弧线 svg + 全局 `@keyframes spin`）。orb 专供「模型正在跑」，载入态要与之区分。
- **主题必须显式传** `theme={isDark ? "dark" : "light"}`（来自 `useTheme().isDark`），不要用库默认 `auto`——项目主题由 `localStorage` 强制，`auto` 会误判。
- **浅色主题对比度**：库 light 主题墨色上限只有 ~158 中灰，浅底上太淡。浅色（`!isDark`）下给 orb 加 `filter: brightness(0.57) contrast(1.15)`（墨色≈90 近黑），深色不加。
- orb 的 size 只有 tuned 的 `64 | 20` 两种，行内一律用 20。
