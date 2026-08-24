# 毛玻璃（Glassmorphism）统一样式标准

> 本文件是项目里所有玻璃/半透明/毛玻璃效果的**唯一样式依据**。
> 规定：**任意面板、菜单、气泡出现在哪个位置，就必须使用对应的那种样式**。
> 以"出现位置"为准选择，不看个人审美，禁用临场发挥。

---

## 1. 先记住一句话

> **哪里有玻璃，哪里就引用 CSS 变量或标准 class，绝不写死 `px` / `rgba` 数值。**

理由：只有引用 token，玻璃才会自动跟随浅/深主题、以及系统的"减弱透明/高对比"两级兜底（见 §6）。写死数值的玻璃脱离这些控制，主题一换就出错。

---

## 2. 分层玻璃总览（材质由厚到薄）

| 层 | 出现在哪 | 必须用 | 背景 token | 模糊 token |
|----|----------|--------|-----------|-----------|
| **chrome** | 顶栏、左/右侧栏、输入条、状态栏、底部工具栏 | `var(--frame-glass)` / `var(--side-panel)` | `--frame-glass` | `--glass-blur-heavy` |
| **top-panel** | 贴栏向下/向上展开的下拉（顶栏下拉、底部弹出面板） | `.glass-top-panel` | `--frame-glass` | `--glass-blur-heavy` |
| **panel** | 浮动大面板（终端/配置/统计/导航/编辑） | `.glass-panel` | `--panel-glass` | `--glass-blur-panel` |
| **popover** | 通知条、下拉小菜单、移动端菜单、轻浮层 | `.glass-popover` | `--glass-bg-strong`(60%) | `--glass-blur-popover` |
| **bubble** | 消息气泡、工具调用块 | 气泡变量 | `--*-bg-glass` | `--glass-blur-bubble` |

> 各层层名见名知意：`top-panel`＝贴栏展开、`panel`＝悬浮面板、`popover`＝轻浮层、`bubble`＝气泡、`chrome`＝常驻骨架。

---

## 3. 按位置：必须用哪种（决策表）

开发任何带玻璃/半透明的 UI，先问"它出现在哪"，再按下表取样式。

| 你要做的东西（出现在哪） | 必须用 |
|---|---|
| 顶栏上，点开向下展开的下拉（语言/系统提示/会话信息/统计/Todo/背景壁纸/分支） | `.glass-top-panel` |
| 底部工具栏上，点开向上弹出的面板（扩展 widget、todo 等） | `.glass-top-panel` |
| 悬浮的独立大面板（终端、MCP 配置、滚动小地图、会话统计面板） | `.glass-panel`（或内联 `--panel-glass`+`--glass-blur-panel`）|
| 右下角通知条 / toast | `.glass-popover` |
| 下拉小菜单、移动端工具栏浮层、移动端 thinking/工具二级菜单 | `.glass-popover` |
| 消息气泡（用户/助手/工具）与工具调用块 | 气泡变量（见 §4.4）|
| 常驻骨架（顶栏 / 侧栏 / 输入条 / 状态栏） | chrome token（见 §4.5）|

> 例外几乎没有：气泡只出现在消息区；`--panel-glass-todo` 只给顶栏 Todo 面板，不得挪用。

---

## 4. 标准配方（照抄即用）

### 4.1 贴栏展开下拉 — `.glass-top-panel`
已全局定义于 `app/globals.css`，直接套 class：
```css
.glass-top-panel {
  background: var(--frame-glass);
  backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate));
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  border-top: none;          /* 贴栏侧不留边 */
  border-radius: 0 0 12px 12px;  /* 底部圆角；底部弹出则反之为 10px 10px 0 0 */
}
```
用法：`<div className="glass-top-panel">内容</div>`。**贴顶栏**用默认（顶无边、底圆角）；**贴底栏**时把 `border-top:none` 换 `border-bottom:none`、圆角换成顶部圆角。

### 4.2 浮动大面板 — `.glass-panel`
```css
.glass-panel {
  background: var(--panel-glass);
  backdrop-filter: blur(var(--glass-blur-panel)) saturate(var(--glass-saturate));
}
```
用法：套 `.glass-panel`；边框/圆角/阴影按面板自管。

### 4.3 轻浮层 / 通知 / 下拉小菜单 — `.glass-popover`
```css
.glass-popover {
  background: color-mix(in srgb, var(--glass-bg-strong) 60%, transparent);
  backdrop-filter: blur(var(--glass-blur-popover)) saturate(var(--glass-saturate));
}
```

