# 看板卡片交互与事件层规范（board-events）

> 开发 tldraw 自定义 shape 卡片（会话卡 / 便笺 / 未来任何"画布上的可交互 UI"）的事件层前阅读。
> 本文件记录**通过实现与验证得出的结论**（无法靠读代码或 tldraw 文档直接得出的部分）。
> tldraw 机制细节指向 `node_modules/@tldraw/editor/src/lib/hooks/` 与官方文档，不在此重复。
> 违反本文的交互实现，典型症状：滚轮失效 / 内部滚动变画布平移 / 右键菜单失灵 / 画布拖拽被卡片吞掉。

## 一、四个结论性事实（每张卡片的交互都必须遵守）

### 1. 焦点：进入看板必须 `editor.focus()`

- tldraw 的 `isFocused`（`editor.getInstanceState().isFocused`）≠ DOM 焦点。`Tldraw autoFocus={false}` 时 `isFocused` 恒为 `false`，**没有任何自动翻转机制**。
- `isFocused=false` 时，tldraw 的 wheel 缩放/平移与 ctrl+wheel 防页面缩放**全部失效**（源码门控见 `useGestureEvents.ts` / `useDocumentEvents.ts`）。
- **后果**：不聚焦 → ctrl+滚轮走浏览器默认（页面缩放），普通滚轮也不平移画布。
- **结论**：`Tldraw onMount` 里必须 `editor.focus()`（看板容器已如此实现）。

### 2. 滚轮拦截必须用原生 `addEventListener`，不能用 React `onWheel`

- tldraw 的原生 wheel 监听在 `.tl-container`（比 React root 更内层），**先触发**；卡片的 React 合成 `onWheel` 在 React root 才派发，**晚于 tldraw**。
- 卡片用 React `onWheel` 做拦截，事件冒泡到 `.tl-container` 时 tldraw 已 `stopPropagation` + 画布平移——**拦截永远来不及**。
- **结论**：拦截 wheel 用原生监听挂在卡片内容容器上（bubble），让事件先到我们的监听。
- 附带结论：shape util 应声明 `canScroll() = true`，让 tldraw 在**编辑态**（editing shape）时官方豁免 wheel（双保险）。

### 3. 右键（button=2）/ 中键（button=1）一律放行，pointer 只拦左键

- 右键菜单链路：原生 `contextmenu` 必须完整冒泡到 Radix `ContextMenu.Trigger`（Trigger span 包住 `.tl-canvas`）才能打开。
- 卡片内任何吞掉 pointerdown（含 `button===2`）或 contextmenu 的 `stopPropagation` 都会让菜单打不开。
- **结论**：容器级 pointer 拦截仅 `button===0` 且仅当需要保护内部交互时；`onClick`/`onDoubleClick` 的 stopPropagation 保留（防 tldraw 把卡片内点击当画布点击，对右键无影响）。

### 4. 绑定用无依赖 effect（每次渲染重挂），不用 `useEffect([])`

- tldraw 重渲染 / resize / 展开收合会替换 shape 的 DOM；`useEffect([])` 只首次挂载跑，监听会挂在被替换的旧元素上失效。
- **结论**：wheel / pointer 拦截挂在自己组件管理的 DOM 上时，用无依赖 effect。

## 二、拦截/放行判定规则（本项目设计决策，已论证）

卡片嵌在无限画布上，画布是主操作面。**不能持续劫持事件**，只在"卡片需要交互"时拦截，其余放行画布（平移/缩放/框选/右键）。判定 = **激活状态 × 目标位置**：

| 条件 | 行为 |
|---|---|
| 卡片**未激活**（未被 tldraw 选中） | 滚轮 / pointer 全部放行给画布（背景卡不吞事件，即使光标在卡内滚动区上） |
| 卡片**激活** 且 光标在**可滚动容器**内 | 拦截滚轮 → 内部滚动（消息区 / 文本区） |
| 卡片激活 且 光标在非滚动区 | 滚轮放行给画布（平移/缩放） |
| `ctrl`/`meta` + wheel | 一律放行给画布（缩放），不吞 |
| 右键（`button===2`）/ 中键（`button===1`） | 一律放行（右键菜单必须能开） |

- **激活判定**：事件发生时实时读 `editor.getSelectedShapeIds()`（不引入 React 重渲染，不打断画布拖拽）。
- **可滚动容器判定**：从事件 target 向上找 `scrollHeight > clientHeight` 且 `overflow-y` 为 `auto/scroll/overlay` 的祖先。
- **pointer 只拦"内部真实可交互元素"**（按钮/输入/链接），不整块容器拦——否则画布拖拽/平移路过卡片被吞，右键也打不开。

## 三、新卡片交互 Checklist

### 1. 焦点
- 看板 `Tldraw onMount` → `editor.focus()`（全局一次）。侧栏输入框点击时焦点自然转移。

