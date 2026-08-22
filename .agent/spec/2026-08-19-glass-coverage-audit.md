# 毛玻璃（Apple 风格 frosted-glass）覆盖审计与成本分析

> 日期：2026-08-19　范围：pi-web-sky（Sky 皮肤版）
> 结论速览：**核心工作区（顶栏/侧栏/气泡/输入框/通知/todo/草稿）已玻璃化；主要缺口集中在「输入框关联浮层」「右侧文件面板」与「各类配置/选择弹窗」。** 由于玻璃体系已全部收敛到 CSS 变量且自带主题与可访问性降级，**绝大多数缺口的"标准方案"只需复用现有变量，成本为 A/B 级（单/少处样式替换）**；真正偏高的只有右侧文件面板（C 级，需权衡内容可读性）。

---

## 0. 玻璃体系现状（决定成本的地基）

所有玻璃颜色与模糊值都集中在 `app/globals.css` 的 `:root` 与 `html.dark` 两组 CSS 变量中：`--glass-bg` / `--glass-bg-strong` / `--glass-bg-input` / `--glass-blur`(8px) / `--glass-blur-heavy`(12px) / `--glass-saturate`(浅 80% / 深 140%)，以及消息气泡用色 `--user-bg-glass` / `--assistant-card-glass` / `--tool-bg-glass` / `--user-border-glass`。

更关键的是 globals.css 底部已内置两套**一键兜底**（globals.css:1471–1490）：

```css
@media (prefers-reduced-transparency: reduce) {
  --glass-bg: var(--bg); --glass-bg-strong: var(--bg);
  --glass-blur: 0px; --glass-blur-heavy: 0px;
}
@media (prefers-contrast: more) { /* 同上，玻璃全部变实心 */ }
```

**含义**：任何新玻璃面只要引用现有 `--glass-*` 变量 + `backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))`，就**自动**受浅/深主题与用户可访问性降级控制，无需新增变量、无需改动兜底逻辑。这就是"标准方案能被主题控制"的天然保证。**切勿在组件里硬编码 rgba/px 数值**，否则会脱离这套控制。

> 现存小瑕疵（已玻璃区）：`globals.css:199` 的 `.extension-status-shelf` backdrop 写死 `saturate(140%)`，而消息气泡用 `var(--glass-saturate)`——浅色下扩展区饱和度不会随主题降到 80%。建议统一改为 `saturate(var(--glass-saturate))`（1 行）。

---

## 1. 已覆盖（现有玻璃）清单

| # | 功能模块 | 干嘛用的 | 页面位置 | 实现（文件:行） |
|---|----------|----------|----------|------------------|
| G1 | 顶栏 Top Bar | 会话/新建/背景/主题/语言/运行中按钮、移动更多 | 顶部横条 | `AppShell.tsx:1994` `--glass-bg-strong`+blur |
| G2 | 左栏 Sidebar 容器 | 会话树+文件树+底部模型/技能/插件入口的容器 | 左侧整栏 | `AppShell.tsx:1967` `--glass-bg`+blur-heavy |
| G3 | 扩展状态栏 | 底部扩展状态提示条 | 底部工具栏 | `globals.css .extension-status-shelf` |
| G4 | 扩展 widget 面板 | 扩展小组件展开区 | 底部 | `globals.css .extension-widget-panels` |
| G5 | 消息气泡 | 用户/助手/思考/工具调用 | 消息列表 | `MessageView.tsx:377/735/928` `*-bg-glass`+blur12 |
| G6 | 输入框 | 聊天输入 | 底部输入条 | `ChatInput.tsx:1880` `--glass-bg-input`+blur8 |
| G7 | 输入工具栏 frosted strip | 发送/模型/thinking/工具/压缩等按钮区 | 输入框上方横条 | `ChatInput.tsx:2040` `--glass-bg`+blur8 |
| G8 | 顶栏下拉面板 | 语言 / 系统提示 / 会话统计 | 顶栏下拉浮层 | `AppShell.tsx:2136/2178/2209` |
| G9 | Todo 面板 | 会话待办（顶栏 Tasks 按钮） | 右上角下拉 | `AppShell.tsx:2406` glass-bg-strong 62%+blur12 |
| G10 | 通知提醒 | 右下角操作反馈通知 | 右下角浮层 | `ChatWindow.tsx:1008` glass-bg 55%+blur10 |
| G11 | 草稿暂存面板 DraftStash | 输入暂存区（Ctrl+S） | 输入区 | `DraftStash.tsx:79` `--glass-bg-input`+blur |
| G12 | 移动顶栏更多操作浮层 | 移动端工具栏溢出入口 | 顶栏内部 | `AppShell.tsx:2081` bg-panel 94%+blur10（近似） |
| G13 | 移动输入二级菜单 | 移动端 thinking/工具菜单 | 输入区浮层 | `ChatInput.tsx:2317` bg-panel 92%+blur10（近似） |

