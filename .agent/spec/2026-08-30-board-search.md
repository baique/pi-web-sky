# pi-web · 看板内搜索定位（Ctrl+F 定位节点）

> 日期：2026-08-30　范围：pi-web-sky　状态：**已实现（2026-08-30，ffa1bf1）**　前置：`2026-08-29-session-canvas-v2.md`（看板/画布已交付）

## 0. 需求

> 用户：「A 定位」—— 在会话看板内提供搜索，按卡片标题/便笺文字匹配，命中后定位到节点。

参考 `.agent/spec/2026-08-29-session-canvas.md` P2 待办：「看板搜索/快速定位（Ctrl+F 定位节点）」。

用户已拍板（2026-08-30，四问）：
1. **搜索框 UI：常驻搜索框**（画布顶部居中，玻璃胶囊样式，不隐藏）。
2. **定位方式：居中缩放 + 高亮描边**（`zoomToBounds` 动画 + 命中卡片 accent 描边，高亮渐隐）。
3. **搜索范围：会话卡标题 + 便笺文字**（session-card.title / sticky-note.text，模糊子串匹配）。
4. **快捷键 Ctrl+F：要**（仅看板模式生效，preventDefault 不与浏览器冲突，Esc 关闭）。

## 1. 设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | **高亮不写 tldraw store**：高亮状态放 React context，shape 组件读 context 渲染描边 | 不触发防抖保存、不落库、刷新即消失，零数据污染；且多命中高亮无需序列化 |
| 2 | **搜索只遍历当前画布 shape**（`editor.getCurrentPageShapes()`），不查会话索引 | 范围 = 画布上可见节点；会话正文搜索属另一需求（B 方案），本设计不做 |
| 3 | **匹配用 includes 子串**（大小写不敏感），中文天然支持 | 画布节点量级小（几十个），无索引必要；`String.toLowerCase().includes()` 足够 |
| 4 | **Enter 循环下一个命中**，不自动跳到第一个 | 多命中时逐一定位浏览，Esc 或空查询退出 |
| 5 | 搜索组件**常驻**（非折叠按钮），宽度 ~280px | 用户选择常驻；玻璃胶囊风格与右上按钮组统一 |

## 2. 数据流

```
输入 query
  → lib/board-search.ts collectSearchable(editor)   // 遍历 shapes，抽 (shapeId, kind, text)
  → filterMatches(items, query)                     // includes 子串匹配 → matches[]
  → BoardSearch 渲染下拉列表（命中项 + 命中文本片段 + 计数）
  → 点击/Enter → highlight(id) + editor.centerOnPoint(bounds.center, { animation })  // 只定位，不缩放
  → BoardSearchContext.setHighlight(shapeId)        // shape 组件读 context 描边
```

- `collectSearchable`：`session-card` → `props.title`；`sticky-note` → `props.text`（截断展示用，匹配用全文）。
- 搜索框输入时仅过滤本地收集的节点，不产生网络请求。

## 3. 组件与文件

| 文件 | 内容 |
|------|------|
| `lib/board-search.ts` | 纯函数：`collectSearchable(editor)`、`filterMatches(items, query)`、类型 `SearchableItem` / `SearchMatch` |
| `lib/board-search.test.mjs` | 单测：中文/英文/大小写/空查询/多命中/便笺 vs 标题 |
| `components/canvas/BoardSearchContext.tsx` | context + provider：`highlightId`、`setHighlight(id \| null)`、`highlightVersion`（同 id 重选触发重播动画） |
| `components/canvas/BoardSearch.tsx` | 常驻搜索框：输入、下拉列表、Enter 循环、Esc 关闭、点击定位；玻璃胶囊样式（`--board-card-glass` + `--board-blur`） |
| `components/canvas/SessionCardShape.tsx` | `SessionCardView` 读 context，命中时外描边 accent |
| `components/canvas/StickyNoteShape.tsx` | 同上 |
| `components/canvas/SessionCanvas.tsx` | 集成：顶部居中放 BoardSearch；Ctrl+F / Cmd+F 快捷键聚焦（`onKeyDown`，仅当 `document.activeElement` 非 input/textarea）；Esc 由 BoardSearch 自身处理 |

## 4. 交互细节

| 操作 | 行为 |
|------|------|
| Ctrl+F / Cmd+F | 聚焦搜索框 + preventDefault（仅看板模式，即 SessionCanvas 挂载期间） |
| 输入 | 实时过滤；下拉显示命中列表（kind 图标 + 文本片段 + 计数），无命中显示空态 |
| Enter | 顺序跳到下一个命中（循环）：高亮 + centerOnPoint（animation 300ms，保持当前缩放） |
| 点击命中项 | 定位该命中（同 Enter 逻辑） |
| Esc | 下拉开时先关下拉；再按清空并失焦（关闭搜索） |
| 失焦 | 不清空 query，仅收下拉；再聚焦恢复列表 |

**高亮动画**：命中 shape 描边 accent（`outline` 或 `boxShadow`），CSS `@keyframes` 1.8s 渐隐；同 id 重复命中靠 `highlightVersion` 重播。

## 5. 错误处理与边界

- 查询为空：不显示下拉，无副作用。
- 无命中：下拉显示「无匹配」，不定位。
- shape 已删除/失效：`centerOnPoint` 前 `editor.getShape()` 判空，跳过。
- 画布未加载完（loading）：BoardSearch 仅在 `!board.loading` 时渲染/可交互。
- 系统「运行中」看板：同样可用（collectSearchable 不区分看板类型）。

## 6. 测试

- 单元（`lib/board-search.test.mjs`）：
  - 中文子串 / 英文子串 / 大小写不敏感
  - 空 query → 空结果（或全量，取约定：空 query 返回空）
  - 便笺 text 与卡片 title 都命中
  - 多命中顺序（按画布遍历顺序）
- e2e（`scripts/e2e-board-search.mjs`，playwright）：
  - 进看板 → Ctrl+F → 输入命中词 → 下拉出现 → 点击 → 相机 viewport 变化（记录 camera 前后对比）+ 高亮元素出现
  - 输入无命中词 → 空态
  - Esc 关闭

## 7. 不做（YAGNI）

- 会话正文搜索（B 方案）——需接 session-search 索引，另行立项。
- 搜索历史 / 模糊拼音 / 正则匹配。
- 高亮持久化（不落库，刷新即消失，符合"定位"语义）。
- 自动布局联动（命中后自动滚动画布内滚动区域——画布本身即视口，无内部滚动）。