### 2. 滚轮（原生监听，按需拦截）
```ts
// 无依赖 effect：卡片 DOM 随 tldraw 重渲染替换，每次渲染重挂保证监听在当前元素
useEffect(() => {
  const el = contentRef.current; // 卡片内容容器（可滚动区）
  if (!el) return;
  const stop = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) return;            // 缩放交画布
    if (!isActive()) return;                        // 未激活放行（背景卡不吞滚轮）
    if (el.scrollHeight > el.clientHeight) e.stopPropagation(); // 内容溢出才拦（按需）
  };
  el.addEventListener("wheel", stop);
  return () => el.removeEventListener("wheel", stop);
});
```
- 工作台消息区内部有嵌套滚动容器时，用"从 target 向上找可滚动祖先"的 helper：
```ts
function hasScrollableAncestor(target: Node, root: HTMLElement): boolean {
  let elm: Element | null = target instanceof Element ? target : target.parentElement;
  while (elm && elm instanceof HTMLElement) {
    if (elm === root) break;
    const overflowsY = elm.scrollHeight > elm.clientHeight;
    const overflowsX = elm.scrollWidth > elm.clientWidth;
    if (overflowsY || overflowsX) {
      const s = getComputedStyle(elm);
      if ((overflowsY && ["auto","scroll","overlay"].includes(s.overflowY)) ||
          (overflowsX && ["auto","scroll","overlay"].includes(s.overflowX))) return true;
    }
    elm = elm.parentElement;
  }
  return false;
}
```
- **ShapeUtil 声明 `canScroll(): boolean { return true; }`**：让 tldraw 在编辑态官方豁免 wheel。

### 3. 指针 / 右键
```ts
onPointerDown={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
onPointerUp={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
```
- `button===2` / `button===1` 永远不拦。
- `onClick` / `onDoubleClick` 的 stopPropagation 保留。

### 4. 绑定时机
- 无依赖 effect 重挂；不要 `useEffect([])`。

## 四、踩坑记录（坑 + 最终方案，不含过程）

| 现象 | 根因 | 最终方案 |
|---|---|---|
| 初次进入看板 ctrl+滚轮触发浏览器缩放，画布不缩放 | `autoFocus={false}` → `isFocused` 恒 false → tldraw wheel 全门控失效 | `onMount` 里 `editor.focus()` |
| 编辑便笺 / 滚动消息区 = 画布平移，内部滚不动 | ① shape util 未声明 `canScroll()`；② wheel 拦截用 React 合成 `onWheel`（晚于 tldraw 原生监听） | `canScroll()=true` + 原生 `addEventListener` 拦截 |
| 右键卡片只弹一次或弹不出 | pointer 拦截吞掉 `button===2`，`contextmenu` 链路被断 | pointer 拦截仅 `button===0`，右键放行 |
| 右键打开菜单 → 左键点画布关闭后，**任何**右键都弹不出（含画布空白） | tldraw#10566：radix-ui 解析到 1.5+（项目为 1.6.x）时 `MenuClickCapture.clearOpenMenus()` 不通知 Radix，Radix internal open 卡死 | 受控化 ContextMenu override（`SyncedContextMenu`，Root `open={isOpen}` 同步 tlmenus），见下方「右键菜单失同步」 |
| 展开卡未激活时滚消息区也滚动会话历史 | wheel 拦截只看几何（目标在滚动区）不叠加激活态 | 加 `if (!isActive()) return`——未激活让给画布 |
| 画布拖拽/平移路过展开卡被阻断 | 容器级无条件 `stopPropagation` 整块拦 pointer | pointer 仅拦左键 + 激活态，非激活放行 |

### 右键菜单失同步（tldraw#10566）机制与项目修复

- **触发**：右键打开菜单 → **左键点击画布**关闭（Escape 关闭不触发）。左键关闭后任何右键都打不开，直到切 tab / 焦点变化。
- **根因**：`MenuClickCapture`（tldraw 内部）左键按下时 `clearOpenMenus()` 只清 tlmenus、不通知 Radix；tlmenus 清空导致菜单 `Content`（含 Radix DismissableLayer）卸载，Radix 失去 outside-click 关闭通道 → **Radix internal open 卡 true**，此后任何右键的 `handleOpen` 都不再生效。
- **项目修复**：`components/canvas/SyncedContextMenu.tsx` override 默认 ContextMenu，Radix Root 改**受控** `open={isOpen}`（isOpen 派生自 tlmenus）——菜单被清空时受控 prop 直接驱动 Radix 复位。与官方 PR #10567 同方案。**新增卡片时不要动这个 override**。

## 五、相关文件

- `components/canvas/CanvasStage.tsx` — Tldraw 挂载 / 焦点 / ContextMenu override
- `components/canvas/SessionCardShape.tsx` — 会话卡 shape（展开/收合）
- `components/canvas/SessionWorkbench.tsx` — 展开工作台（ChatWindow 嵌入），wheel/pointer 拦截范例
- `components/canvas/StickyNoteShape.tsx` — 便笺 shape（canScroll + 原生 wheel 拦截范例）
- `components/canvas/SyncedContextMenu.tsx` — 受控化右键菜单（修复 tldraw#10566）
- 数据/结构层面看板规则见 [boards.md](boards.md)