---

## 2. 未覆盖清单（实心 `var(--bg)` / `var(--bg-panel)`，无 backdrop-filter）

| # | 功能模块 | 干嘛用的 | 页面位置 | 现状（文件:行） |
|---|----------|----------|----------|------------------|
| U1 | **输入框关联浮层**（输入历史 `/`斜杠命令 / 模型选择 / thinking 级别 / @文件引用） | 高频交互菜单 | 输入区/工具栏浮层 | `ChatInput.tsx:1548 / 1635 / 2149 / 2362 / 2450` 均 `var(--bg)` |
| U2 | **右侧文件面板**（Right Panel + TabBar + FileViewer：文件/代码/diff 查看、实时监视） | 文件查看器 | 右侧整栏 | `AppShell.tsx:2582`（容器 `var(--bg)`）/ `:2592`（tab `var(--bg-panel)`）；`FileViewer.tsx` 内部大量实心 |
| U3 | 背景壁纸选择菜单 | 换/删壁纸 | 顶栏下拉 | `AppShell.tsx:1877` `var(--bg-panel)` |
| U4 | 项目 / worktree 选择下拉（侧栏内） | 切换工作目录/分支工作树 | 侧栏内浮层 | `SessionSidebar.tsx:1131 / 1336` `var(--bg)` |
| U5 | 分支导航器 BranchNavigator | 会话内分支/续接切换 | 顶栏/消息区浮层 | `BranchNavigator.tsx:342/372/402` `var(--bg-panel)`/`var(--bg)` |
| U6 | 滚动小地图 ChatMinimap | 消息区滚动位置概览条 | 消息区侧边 | `ChatMinimap.tsx:618` `var(--bg-panel)` |
| U7 | 模型配置弹窗 ModelsConfig | 编辑 models.json/提供商/密钥 | 居中模态 | `ModelsConfig.tsx:1806/2106` 容器 `var(--bg)`，scrim `rgba(0,0,0,0.35~0.4)` |
| U8 | 技能配置弹窗 SkillsConfig | 技能开关/搜索/安装 | 居中模态 | `SkillsConfig.tsx:921` 容器 `var(--bg)`，scrim `rgba(0,0,0,0.35)` |
| U9 | 插件配置弹窗 PluginsConfig | 插件包管理 | 居中模态 | `PluginsConfig.tsx:776` 容器 `var(--bg)`，scrim `rgba(0,0,0,0.35)` |
| U10 | 目录选择器 DirectoryPicker | 选择/新建工作目录 | 居中模态 | `DirectoryPicker.tsx:116` 容器 `var(--bg)`，scrim `rgba(0,0,0,0.35)` |
| U11 | 项目信任弹窗 ProjectTrustDialog | 信任项目确认 | 居中模态 | `ProjectTrustDialog.tsx:46/81` `var(--bg)`/`var(--bg-panel)`，scrim `rgba(0,0,0,0.4)` |
| U12 | 扩展请求对话框 | 扩展 confirm/select/input/editor 请求 | 消息区模态 | `ChatWindow.tsx:1075/1256` 容器 `var(--bg)`，scrim `rgba(0,0,0,0.18)` |
| U13 | Mermaid 放大弹窗 | 流程/图放大查看 | 居中模态 | `MermaidBlock.tsx` zoom `var(--bg)`，scrim `rgba(0,0,0,0.35)` |
| U14 | 图片预览 ImagePreview | 大图全屏查看 | 全屏 | `ImagePreview.tsx:56` 背景透明（显示图片本身） |