### 4.4 消息气泡 / 工具调用块 — 气泡变量
背景与模糊必须来自气泡变量，透明度/磨砂由用户的 `--bubble-alpha`、`--glass-blur-bubble` 控制：
```js
background: "color-mix(in srgb, var(--tool-bg-glass) 62%, transparent)"; // 工具/工具调用块
// 用户气泡: var(--user-bg-glass)   助手气泡: var(--assistant-card-glass)
backdropFilter: "blur(var(--glass-blur-bubble)) saturate(var(--glass-saturate))";
```
工具调用块（含失败的 bash）同样用 `--tool-bg-glass` + `--glass-blur-bubble`，失败仅靠红边框/红字标识，背景仍是玻璃。

### 4.5 常驻骨架 — chrome token
```js
background: "var(--frame-glass)";                       // 顶栏/状态栏/输入条
background: "var(--side-panel)";                        // 侧栏容器
backdropFilter: "blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))";
```

---

## 5. Token 字典（`app/globals.css` 已定义，勿在组件里复制数值）

| Token | light | dark | 用途 |
|-------|-------|------|------|
| `--frame-glass` | 0.76 | 0.68 | chrome 骨架 |
| `--side-panel` | = frame-glass | = frame-glass | 侧栏 |
| `--glass-bg` | 0.65 | 0.65 | 通用玻璃底 |
| `--glass-bg-strong` | 0.78 | 0.78 | 高对比玻璃底（popover 用）|
| `--glass-bg-input` | 0.52 | 0.52 | 内嵌输入字段 |
| `--panel-glass` | 0.75 | 0.75 | 浮动大面板 |
| `--panel-glass-todo` / `--panel-glass-minimap` | 0.75 | 0.75 | 仅 Todo / 滚动小地图 |
| `--user-bg-glass` / `--assistant-card-glass` / `--tool-bg-glass` / `--user-border-glass` | 随 `--bubble-alpha` | | 气泡 |
| `--glass-blur` | 8px | | 通用轻 blur |
| `--glass-blur-heavy` | 12px | | chrome / top-panel |
| `--glass-blur-panel` | 10px | | 浮动大面板 |
| `--glass-blur-popover` | 10px | | 轻浮层 / 通知 |
| `--glass-blur-bubble` | 18px / dark 12px | | 气泡（随滑块）|
| `--glass-saturate` | 80% / dark 140% | | 统一饱和，绝不写死 `140%` |

> 改 token 数值＝改全局观感。先改本文档对应表格，再改 globals.css，保持两端一致。

---

## 6. 硬性约束（违反会产生 bug，必读）

1. **浮在顶栏之上的下拉，必须 portal 渲染到 `<body>`**，并用触发按钮的 rect 锚定位置。原因：顶栏的 `backdrop-filter` 会让它的 `position:fixed` 后代以顶栏为包含块，内联渲染会导致面板定位偏移/被裁。参见项目内现有语言/系统/Todo 面板的写法。
2. **不要嵌套 `backdrop-filter`**：父级已有模糊时，子元素再挂 `backdrop-filter` 不会重新采样背景，只会得到实心色块。需要时把子元素背景 alpha 调低，让整体读作玻璃。
3. **背景/模糊一律用 token**：写死 `rgba`/`px` 会脱离主题与 §6 的无障碍兜底。
4. ⚠️ 兜底自动生效的前提是**你用了 token**：`@media (prefers-reduced-transparency: reduce)` 与 `@media (prefers-contrast: more)` 会把所有玻璃 token 打回实心。只要引用 token，就免费获得"减弱透明/高对比"下的安全降级；不引用 token 则失效。

---

## 7. 新面板开发：三步走（Checklist）

1. **定位置**：这个 UI 出现在哪 → 查 §3 决策表选定层（top-panel / panel / popover / bubble / chrome）。
2. **套样式**：优先套对应 class（`.glass-top-panel` / `.glass-panel` / `.glass-popover`）；气泡/骨架用 §4.4、§4.5 的内联配方。**不写死任何一个 `blur(数字px)`、`saturate(140%)`、`rgba(...)` 背景**。
3. **过约束**：浮顶栏→portal（§6.1）；不嵌套 backdrop（§6.2）；改观感→改 token+文档（§5）。
4. 目测：浅 / 深主题 × 有无壁纸 × 系统"减弱透明"/"高对比"。
