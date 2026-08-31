# 看板卡片交互与事件层规范（board-events）

> 开发 tldraw 自定义 shape 卡片（会话卡 / 便笺 / 未来任何"画布上的可交互 UI"）的事件层前阅读。
> 本文自包含：先讲 tldraw 5.x 的事件机制，再讲"按需劫持"规范，最后是踩坑记录。
> 违反本文的交互实现，典型症状：滚轮失效 / 内部滚动变画布平移 / 右键菜单失灵 / 画布拖拽被卡片吞掉。

## 一、tldraw 事件机制速览（必读）

自定义 shape 嵌在 `.tl-container` 里，事件从卡片冒泡到 `.tl-container`，tldraw 在此统一劫持。
**所有交互规范的出发点都是这条 DOM 路径：卡片 → … → `.tl-shapes` → `.tl-canvas` → `.tl-container`。**

### 1. 焦点门控：isFocused 决定 wheel / 键盘是否工作

`editor.getInstanceState().isFocused` 是 tldraw 内部焦点（不等于 DOM `document.activeElement`）。
- `Tldraw` 默认 `autoFocus=true`；设为 `false` 时**没有任何自动翻转机制**，`isFocused` 恒为 `false`，除非显式 `editor.focus()`。
- `isFocused=false` 时：`useGestureEvents.onWheel` 直接 `return`（不处理画布缩放/平移）；`useDocumentEvents` 的 ctrl+wheel preventDefault 也不绑定（effect 依赖 `isAppFocused`）。
- **后果**：进入看板不聚焦 → ctrl+滚轮走浏览器默认（页面缩放），普通滚轮也不平移画布。

**规范**：看板容器挂载时必须在 `Tldraw onMount` 里 `editor.focus()`。

### 2. wheel 处理链：缩放 / 平移 / 豁免

`useGestureEvents.onWheel` 挂在 `.tl-container`（原生 `addEventListener('wheel')`，bubble），`isFocused` 门控通过后：

1. **editing shape 豁免**：若正在编辑某个 shape 且其 util `canScroll()` 返回 `true`，且光标在该 shape bounds 内 → `return`（不劫持，让内部滚动）。
2. 否则 `preventDefault()` + `stopPropagation()`，把 delta 交给 editor → 默认 `wheelBehavior:'pan'`（普通滚轮平移，ctrl+wheel 缩放）。
3. 另有 `useDocumentEvents` 的 `handleWheel`：只要 `e.ctrlKey||e.metaKey` 且 target 在 container 内 → `preventDefault`（防页面缩放）。

**关键**：这条原生监听在 `.tl-container` 上，**比 React 合成事件先触发**（见第 4 点）。

### 3. 右键菜单链路

- `useCanvasEvents.onPointerDown`（.tl-canvas）对 `button===2` dispatch `right_click`（选中 shape）。
- 原生 `contextmenu` 冒泡到 Radix `ContextMenu.Trigger`（默认不渲染 wrapper，Trigger span 包住 `.tl-canvas`）→ `handleOpen` 打开菜单。
- `MenuClickCapture`：菜单打开或指针按下时渲染全屏 overlay，右键按下时 `swallowNextNativeContextMenu()`（document capture 吞下一个原生 contextmenu）+ `clearOpenMenus()`。

**结论**：右键菜单能否打开，取决于 `contextmenu` 事件是否完整冒泡到 Trigger span。**卡片内任何 `stopPropagation` 吞掉 pointerdown 或 contextmenu 都会让菜单打不开**。

**⚠ 已知失同步坑（tldraw#10566）**：tldraw 5.3.2 依赖 `radix-ui ^1.4.2`，若解析到 1.5+（本项目为 1.6.x），左键点击画布关闭菜单后右键**永远打不开**（Escape 关闭正常）：
1. 右键打开菜单 → Radix internal open=true + tlmenus 记菜单
2. 左键点画布 → `MenuClickCapture.clearOpenMenus()` 只清 tlmenus、不通知 Radix；且 tlmenus 清空导致 `{isOpen && <Content>}` 卸载、DismissableLayer 消失，Radix 失去 outside-click 关闭通道 → **Radix internal open 卡 true**
3. 此后任何右键的 `handleOpen` 都不再生效

**修复（本项目）**：CanvasStage 用 `SyncedContextMenu`（`components/canvas/SyncedContextMenu.tsx`）override 默认 ContextMenu，把 Radix Root 改为**受控** `open={isOpen}`（isOpen 派生自 tlmenus）——菜单被清空时受控 prop 直接驱动 Radix 复位，与官方 #10567 同方案。**新增类似卡片时不要动这个 override**。

### 4. React 合成事件 vs 原生监听（最容易踩的坑）

- tldraw 的 wheel / gesture 用**原生 `addEventListener`** 挂在 `.tl-container`（比 React root 更内层）。
- 卡片的 React 合成 `onWheel` 在 **React root 委托**（`.tl-container` 外层）才派发。
- **事件冒泡顺序：先到 `.tl-container` 的原生监听，后到 React root 的合成派发**。
- 因此卡片用 `onWheel`（React 合成）做拦截**永远来不及**——tldraw 原生监听已经 `stopPropagation` + 画布平移了。

**规范**：拦截 wheel 必须用**原生 `addEventListener`** 挂在卡片内容容器上（bubble），让事件先到我们的监听、再到 `.tl-container`。