> 说明：侧栏 G2 容器已是玻璃，故侧栏内**主体**（会话/文件列表，无背景的透明项）随容器透出、算已覆盖；但其中**弹出的下拉**（U4 类）自带宽实心背景，属缺口。另：主聊天内容区本身透明（由气泡承担玻璃），这是正确设计，不在缺口内。

---

## 3. 逐模块成本分析（标准方案 / 最小方案 / 成本 / 价值）

> **成本口径**：A＝单/少处纯样式替换，无牵连；B＝多处或涉及浮层 stacking context/z-index，仍纯样式；C＝大片内容密集面板，需权衡玻璃与可读性。
> **标准方案**＝完整做法：复用 `--glass-*` 变量，受主题 + reduced-transparency/contrast 统一控制。
> **最小方案**＝最短平快改法：只动 1~2 处关键背景，先出玻璃观感，不处理内部细节。

### U1 输入框关联浮层 —— 成本 B，价值 ★★★★★
**【干嘛用】** 输入历史、`/` 斜杠命令、模型切换、思考级别、`@` 文件引用的弹出菜单。**位置**：输入区/工具栏上方的绝对/固定浮层。
- **标准方案**：把 5 处 `background: "var(--bg)"` 统一改 `background: "color-mix(in srgb, var(--glass-bg-strong) 70%, transparent)"`，并加 `backdropFilter: blur(var(--glass-blur)) saturate(var(--glass-saturate))` + `WebkitBackdropFilter`。下拉项 hover 用 `var(--bg-hover)` 不受影响（相对透明底仍清晰）。受主题控制。
- **最小方案**：仅优先改弹窗感最强的 3 处（模型选择、输入历史、斜杠命令）→ 再补 thinking/`@` 文件。
- **注意**：模型选择下拉为 `position:fixed; zIndex:500`（ChatInput.tsx:2149），加 backdrop-filter 会创建新 stacking context，需确认不与顶栏 `zIndex:300` 冲突（顶栏已用 portal 规避同类问题，此处下拉在 ChatInput 内部，风险低但需目测）。
- **价值**：这是输入路径最高频浮层，玻璃化收益最直观。

### U2 右侧文件面板（FileViewer）—— 成本 C，价值 ★★★★
**【干嘛用】** 查看代码/文本/diff、markdown 预览、实时监视。**位置**：右侧整栏（tab 栏 + 内容区）。
- **标准方案（推荐，非全透明）**：内容密集区不宜真玻璃。做法 = 只玻璃化**外层 chrome**：右侧面板容器 `var(--bg)`→`--glass-bg-strong`+blur（`AppShell.tsx:2582`）；tab 栏 `var(--bg-panel)`→`color-mix(var(--glass-bg-strong) 70%, transparent)`+blur（`:2592`）。**内容区保持近实心**（代码/表格/diff 需高对比），可用 `--glass-bg-strong`（alpha 0.78）或维持 `var(--bg)`——符合 Apple"内容密的面板用厚重材料"原则。
- **最小方案**：只改右侧面板容器 + tab 栏两处背景，内容区完全不动。改动仅 2 行，即可让右侧"边缘"融入玻璃体系。
- **价值**：右侧面板是壁纸透出时最显眼的大块"不透明白板"，高价值。但**必须克制**——整面板真透明会导致代码区对比崩坏，这是全项目最需要"做一半"的模块。

