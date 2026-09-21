# 移动端触屏交互改造方案（iOS PWA）

> 目标设备：iPhone Safari + 加入主屏的独立窗口 PWA（`display: standalone`）。
> 范围外：看板画布（SessionCanvas / RF 全部内容）—— 明确不面向移动端。
> 本文只做设计，不含实现。实现拆成 P0–P3 四个阶段，每阶段独立可验收。

---

## 0. 一句话结论

移动端的问题是同一个根：**整个界面把「二级操作」建在 hover 上**。iOS 没有 hover（Safari 合成一次就不再更新，且会粘住），所以所有靠 hover 才出现的按钮/菜单在手机上等于不存在。
方案是把二级操作改成三条等价通路：**触屏长按（右键的等价物）+ 常显显式入口 + 点击展开**，并把 hover 样式收口到 `@media (hover: hover)`。

---

## 1. 现状（实测 + 代码证据）

### 1.1 hover 依赖（移动端不可达）

| 位置 | 证据 | 触屏表现 |
|---|---|---|
| 会话行 `⋯`（改名 / 置顶 / 删除） | `SessionSidebar.tsx:2430` `{(hovered \|\| moreOpen \|\| confirmDelete) && …}` | 按钮不渲染，菜单打不开 |
| 会话行折叠箭头（有分支时） | `SessionSidebar.tsx:2411` `{hovered && hasChildren && …}` | 同上 |
| 消息操作条（钉 / 复制 / 编辑从此处 / 新建会话） | `MessageView.tsx:533/595`（用户气泡）、`981/1014`（助手）`opacity: hovered ? 1 : 0` + `pointerEvents: hovered ? "auto" : "none"` | 按钮存在但不可点；Safari 合成一次 mouseenter 后可能与其它点击打架 |
| 文件树 @提及 / 下载 | `FileExplorer.tsx:375 / 407` `hovered && …` | 不渲染 |
| hover 显隐（CSS） | `globals.css` `.board-node-titlebar:hover .board-rename-btn` | 看板内，本方案不管 |

另有 145 处 `onMouseEnter` 只是换色/换字重，不阻塞操作，但会在 iOS 上**粘住**（tap 后样式不还原），属于同一类问题的副作用。

### 1.2 右键菜单现状

- 会话行右键：`SessionSidebar.tsx:2296` 派发 `pi-web:session-row-contextmenu`，**全仓库没有任何监听者**（`lib/session-row-context-menu.ts` 是会话列表改版后的死代码）。因此桌面右键现在也是空操作。
- 平台事实：iOS Safari 不派发 `contextmenu`（WebKit #213953 / MDN BCD #6376），长按只出放大镜 —— 所以移动端要自建长按，不能指望原生事件。

### 1.3 PWA 底部留白（一开始就有，已定位）

`components/ChatWindow.tsx:878` 给聊天列根节点加了 `paddingBottom: env(safe-area-inset-bottom)`。
独立窗口模式下该值恒为 34px（刘海机底部 Home 指示条），且它**不随键盘出现而更新**（WebKit #217754）。
结果：

- 输入区玻璃条下方永远有 ~34px 空白带（加上 `ChatInput.tsx:1957` 自带的 8px，视觉上约 42px）；
- 键盘弹起后这 34px 变成键盘上方的空隙。

### 1.4 键盘态

已有：`hooks/useViewportHeight.ts`（写入 `--app-viewport-height`）、`app/layout.tsx:45-49` 的 `interactiveWidget: "resizes-content"` + `viewportFit: "cover"`、≤640px 强制 16px 防聚焦缩放（`globals.css:1929-1936`）。

缺口：

1. 键盘判定用「有可编辑元素聚焦」（`useViewportHeight.ts:18`），失焦立即撤掉变量退回 `100dvh`。而 iOS 独立 PWA 的 `innerHeight` / `visualViewport.height` / `100dvh` 在键盘首次弹出后**可能整体缩水且不回弹**，一撤就永久矮一截。
2. 只处理总高，不处理输入框是否被键盘遮挡、消息列表是否跟随滚动。
3. 输入区上方的浮层（模型 / 思考 / 工具 / `@` / `/`）在键盘态的高度上限与锚点未统一处理。

---

## 2. 交互分级规范（本次要立的规矩）

