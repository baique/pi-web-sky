# 看板 RF/yjs 开发陷阱（review 沉淀）

> 源自 2026-09 看板核心治理 review：一次隐形回归（节点全隐）与两轮 resize 还原 bug 的根因与纪律。

## 陷阱

### 1. 删"冗余"字段前先查库契约

看着无用的字段可能是库渲染/判定依据。案例：`cleanNode` 剥 `measured` → RF `nodeHasDimensions`（读 `measured?.width ?? width ?? initialWidth`，**不读 style**）判节点无尺寸 → `visibility:hidden` → 点不中 / resize 失效 / 拖入的卡隐形。

**纪律**：删/改任何字段前，先确认它是纯业务数据还是第三方库（RF/yjs）契约。查库源码验证，不凭字段语义推断。

### 2. 优先官方公开 API，别赌内部 change 流

resize 落库曾依赖 `onNodesChange` 的 `dimensions(resizing:false)` change——RF 内部行为：onEnd change **无 `setAttributes`** → `applyChange` 只更新 `measured` 不更新 `style`/顶层 width/height；渲染尺寸**优先 style** → 只落 measured 松手就还原。且 RF 重初始化 XYResizer 会派发旧值幽灵 change 覆盖刚落库。

**纪律**：交互终值落库用官方回调（NodeResizer `onResizeEnd` 一次性写全 style/顶层/data），`onNodesChange` 只做本地跟手。为绕路路径补守卫/ref 跟踪是债——切回官方契约代码更少、升级不易坏。

### 3. 尺寸落库三处对齐

RF 尺寸来源：顶层 `width/height` > `style.width/height`（渲染）> `measured`（测量缓存）。改尺寸类操作（resize/toggleExpand/onResizeEnd）落库要写全有读者的地方，验证时 dump yjs 数据确认，**不能只看 UI 跟手**（跟手是本地 state，落库是另一回事）。

### 4. 写路径改动的回归范围

一处交互改动后，四件套必测：**拖拽 / resize / 拖入 / 选中+手柄**。高频写抑制（每帧 → 松手一次）尤其要验证松手后的最终落库值。

### 5. e2e 用干净环境

新建独立看板 + API 造数据（`POST /api/boards`），视口缩小留操作空间，每步验证 elementFromPoint/visibility——别在存量污染数据上猜状态。坐标换算记 pane 偏移，screenToFlowPosition 是唯一正确入口。
