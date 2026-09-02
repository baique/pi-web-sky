# 便笺 WYSIWYG 编辑（TipTap 试点）设计

> 日期：2026-09-02 · 状态：待审 · 范围：便笺编辑态试点

## 目标

将看板**便笺**（`components/board/StickyNoteNode.tsx`）的编辑态从"写 markdown 源码的 textarea"升级为 **TipTap WYSIWYG 编辑器**（ProseMirror 内核 + 官方 `@tiptap/markdown` 双向转换）。用户在编辑时直接看到渲染效果（Notion 式），所见即所得。

本 spec 是**单一试点**：只在便笺上落地。跑通后（观感 + markdown 保真度确认）再评估铺开到任务需求说明 / ChatInput——那两处**不在本 spec 范围**，另立 spec。

## 背景与选型（调研已定）

- 选 **TipTap 3 + `@tiptap/markdown`**（官方扩展，v3.7.0 引入双向 markdown，当前 3.22.x，基于 marked 解析、CommonMark + GFM）。
- 存储格式不变：便笺文本永远是 **markdown 字符串**（yjs `data.text`），解析/序列化只在编辑态内存发生。
- 渲染栈：非编辑态预览已用 `react-markdown` + `.markdown-body`（`app/globals.css:707`）。编辑态 WYSIWYG 排版复用同一套 `.markdown-body` 观感，保证"编辑时所见 = 退出后所渲染"。

## 架构

**不建通用封装组件**。TipTap 直接落在 `StickyNoteNode` 内部（编辑态分支替换 `<textarea>`）。理由：本 spec 只有便笺一个消费者，抽象 `GlassMarkdownEditor` 属过早 YAGNI；等第二个消费者（任务说明）出现、抽象出公共模式后再提取共享组件。

### 数据流

```
进入编辑：text(markdown) ──parse──▶ ProseMirror doc（useEditor 初始化，只做一次）
编辑过程：onUpdate ──▶ editor.storage.markdown.getMarkdown() ──▶ setDraft(markdown)
退出编辑：save()/cancel() 沿用现状（draft 已是 markdown 字符串）
```

- **不做受控反推**：不监听外部 `text` 变化实时重设 editor（现状 useEffect 仅在 `isEditing` 进入时同步 draft；保持"外源 text 只在进入编辑时重置"语义）。
- 草稿、保存、取消逻辑（`draft`/`save`/`finish`/`cancel`/`handleTextareaBlur`）**全部沿用**，只是 textarea 换成 editor 后：
  - blur 语义：`handleBlur` 判断 `relatedTarget` 是否落在卡内 → 卡内不存、卡外自动保存退出（沿用）。
  - 键盘：Ctrl/Cmd+Enter 完成、Esc 取消（现状在 textarea `onKeyDown` 上，换到 editor 容器层 `onKeyDown` 处理）。

### 扩展集（B 起步 · 无工具栏）

| 能力 | 扩展 | 备注 |
|---|---|---|
| 基础行内（粗/斜/删/行内码/链接） | StarterKit | 手打语法即所得 |
| 标题/引用/无序有序列表/代码块 | StarterKit | 手打语法即所得 |
| 表格 | Table + Row + Cell + Header | **不装**（见下） |
| 任务列表 `- [ ]` | TaskList + TaskItem | **不装**（见下） |
| 数学公式 / 脚注 / 更多 | — | 不装 |

**务实取舍**：没有工具栏，表格/任务列表只能手打语法且交互残缺，收益低 → 试点**不注册** Table/TaskList 扩展；若真实使用暴露需求，再按需增量注册（届时需同步评估预览端 react-markdown 的 GFM 渲染一致性）。

- marked 解析：GFM 默认（表格语法即使无 Table 扩展也可被 parse，但无对应 node 渲染会按文本处理——**保持一致：缺扩展的语法落回纯文本，不产生半渲染状态**）。
- 换行/链接按 marked 默认。