## 二、核心原则：按需劫持（状态 × 几何）

卡片嵌在无限画布上，画布是主操作面。**卡片不能持续劫持事件**——只在"卡片需要交互"时才拦截，其余放行给画布（平移/缩放/框选/右键）。

判定 = **状态 × 几何**：

| 条件 | 行为 |
|---|---|
| 卡片**未激活**（未被 tldraw 选中） | 滚轮 / pointer **全部放行**给画布（背景卡不吞事件，即使光标在卡内滚动区上） |
| 卡片**激活** 且 光标在**可滚动容器**内 | 拦截滚轮 → 内部滚动（消息区 / 文本区） |
| 卡片激活 且 光标在非滚动区 | 滚轮放行给画布（平移/缩放） |
| `ctrl`/`meta` + wheel | 一律放行给画布（缩放），不吞 |
| 右键（`button===2`）/ 中键（`button===1`） | 一律放行（右键菜单必须能开） |

- **激活判定**：事件发生时实时读 `editor.getSelectedShapeIds()`（不引入 React 重渲染，不打断画布拖拽）。
- **可滚动容器判定**：从事件 target 向上找，是否存在 `scrollHeight > clientHeight` 且 `overflow-y` 为 `auto/scroll/overlay` 的祖先（见下方 helper）。
- **pointer 只拦"内部真实可交互元素"**（按钮/输入/链接），不整块容器拦——否则画布拖拽/平移路过卡片被吞，右键也打不开。

## 三、交互规范 Checklist（开发新卡片照此实现）

### 1. 焦点
- 看板 `Tldraw onMount` → `editor.focus()`。侧栏输入框点击时焦点自然转移，无需额外处理。

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
- 也可以复用"从 target 向上找可滚动祖先"的通用 helper（工作台消息区内部有嵌套滚动容器时）：
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
- **ShapeUtil 声明 `canScroll(): boolean { return true; }`**：让 tldraw 在**编辑态**（editing shape）时豁免 wheel（官方机制，双保险）。

### 3. 指针 / 右键
- 容器级 pointer 拦截**仅限左键**，且只在你需要保护内部交互时：
```ts
onPointerDown={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
onPointerUp={(e) => { if (e.button === 0 && isActive()) e.stopPropagation(); }}
```
- `button===2`（右键）、`button===1`（中键）**永远不拦**——右键要冒泡到 tldraw 打开菜单。
- `onClick` / `onDoubleClick` 的 stopPropagation 保留（防止 tldraw 把卡片内点击当画布点击），对右键无影响。

### 4. 绑定时机
- wheel / pointer 拦截如果挂在自己组件管理的 DOM 上，用**无依赖 effect**（每次渲染重挂），避免 tldraw 重渲染替换 DOM 后监听挂到旧元素失效。
- 不要用 `useEffect([])`（只在首次挂载跑），tldraw 的 shape DOM 会被替换。

## 四、踩坑记录（问题 → 根因 → 解法）

| 现象 | 根因 | 解法 |
|---|---|---|
| 初次进入看板 ctrl+滚轮触发浏览器缩放，画布不缩放 | `autoFocus={false}` → `isFocused` 恒 false → tldraw wheel 全门控失效 | `onMount` 里 `editor.focus()` |
| 编辑便笺 / 滚动消息区 = 画布平移，内部滚不动 | ① shape util 未声明 `canScroll()`；② 卡片 wheel 拦截用 React 合成 `onWheel`（时机晚于 tldraw 原生监听，来不及 stop） | `canScroll()=true` + 原生 `addEventListener` 拦截 |
| 右键卡片（便笺/展开工作台）只弹一次或弹不出 | pointer 拦截无条件/条件化吞掉 `button===2`，`contextmenu` 链路被断 | pointer 拦截仅 `button===0`，右键放行 |
| 右键打开菜单 → 左键点画布关闭后，**任何**右键都弹不出（含画布空白） | tldraw#10566：radix-ui 解析到 1.5+，`MenuClickCapture.clearOpenMenus()` 不通知 Radix，Radix internal open 卡死 | 受控化 ContextMenu override（`SyncedContextMenu`），Root `open={isOpen}` 同步 tlmenus |
| 展开卡未激活时滚消息区也滚动会话历史 | wheel 拦截只看几何（目标在滚动区）不叠加激活态 | 加 `if (!isActive()) return`——未激活让给画布（常见场景：展开会话看内容但想移画布） |
| 画布拖拽/平移路过展开卡被阻断 | 容器级无条件 `stopPropagation` 整块拦 pointer | pointer 仅拦左键 + 激活态，非激活放行 |

## 五、相关文件

- `components/canvas/CanvasStage.tsx` — Tldraw 挂载 / 焦点
- `components/canvas/SessionCardShape.tsx` — 会话卡 shape（展开/收合）
- `components/canvas/SessionWorkbench.tsx` — 展开工作台（ChatWindow 嵌入），wheel/pointer 拦截范例
- `components/canvas/StickyNoteShape.tsx` — 便笺 shape（canScroll + 原生 wheel 拦截范例）
- `components/canvas/SyncedContextMenu.tsx` — 受控化右键菜单（修复 tldraw#10566），见「右键菜单链路」
- 数据/结构层面看板规则见 [boards.md](boards.md)