| 级别 | 手势 | 承载内容 | 硬性要求 |
|---|---|---|---|
| 一级 | 单击 / 轻点 | 主操作：打开会话、展开消息、按钮 | 任何操作都必须能在**不依赖 hover** 的情况下 1 次点击完成 |
| 二级 | 长按 450ms | 对象上下文菜单（= 桌面右键） | 只是**加速器**，绝不能是唯一入口；同一菜单必须有常显入口 |
| 手势 | 滑动 / 捏合 | 滚动、画布平移缩放、抽屉边缘滑入 | 不承载菜单 |
| 显式 | 常显 `⋯` / `⋮` | 与长按同一份菜单 | 触屏下常显（桌面保持 hover 显现） |

长按实现约束（避免和系统抢手势）：

- 只在触屏启用（`matchMedia("(hover: none)")` 或 `pointerType !== "mouse"`）；鼠标环境保持原生右键 + hover。
- 触发面挂 `-webkit-touch-callout: none`；`user-select: none` **只加在行壳 / 标题栏 / 按钮**，消息正文与代码块必须保持可选中（长按选字复制是移动端的核心诉求，不能被菜单抢走）。
- 位移 > 10px、`pointercancel`、`pointerup` 任一即取消；触发时给一次轻量视觉反馈（iOS 无 `navigator.vibrate`，不做触感）。
- 菜单形态：会话行用**行锚点下拉**（复用 `AnimatedDropdown`）；消息用**长按点下方弹出的 fixed 玻璃菜单**（复用 `BoardContextMenu` 那套定位与外部点击关闭逻辑，抽象成通用 `ContextMenuSurface`）。

---

## 3. 改造清单

### P0 —— PWA 留白 + 键盘（用户已确认的 bug，先修）

1. **底部安全区改位置**：删掉 `ChatWindow.tsx:878` 的 `paddingBottom: env(safe-area-inset-bottom)`，把这段下边距加到输入区玻璃条**内部**（玻璃背景铺到屏幕底边，内容抬高）→ 空白带消失，Home 指示条也不会压到发送键。
2. **键盘态归零**：`:root:has(textarea:focus-visible)`（或 `useViewportHeight` 导出的 `data-keyboard` 属性）生效时，把该内边距置 0，消掉键盘上方空隙。
3. **重写键盘判定**（`hooks/useViewportHeight.ts`）：维护「历史最大 `innerHeight`」基线，`基线 - visualViewport.height > 40px` 才算键盘态（不再依赖焦点）；仅在 standalone（`navigator.standalone` / `display-mode: standalone`）下启用，避免影响普通 Safari。
4. **视口 heal**：失焦后若 `innerHeight` 仍小于基线，用「整高元素 `display:none` → 同步 reflow → 恢复」（可加一层短暂模糊遮罩盖住那一帧）强制 WebKit 重新量测。
5. **浮层限高统一**：模型 / 思考 / 工具 / `@` / `/` 浮层在键盘态以 `visualViewport` 为上限（部分已实现，收敛到一处工具函数）。

### P1 —— 会话行（侧栏）

1. `⋯` 与折叠箭头在触屏常显：`(isMobile || hovered || moreOpen || confirmDelete)`；桌面行为不变。
2. `hooks/useLongPress.ts` 接管行壳长按 → 打开与 `⋯` 相同的菜单（同一份 state，不做两套）。
3. 顺手处理死代码 `lib/session-row-context-menu.ts`：**接上监听者**（桌面右键 / iOS 长按共用），或删除。推荐接上——顺带修好桌面右键。
4. 行内加 `-webkit-touch-callout: none` + `user-select: none`（列表项不是正文）。

### P2 —— 消息（MessageView）

1. 触屏下操作条不再依赖 hover：去掉 `pointerEvents: "none"`，`opacity` 常显（推荐）或「点击气泡后显示 3 秒」。二选一，见 §6 待确认。
2. 长按消息壳（气泡 padding / 头像 / 元信息行）弹出同一组操作。
3. 正文区（markdown / 代码块）**不加**长按菜单，保持原生选择与复制。
4. 桌面 hover 样式保留，但统一挪进 `@media (hover: hover)`。

### P3 —— 文件树 + hover 收口

1. 文件行 `@提及` / 下载按钮触屏常显；或长按文件行弹出（含下载、插入路径）。
2. 全局 `@media (hover: hover)` 收口 hover 显隐样式，消掉 iOS 幽灵高亮。
3. 触屏点击目标 ≥ 44×44（现在行内按钮多为 28×28）。

---

## 4. 不做的事

