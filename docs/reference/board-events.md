# 看板卡片交互与事件层规范（board-events，React Flow 版）

> 开发 RF 自定义节点卡片（会话卡 / 任务卡 / 便笺）的事件层前阅读。
> **2026-09-02 重写**：tldraw 已移除，改用 React Flow。tldraw 时代的事件 hack（copy 拦截 /
> 激活态判定 / canScroll / 右键菜单失同步）全部不需要，RF 原生机制替代。

## 一、核心结论：RF 用 utility class 隔离节点内交互，无需事件 hack

React Flow 原生提供三个 CSS class，挂在节点内元素上即隔离画布手势：

| class | 效果 | 适用 |
|---|---|---|
| `nowheel` | 滚轮不触发画布缩放/平移（浏览器默认滚动内部容器） | 可滚动区（消息区 / 便笺内容区 / 表单） |
| `nodrag` | 该元素按下不触发节点拖动 | 按钮 / 输入框 / 滚动区 / 下拉 |
| `nopan` | 该元素不触发画布平移 | 交互密集区（可选） |

源码依据：`@xyflow/system` 的 `createFilter`（nowheel → 禁 zoom；nopan → 禁 pan；节点内 nodrag 元素不参与 drag）。

**对比 tldraw（已废弃的坑）**：
- 无需 copy 拦截：RF 不设全局 `user-select:none`，便笺/消息文本选中复制天然可用。
- 无需激活态判定：`nowheel` 只在可滚动容器内生效，背景卡不吞滚轮。
- 无需 `canScroll()` 声明、原生 wheel 监听、radix 菜单失同步修复。
- 节点内输入框/按钮天然可交互（非 nodrag 元素按下会拖节点——所以交互元素必须加 nodrag）。

## 二、自定义节点交互 Checklist

### 1. 可滚动容器（消息区 / 便笺 / 表单）
```tsx
<div className="nowheel nodrag" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
  {/* 内容 */}
</div>
```
- `nowheel`：滚轮内部滚动，不缩放画布。
- `nodrag`：按下不拖节点（拖内容区文本选区不触发拖卡）。

### 2. 交互元素（按钮 / 输入 / 下拉）
```tsx
<button className="nodrag" onClick={...}>...</button>
<input className="nodrag nowheel" ... />
```
- `nodrag`：不触发节点拖动（tldraw 时代按钮要单独 stopPropagation，RF 用 class 即可）。
- 输入框加 `nowheel` 可选（输入时滚轮不缩放画布）。

### 3. 拖拽把手（节点可拖动区域）
- **不加** nodrag：让 RF 默认拖动整个节点。
- 标题栏通常不加 nodrag（拖标题栏 = 拖节点）；按钮 / 输入单独加 nodrag。

### 4. 连线 Handle
- 节点必须有 `<Handle type="target" position={Left}/>` 和 `<Handle type="source" position={Right}/>`，
  否则 RF 无法连接 edge（error#008）。
- exec / 依赖线依赖 Handle 渲染端点。

### 5. 双击 / 右键
- 双击进编辑（便笺）/ 切换展开（会话卡/任务卡）：节点组件 onDoubleClick + stopPropagation。
- 右键菜单：CanvasStage 的 onNodeContextMenu / onPaneContextMenu / onEdgeContextMenu 给屏幕坐标 →
  自绘玻璃菜单（BoardContextMenu）。无需 radix / 无需失同步修复。

## 三、删除语义（onBeforeDelete）

- Delete/Backspace → ReactFlow `onBeforeDelete` → 按节点类型走确认制：
  - 会话卡 / 任务卡：确认弹窗 → `deleteNodeWithConfirm`（确认 → 删 Y.Doc 节点 + 调删除 API）。
  - 便笺 / 文本：直接删。
  - 派生边（exec/依赖）：onEdgesChange 跳过删除，后端 reconcile 兜底补回。
- 返回 false 阻止 RF 默认删除（由我们处理确认流程）。

## 四、相关文件

- `components/canvas/CanvasStage.tsx` — ReactFlow 挂载 / 右键菜单 / 工具栏 / 删除
- `components/board/SessionCardNode.tsx` — 会话卡节点（展开工作台）
- `components/board/TaskCardNode.tsx` — 任务卡节点（编辑表单）
- `components/board/StickyNoteNode.tsx` — 便笺节点（markdown 编辑）
- `components/board/BoardContextMenu.tsx` — 自绘玻璃右键菜单
- `components/canvas/SessionWorkbench.tsx` — 工作台（ChatWindow 嵌入）
- 数据/结构层面看板规则见 [boards.md](boards.md)
