# 毛玻璃（Glassmorphism）统一设定规范

> 日期：2026-08-24　范围：pi-web-sky（Sky 皮肤版）　
> 状态：作为所有「带背景/半透明的面板、浮层、菜单」的唯一样式依据。
> 目的：终结"每个面板各自调 blur/rgba"的局面 —— 任何新面板只挑一个分层 + 引 token，不再写死 px。

---

## 0. 本规范要解决的问题（为什么会有"多套标准"）

调查结论，混乱由 5 个根因造成：

1. **没有配方封装，靠复制粘贴**：同一套"浮动大面板"玻璃配方被原样复制 5 处（背景菜单/会话信息/统计面板/终端/MCP 配置），复制时值一旦漂移就是一个新标准。
2. **token 命名名不副实**：`--panel-glass-todo` 注释写着"todo 专用"，实际被 5 个非 todo 面板复用；而通用 `--panel-glass` 反而几乎没人用。
3. **值域不统一**：blur 半径散落 6 个值（1/8/10/12/16/18），saturate 混用变量与硬编码 `140%`。
4. **无障碍降级链路断裂（真 bug）**：`prefers-reduced-transparency` / `prefers-contrast` 兜底只覆盖 `--frame-glass/--glass-bg*/--glass-blur*`，没覆盖 `--panel-glass*`，更管不到硬编码的 `blur(16px)/blur(10px)` —— 用户开"减弱透明"时浮动面板仍是玻璃。
5. **注释与实现漂移**：Terminal 注释写着"同气泡配方"，实际用 `--panel-glass-todo`，误导维护者。

---

## 1. 设计原则（务必遵守）

1. **一律引用 CSS 变量，禁止硬编码 rgba/px 数值**。硬编码会脱离主题深/浅切换与无障碍降级控制。
2. **每类玻璃面用一个分层 token**，组件只引用 token，不写死 blur 值。
3. **浮层加 `backdrop-filter` 会创建 stacking context**：凡浮在顶栏之上的玻璃面板必须 portal 到 `<body>` 并用按钮 rect 锚定（见 §6 坑 2）。
4. **不要嵌套 backdrop-filter**：子元素重复挂 backdrop-filter 不会重新采样背景，只会得实心色块（见 §6 坑 1）。
5. **内容密集处用高 alpha**（`--glass-bg-strong` 0.78 或 `--panel-glass` 0.9），代码/diff/表/输入框务必近实心。

---

## 2. 分层玻璃体系总览

按"材质厚度"分 4 层，视觉由厚到薄：

| 层 | 用途 | 背景 token | 模糊 token |
|----|------|-----------|-----------|
| **chrome** | 顶栏 / 左/右栏 / 输入组件 / 状态栏 | `--frame-glass` / `--side-panel` | `--glass-blur-heavy`(12px) |
| **L-panel** | 浮动大面板：终端 / 会话统计 / 配置 / 导航 | `--panel-glass`(0.75) | `--glass-blur-panel`(10px) |
| **L-popover** | 下拉小菜单 / 通知 / 输入关联菜单 | `--glass-bg-strong`(60% mix) | `--glass-blur-popover`(10px) |
| **气泡** | 消息 / 工具调用 | `--user-bg-glass` 等 | `--glass-blur-bubble`(18px, 用户可调) |

> 取值刻意对齐近两年调好的观感。**改数值前先改本文档再改 globals.css**，避免无记录漂移。

---

## 3. Token 字典（`app/globals.css` `:root` + `html.dark`）

### 背景/材质
| Token | light | dark | 说明 |
|-------|-------|------|------|
| `--frame-glass` | rgba(255,255,255,0.76) | rgba(28,28,31,0.68) | chrome 外框，近实体 |
| `--side-panel` | = frame-glass | = frame-glass | 侧栏容器 |
| `--glass-bg` | 0.65 | 0.65 | 通用玻璃底 |
| `--glass-bg-strong` | 0.78 | 0.78 | 高对比玻璃底 |
| `--glass-bg-input` | 0.52 | 0.52 | 输入/内嵌字段 |
| `--panel-glass` | rgba(250,250,251,0.75) | rgba(34,34,37,0.75) | **浮动大面板**（本规范统一用这个）|
| `--panel-glass-todo` | 0.75 | 0.75 | 仅 Todo 面板（勿扩散）|
| `--panel-glass-minimap` | 0.75 | 0.75 | 仅滚动小地图 |
| `--user-bg-glass` / `--assistant-card-glass` / `--tool-bg-glass` / `--user-border-glass` | 随 `--bubble-alpha` | | 气泡 |