- 看板画布（RF 节点 / 连线 / 派发卡）—— 不面向移动端，不投入。
- 不引入手势库（Hammer / use-gesture）；长按 + 常显足够，YAGNI。
- 不为了移动端重做顶栏与侧栏布局（现有抽屉式侧栏 + 移动顶栏已可用）。

---

## 5. 验证

- **e2e（playwright / ego-browser）**：`Emulation.setDeviceMetricsOverride`（390×844, mobile）+ `Input.dispatchTouchEvent` 长按 → 断言菜单出现；点击 → 断言菜单项可点。注意 `env()` 安全区无法在桌面浏览器模拟，P0 靠真机验收。
- **单元测试**：沿用仓库现有的源码断言式 `*.test.mjs`（如 `MobilePwaLayout.test.mjs` / `useViewportHeight.test.mjs`），把新的键盘判定与长按 hook 纳入。
- **真机 checklist（iOS PWA）**：① 无空白带；② 弹键盘时输入框贴键盘、无空隙；③ 键盘收起后布局回弹；④ 长按会话行出菜单；⑤ 消息操作条可点；⑥ 汇总到 `.agent/guide/`。

---

## 6. P0 实现记录（2026-09-20，已完成）

真机现象：① 点输入框弹出键盘后输入框被键盘遮住，要滚一下消息区；② widget 条下方多一条留白。

**根因（浏览器内伪造 `visualViewport` 复现，非推测）**

- ① `useViewportHeight` 的判据是 `innerHeight - visualViewport.height > 1`。iOS 上键盘弹起时两者**一起缩**，
  差值恒为 0，条件永不成立 → `--app-viewport-height` 不写 → 布局保持 `100dvh` → 输入区整块落在键盘下面。
  实测：伪造（innerHeight=500, vv.height=500）时变量为空、布局 844、键盘线以下 53 个可视元素。
- ② `ChatWindow.tsx` 给聊天列根节点加 `paddingBottom: env(safe-area-inset-bottom)`，独立窗口 PWA 恒为 34px，
  而这块没有任何元素画背景 → 壁纸透出来就是留白。注意它**不随键盘更新**（WebKit #217754），
  键盘弹起时还会变成键盘上方的空隙。

**改动**

| 文件 | 改什么 |
|---|---|
| `hooks/useViewportHeight.ts` | 判据换成「可视高度高水位线」（比基线矮 150px 以上 + 焦点在输入类元素）＋ 输入框落到可视区外的兜底 + 锁存防抖；换向重置基线；布局高度恒写 `--app-viewport-height`（键盘态=当前可视高度，否则=基线，顺带修掉 iOS 独立窗口键盘收起后视口不回弹的底部死带）；同时给 `<html>` 打 `data-keyboard` |
| `components/ChatWindow.tsx` | 删掉聊天列的 `paddingBottom: env(safe-area-inset-bottom)`；widget 条没有任何内容时整条不渲染（省掉一条看不见的 36px） |
| `app/globals.css` | `.bottom-band` 高度改 `calc(36px + env(safe-area-inset-bottom))`（安全区由这条自己长出来，玻璃背景铺满）；`html[data-keyboard="true"] .bottom-band` 收回 36px |
| `hooks/useViewportHeight.test.mjs`、`components/MobilePwaLayout.test.mjs` | 覆盖 iOS「两者一起缩」的回归用例与新 CSS 契约 |

**没有 widget 时的口径**：输入区玻璃卡保持自身 8px 下边距，不再额外留安全区（圆角浮层，底部本来就是空壁纸）。

**验证**：`npm test` 1048 通过、`tsc --noEmit` 干净、`eslint` 0 error；浏览器内伪造键盘回归：
键盘弹起后 `--app-viewport-height=500px`、`data-keyboard=true`、发送按钮底边 473 < 键盘线 500。真机（iOS PWA）仍需人工确认。

---

## 7. 待确认（P1–P3 写实现前需拍板）

1. **消息操作条**：触屏常显（简单、可用性最好、略吵）还是「点击气泡后显示」？
2. **长按菜单形态**：会话行沿用行锚点下拉，消息用长按点弹出的固定菜单 —— 还是统一都做成底部动作条（iOS 惯例，手指遮挡少）？
3. **键盘态具体症状**：本机无法复现 iOS 真机，除「留白」外还有哪些现象（输入框被遮 / 位置跳 / 消息列表不跟随）？