## 交互

- **进入编辑**：双击（现状）→ 进入编辑态，editor focus，光标置于**首行开头**（对齐 textarea 现状：无预置 selection 时 focus 落在开头）。
- **退出/存盘**：Ctrl/Cmd+Enter 完成、Esc 取消、**失焦自动保存**——全部沿用现状，键位处理上移到 editor 根容器 `onKeyDown`（ProseMirror contenteditable 不吞这俩键）。
- **编辑态输入**：`<div>`（contenteditable）替换 `<textarea>`，className 沿用 `nodrag nowheel`，内部块套 `.markdown-body` 排版。
- **user-select**：编辑态**保持默认不禁用**（现状卡根 `userSelect:none` 在编辑态 textarea 内部已天然可选中，WYSIWYG 后需显式允许内容选择，避免无法选中/复制编辑内容）。
- **空便笺占位**：不引入 TipTap placeholder 扩展。空便笺双击进入后显示空编辑区 + 光标即可；预览态空态已有"双击编辑 markdown"占位文案，语义闭环。

## 视觉

- **卡根玻璃**：沿用 `useCardGlass` 贴图，**编辑态不额外叠 blur/玻璃底**——预览态透卡，编辑态保持卡面统一，仅内部排版变化。
- **字体**：**放弃等宽**。现状编辑态 `--font-mono`，预览态 markdown-body 非等宽。WYSIWYG 后编辑态 = 预览态排版（非等宽、`--text` 色），真·所见即所得。代价：丢失打字等宽对齐手感——接受。
- **字号/行高**：跟随 markdown-body（~13px / 1.5）。代码块等块级用 mono + 低对比底（对齐 markdown-body 样式）。
- **尺寸**：默认宽 **338 → 380**、高 **230 → 280**（大一点容纳富文本排版），minWidth/minHeight 同步（现状 120×60 随 NodeResizer，保持）。

## 错误处理 / 边界

- markdown 解析异常：marked 兜底，不设额外错误分支（内容不会让编辑器崩溃）。
- 焦点/按钮：`keepTextareaFocus`（mousedown preventDefault）沿用，防止点徽记/取消/完成按钮时误触发 blur 自动保存。
- RF 拖拽 vs 文本选择：编辑区 `nodrag nowheel` + 卡根 user-select 不禁用 → 与预览态同一套隔离（现有 e2e 已覆盖）。

## 测试

**单元化（尽可能）**：markdown ↔ ProseMirror 往返保真本可抽纯函数，但 TipTap 编辑器实例化在组件内，抽离最小可测层成本偏高——**本试点以 e2e 为主**（符合项目"前端用 e2e 代替测试用例"惯例）。

**e2e**（参考 `scripts/e2e-sticky-features.mjs` 既有模式，复用其 helper/data-testid）：
1. 双击进入编辑 → 编辑区为 contenteditable（非 textarea）→ 失焦保存，节点更新。
2. 编辑含 `**粗**` / `- 列表` / `## 标题` 的 md → 退出后预览 `.markdown-body` 渲染出对应块（粗体/列表/标题结构存在）。
3. md 往返保真：预置含上述语法文本，进入编辑不做改动直接失焦 → 存储文本不变（无意外归一化破坏）。
4. Ctrl/Cmd+Enter 完成、Esc 取消、徽记切换、点卡外自动保存等既有行为回归（沿用现有 e2e 断言集）。

## 明确不做（本 spec 范围外）

- ChatInput 的 WYSIWYG（含 @补全/草稿/DraftStash 协议，风险最大，**单独立项评估**）。
- 任务卡需求说明 textarea 替换（待便笺试点确认后另立 spec）。
- 工具栏/悬浮菜单/斜杠菜单（便笺明确不要菜单）。
- 表格/任务列表扩展注册。
- 通用 `GlassMarkdownEditor` 共享组件抽象（YAGNI，等第二消费者）。