### 模糊（分层 token，组件只引用，不写死）
| Token | 值 | 适用 |
|-------|----|------|
| `--glass-blur` | 8px | 输入关联菜单（轻浮层基值）|
| `--glass-blur-heavy` | 12px | chrome（顶栏/侧栏/composer/状态栏）|
| `--glass-blur-panel` | 10px | **浮动大面板**（新增，伴随 alpha 调低）|
| `--glass-blur-popover` | 10px | **下拉小菜单 / 通知**（新增）|
| `--glass-blur-bubble` | 18px / dark 12px | 气泡（随用户滑块）|
| `--glass-saturate` | 80% / dark 140% | 统一饱和值，绝不硬编码 140% |

---

## 4. 标准配方（新面板直接抄）

### 4.1 推荐：套工具 class（`globals.css` 已内置）
```css
/* 浮动大面板 */
.glass-panel {
  background: var(--panel-glass);
  backdrop-filter: blur(var(--glass-blur-panel)) saturate(var(--glass-saturate));
}
/* 顶栏向下展开面板的标准外壳：与顶栏条同材质（chrome --frame-glass +
   --glass-blur-heavy），展开时与顶栏视觉连续、融为一体；另加三边边框
   (顶贴栏) + 底部圆角 + 统一阴影。顶部所有“点开向下展开”的弹层一律套此类。 */
.glass-top-panel {
  background: var(--frame-glass);
  backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate));
  transform: translateZ(0);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  border-top: none;
  border-radius: 0 0 12px 12px;
  box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 4px 16px -8px rgba(15,23,42,0.10);
}
/* 下拉小菜单 / 通知 */
.glass-popover {
  background: color-mix(in srgb, var(--glass-bg-strong) 60%, transparent);
  backdrop-filter: blur(var(--glass-blur-popover)) saturate(var(--glass-saturate));
}
```
> class 只给玻璃核心（背景+滤镜）与贴顶栏形态（边框/圆角/阴影）；内部布局由各组件自管，避免与内联样式冲突。

### 4.2 或：内联标准写法（组件用 inline style 时照抄）
- **浮动大面板**：`background: "var(--panel-glass)"` + `backdropFilter: "blur(var(--glass-blur-panel)) saturate(var(--glass-saturate))"` + `WebkitBackdropFilter` 同上 + `transform: "translateZ(0)"`
- **顶栏向下展开面板**（贴顶栏下拉）：直接套 `.glass-top-panel`，或内联 `background: "var(--frame-glass)"` + `blur(var(--glass-blur-heavy)) saturate(var(--glass-saturate))`
- **下拉小菜单/通知**：`background: "color-mix(in srgb, var(--glass-bg-strong) 60%, transparent)"` + `blur(var(--glass-blur-popover)) saturate(var(--glass-saturate))`

### 4.3 组件 → 配方映射（当前代码该用什么）
> "当前"列 = 改动前；"应改为"列 = 本规范目标。行号以 2026-08-24 为准。

| 中文菜单/面板 | 文件:行 | 状态 | 层 |
|---|---|---|---|
| 背景壁纸选择菜单 | AppShell.tsx:2140 | ✓ `.glass-top-panel`（原 panel-glass todo+16px） | 顶栏下拉 |
| 语言切换菜单 | AppShell.tsx:2651 | ✓ `.glass-top-panel`（原 popover 风格） | 顶栏下拉 |
| 系统提示菜单 | AppShell.tsx:2693 | ✓ `.glass-top-panel`（原 popover 风格） | 顶栏下拉 |
| 会话信息弹层 | AppShell.tsx:2725 | ✓ `.glass-top-panel`（原 panel-glass todo） | 顶栏下拉 |
| 会话统计/Todo 面板 | AppShell.tsx:2927 | ✓ `--panel-glass-todo`+`var(--glass-blur-panel)` | 顶栏下拉 |
| 底部扩展面板（pi-todo 等） | globals.css `.extension-widget-panels` | ✓ `--frame-glass`+`--glass-blur-heavy`（原 glass-bg 62% 无模糊） | chrome |
| 终端面板 | TerminalPanel.tsx:482 | ✓ `--panel-glass`+`var(--glass-blur-panel)`；bottombar 去底圆角+`border-bottom:none` 紧贴底栏 | panel |
| MCP 配置面板 | McpConfigPanel.tsx:786 | ✓ `--panel-glass`+`var(--glass-blur-panel)`（原误用 todo token） | panel |
| 侧栏项目/worktree 下拉 | SessionSidebar.tsx:1131/1340 | ✓ saturate 改用 `var(--glass-saturate)` | panel |
| 通知提醒条 | ChatWindow.tsx:1047 | ✓ popover 配方（原 10px+140% 硬编码） | popover |
| 输入区移动浮动按钮 | ChatInput.tsx:2469 | ✓ popover 配方（原 10px） | popover |
| 移动工具栏溢出浮层 | AppShell.tsx | ✓ popover 配方（原 10px） | popover |
| 滚动小地图 | ChatMinimap.module.css:18 | ✓ `var(--glass-blur-panel)` | panel |
| 失败/成功工具调用块 | MessageView.tsx `ToolCallBlock` | ✓ 气泡变量玻璃底（`--tool-bg-glass`+`--glass-blur-bubble`）——失败不再透明底红字，随气泡透明/磨砂控制 | 气泡 |