### U3 背景壁纸选择菜单 —— 成本 A，价值 ★★
**【干嘛用】** 换/删壁纸入口。**位置**：顶栏下拉。
- **标准/最小方案**（同）：`AppShell.tsx:1877` `var(--bg-panel)` → `color-mix(in srgb, var(--glass-bg-strong) 65%, transparent)` + `blur(10px) saturate(var(--glass-saturate))`。1 处。复刻 G8 顶栏下拉面板写法即可。

### U4 项目 / worktree 选择下拉 —— 成本 A，价值 ★★★
**【干嘛用】** 切工作目录、切分支工作树。**位置**：侧栏内下拉。
- **标准方案**：`SessionSidebar.tsx:1131`（项目）、`:1336`（worktree）两处 `var(--bg)` → glass-bg-strong + blur，与 G2 侧栏容器衔接（下拉本就是浮在玻璃上，改后更统一）。
- **最小方案**：同（本就 2 处）。列表行 hover 用 `var(--bg-hover)` 保持。
- **注意**：列表内容较密（项目路径），建议用 alpha 较高的 `--glass-bg-strong` 而非 `--glass-bg` 保可读。

### U5 分支导航器 BranchNavigator —— 成本 A，价值 ★★
**【干嘛用】** 会话内分支/续接切换树。**位置**：顶栏/消息区浮层。
- **标准/最小方案**：`BranchNavigator.tsx:342`（`var(--bg-panel)`）与 `:372/:402`（`var(--bg)`）统一为 glass-bg-strong + blur。3 处。

### U6 滚动小地图 ChatMinimap —— 成本 A，价值 ★
**【干嘛用】** 消息区滚动位置概览。**位置**：消息区侧边竖条。
- **标准/最小方案**：`ChatMinimap.tsx:618` `var(--bg-panel)` → `color-mix(in srgb, var(--glass-bg) 70%, transparent)` + 弱 blur（`blur(6px)`）。1 处。低价值（视觉辅助条，改不改都行）。

### U7 模型配置弹窗 —— 成本 B–C，价值 ★★
**【干嘛用】** 编辑 models.json/提供商/密钥/测试。**位置**：居中模态。
- **标准方案**：主容器 `ModelsConfig.tsx:1806/2106` `var(--bg)` → `--glass-bg-strong`+blur；内部次级面板/输入框（大量 `var(--bg-panel)`）保留实心或改 `color-mix(var(--glass-bg) 50%, transparent)`。scrim 已有，不需改。
- **最小方案**：只改主容器背景 1 处（两个尺寸分支都要改），内部不动——主容器一透明，边缘即可透出壁纸。
- **注意**：表单 + 表格内容密，建议 alpha 较高；真全透明会伤输入框对比。
- **提示**：很多人会先玻璃化这里的背景色块类校检条（U7 底部），但那些是语义色块，不应动。

### U8 技能配置弹窗 / U9 插件配置弹窗 —— 成本 B，价值 ★★
**【干嘛用】** 技能开关/搜索/安装；插件包管理。**位置**：居中模态。
- **标准方案**：主容器 `SkillsConfig.tsx:921` / `PluginsConfig.tsx:776` `var(--bg)` → `--glass-bg-strong` + blur；列表/卡片次级面（`var(--bg-panel)`）按需 `color-mix`。scrim 已有。
- **最小方案**：只改主容器 1 处。内容密集，同样建议高 alpha。

### U10 目录选择器 —— 成本 A，价值 ★★
**【干嘛用】** 选/建工作目录。**位置**：居中模态。
- **标准/最小方案**：`DirectoryPicker.tsx:116` 容器 `var(--bg)` → `--glass-bg-strong`+blur；内部输入行 `var(--bg-panel)`（:155）保留。1 处 + scrim 已有。

### U11 项目信任弹窗 —— 成本 A，价值 ★★
**【干嘛用】** 首次进项目确认信任。**位置**：居中模态。
- **标准/最小方案**：`ProjectTrustDialog.tsx:46`（`var(--bg-panel)`）与 `:81`（`var(--bg)`）→ glass-bg-strong+blur。2 处。