> 已统一、勿动的框架区：顶部工具栏、左侧栏、输入组件（草稿→底部工具栏）、消息气泡、左右侧栏、浮动消息导航面板 —— 详见 §5。

---

## 5. 已统一保留区（勿回归改动）

| 区域 | 配方 | 状态 |
|------|------|------|
| 顶部工具栏 | `--frame-glass` + `--glass-blur-heavy` + `var(--glass-saturate)` | ✓ |
| 左侧栏 / 右侧栏 | `--side-panel` / `--frame-glass` + `--glass-blur-heavy` | ✓ |
| 输入组件（草稿→底部工具栏） | `--frame-glass` + `--glass-blur-heavy` | ✓ |
| 消息气泡 / 消息区 | `--*-bg-glass` + `--glass-blur-bubble` + `var(--glass-saturate)` | ✓ |
| 扩展状态栏 | `--frame-glass` + `--glass-blur-heavy` + `var(--glass-saturate)` | ✓ |

---

## 6. 已知大坑（改玻璃必看）

1. **嵌套 backdrop-filter 无效**：子元素再挂 backdrop-filter 不会重新采样背景（父级已有 blur 时尤其明显），只会得实心色块。做法：去掉嵌套层，把背景 alpha 调低让它读作玻璃片。（NOTES.q6）
2. **topbar 的 backdrop-filter 会成为 fixed 后代的 containing block**：顶栏面板若内联渲染会被困在顶栏坐标系里、随右侧面板收窄而偏移。必须 portal 到 `<body>` 并用按钮 rect 锚定（todo/语言/系统面板均此模式，新面板照抄）。（NOTES.q4）
3. **SCSS/复用陷阱**：`--panel-glass-todo` 是 Todo 专用 token，勿把它当通用面板玻璃复制用途。

---

## 7. 无障碍降级（已覆盖，勿破坏）

`globals.css` 内置两套兜底，把全部玻璃变量打成实心：
- `@media (prefers-reduced-transparency: reduce)`（用户开"减弱透明"）
- `@media (prefers-contrast: more)`（高对比）

现已覆盖 `--frame-glass / --side-panel / --panel-glass* / --glass-bg* / --glass-blur*`（含新增的 `panel/popover`）。

**约束**：任何新玻璃面的背景/模糊必须引用上述 token（或套 §4 的 class/内联写法），否则会脱离降级控制。

---

## 8. 新增玻璃面板操作清单（Checklist）

开发新面板想要玻璃效果时：
1. 判断它属于哪一层：顶栏/侧栏/composer/状态栏 → **chrome**；浮动大面板（终端/统计/配置/导航）→ **L-panel**；下拉小菜单/通知 → **L-popover**；消息 → **气泡**。
2. 套对应 class（`.glass-panel` / `.glass-popover`），或照抄 §4.2 内联写法。**不手写 blur/rgba 数值**。
3. 边框、圆角、阴影按组件需求自管（`--border` 混色），不放进玻璃配方。
4. 若浮在顶栏之上 → portal 到 `<body>` + 按钮 rect 锚定（§6 坑 2）。
5. 目测：浅/深主题 × 开/关壁纸 × 系统"减弱透明"/"高对比"设置。