### U12 扩展请求对话框 —— 成本 A，价值 ★★★
**【干嘛用】** 扩展的 confirm/select/input/editor 弹窗（扩展交互必经）。**位置**：消息区模态。
- **标准/最小方案**：`ChatWindow.tsx:1075/1256` 容器 `var(--bg)` → `--glass-bg-strong`+blur；内部 `var(--bg-panel)` 输入/选项保留。2 处（两个弹窗组件）。scrim `rgba(0,0,0,0.18)` 已偏浅，可微提至 0.24 助分离。

### U13 Mermaid 放大弹窗 —— 成本 B，价值 ★（可选）
**【干嘛用】** 流程图放大。**位置**：居中模态。
- **标准/最小方案**：zoom 容器 `var(--bg)` → `--glass-bg-strong`+blur；白底图本身不动。**内容极其密集且是图，玻璃收益低**，列为可选/低优先。

### U14 图片预览 —— 不适用
**【干嘛用】** 大图全屏查看。**位置**：全屏。
- 背景 `transparent`（`ImagePreview.tsx:56`）是**正确**的——看图就该露底。不应玻璃化；如需改善可只给关闭按钮（现 `var(--bg-panel)`）加弱玻璃，价值极低，建议跳过。

---

## 4. 成本分级汇总与优先级建议

| 优先级 | 模块 | 成本 | 一句话 |
|--------|------|------|--------|
| P0（推荐先做） | U1 输入框关联浮层 | B | 最高频浮层，收益最直观 |
| P0 | U2 右侧文件面板（只 chrome） | C | 最大"白板"，但必须只做 chrome 不做内容区 |
| P1 | U4 项目/worktree下拉、U11 信任弹窗、U12 扩展对话框 | A | 1–2 处替换，随手完成 |
| P1 | U10 目录选择、U3 壁纸菜单、U5 分支导航 | A | 同上 |
| P2 | U7 模型 / U8 技能 / U9 插件 配置弹窗 | B–C | 内容密，高 alpha；价值中等 |
| P3 | U6 小地图 / U13 Mermaid 放大 | A–B | 低价值，可留到有需要再做 |
| — | U14 图片预览 | — | 跳过，背景透明是正确设计 |

**整体判断**：除 U2 需谨慎做"半套"，其余均为"复用现有 glass 变量 + 少量背景替换"，均自动受主题 + reduced-transparency/contrast 降级控制，无新增变量、无需改兜底。若只求快速见效，P0 两项（U1、U2 的 chrome 部分）即可让观感显著统一。

---

## 5. 落地注意项（通用）

1. **一律复用现有变量**，禁止硬编码 rgba/px——否则脱离主题与可访问性降级。
2. **浮层加 backdrop-filter 会创建 stacking context**：凡是浮在顶栏、消息区之上的玻璃面板，测试时务必确认 z-index 层级与"固定定位偏移"问题（顶栏 G1 曾踩过坑，见 NOTES 的 q4；解法是将面板用 portal 渲到 body 或给容器加 `position:relative;zIndex`）。改动后建议用 `elementFromPoint` 验证浮层内容不再被气泡/顶栏遮挡。
3. **内容密集处用高 alpha**（`--glass-bg-strong` 0.78 而非 `--glass-bg` 0.65）保对比；代码/diff/表/输入框务必近实心。
4. **一次性顺手修** globals.css:199 饱和度写死问题（改成 `var(--glass-saturate)`）。
5. 改完跑 `npm run dev`（端口 30143）目测浅/深两主题 + 开/关壁纸，及系统"减弱透明"设置下的降级表现。

---

### 附：关键引用索引
- 玻璃变量定义：`app/globals.css:45–104`；降级兜底：`:1471–1490`
- 已玻璃点主引用：`AppShell.tsx:1967/1994/2081/2136/2178/2209/2406`；`ChatInput.tsx:1880/2040/2317`；`ChatWindow.tsx:1008`；`MessageView.tsx:377/735/928`；`DraftStash.tsx:79`；`globals.css .extension-status-shelf/.extension-widget-panels`
