# pi-web 中 subagent 展示机制调研报告（2026-08-29）

## 一、结论先行（产品视角）

**pi-web 没有"subagent 功能"，它只是被动地把扩展推来的状态快照摆出来。** 你看到的混乱，根源是：subagent 的数据形态是 pi-subagents 插件专属的，而 pi-web 用一个通用渲染器去套它，两边没有对齐。

具体到你的三个痛点：

| 痛点 | 根因（一句话） |
|---|---|
| 管理混乱、摸不到规律 | subagent 有 3 种完全不同的"露面方式"（对话气泡 / 底部块 / 状态文本），各自独立渲染，互不关联 |
| 底部块时而能展开、时而不能 | 展开条件是写死的"行数 > 1"。subagent 在网页模式下推的是**一行 JSON**（展开不了），偶尔多几行（能展开，但内容是一坨 JSON） |
| 看不到执行过程 | 每个 subagent 子任务的完整执行过程（调了哪些工具、输出了什么）只存在磁盘日志文件里，pi-web 从头到尾没读过 |

一句话总结：**不是展示做得差，是展示层根本没接上数据源。**

## 二、三个痛点分别怎么来的（通俗解释）

### 1. 为什么管理混乱、摸不到规律

subagent 在 pi 里有两个"出场通道"，pi-web 分别渲染成两种完全不同的东西：

- **对话里**：subagent 作为一次"工具调用"出现在消息流里，像其他工具一样是个可展开的小气泡（绿点 + 名称 + 耗时）。里面能看到调用参数和最终返回的一段文字。
- **编辑器下方**：pi-subagents 插件通过"widget"通道把自己的运行状态推到界面底部一条栏上（你看到的"subagent 块"）。它推的是**运行中/完成后的状态快照**，不是对话。

同样的 subagent，一会儿出现在对话里、一会儿出现在底部栏，**两者之间没有任何关联标识**，看起来自然就乱。

### 2. 为什么底部块时而能展开、时而不能

pi-web 的通用"widget 展开规则"是这样的死逻辑：

- 内容只有 1 行 → 不可展开（就是个静态标签）
- 内容有 2~3 行 → 默认自动展开
- 内容 > 3 行 → 可点击展开

而 pi-subagents 插件发现自己在"网页模式"下运行时，会把本来很丰富的状态**压缩成一行 JSON** 推过来。于是：

- 大多数时候 = 1 行 JSON → 你看到块但点不开
- 偶尔赶上快照恰好多几行 → 能点开，但看到的是原始 JSON 文本（"概览"其实就是 JSON 没解析）

**这是两套规格没对齐**：插件以为网页端能理解它的 JSON，网页端却把它当成普通文本行。

### 3. 为什么看不到执行过程

subagent 子任务跑起来后，它的完整过程（每一步调了什么工具、读到什么、写了什么文件）全部写进了磁盘上的日志文件（`/tmp/pi-subagents-*/async-subagent-runs/<id>/` 下的 `events.jsonl` 等）。

pi-web 只拿到了"状态摘要"，从没去读这些日志。而插件其实预留了一个官方"查询接口"（`/subagents-inspect-rpc` 扩展命令），专门用来按需拉取某个子任务的详细过程——**但 pi-web 没有调用它的能力**（网页端把扩展的命令执行接口截断成"取消"）。

## 三、技术实现（给开发看的部分）

### 数据流

```
pi-subagents 插件                    pi-web
   │  ctx.ui.setWidget("subagent-async", [...])
   ├──────────────────────────────────►  lib/rpc-manager.ts 被动接收
   │                                    （扩展以 mode:"rpc" 绑定）
   │  RPC 模式下发送单行 JSON 快照       ExtensionWidgets.tsx 通用渲染
   │  "PI_SUBAGENT_ASYNC_JSON:{...}"    （展开规则写死：行数>1 才可展开）
   │
   │  setStatus("subagent-slash", ...)  底部状态文本行（第三种露面方式）
   └──────────────────────────────────►  ExtensionStatusBar.tsx
```

### 关键代码位置

| 内容 | 位置 |
|---|---|
| 扩展以 RPC 模式绑定 + widget/status 中转 | `pi-web-sky/lib/rpc-manager.ts`（`ensureExtensionsBound`、`createExtensionUiContext`） |
| 通用 widget 渲染 + 展开规则 | `pi-web-sky/components/ExtensionWidgets.tsx`（`getDefaultExpandedWidgetKey`、`lines.length > 1`） |
| 底部栏展示 | `pi-web-sky/components/ExtensionStatusBar.tsx` |
| 对话内工具气泡 | `pi-web-sky/components/MessageView.tsx`（`ToolCallBlock`） |
| 插件端 RPC 快照降级 | `pi-subagents/src/tui/render.ts`（`renderWidget`：rpc 模式 → 单行 JSON） |
| 插件端舰队视图（TUI 独有） | `pi-subagents/src/tui/fleet-status.ts` |
| 完整执行过程日志 | `/tmp/pi-subagents-*/async-subagent-runs/<id>/`（`events.jsonl`、`output-*.log`） |
| 官方按需查询接口 | `/subagents-inspect-rpc` 扩展命令 → `PI_SUBAGENT_INSPECT_JSON` 回包 |

### 一个细节佐证

pi-web 给插件提供的界面上下文里，`getToolsExpanded: () => false` 是写死的——插件在终端里能感知"工具面板是否展开"来切换详略展示，在网页里永远收不到"展开"信号，于是只能永远发最简快照。**网页端从来不知道插件想要什么。**

## 四、优化路径评估

### 能普适解决吗？——不能，但可以做得很薄

- widget 展开规则是 pi-web 的**通用组件**（所有插件共用），为 subagent 改它 = 影响所有插件，不可取。
- subagent 的 JSON 快照结构、日志格式、inspect 协议都是 **pi-subagents 专属约定**。解析它、渲染它、点击拉详情，本质是"为这个插件写适配"。

**结论：必须写专属适配代码。** 但好消息是官方协议是现成的、稳定的，适配量很小，不是重新发明：

### 推荐的适配方案（薄适配，约 3 块）

1. **识别 + 解析**：在 `ExtensionWidgets` 或独立组件里识别 `subagent-async` 这个 widget key，解析 `PI_SUBAGENT_ASYNC_JSON:` 前缀的 JSON 快照，渲染成结构化卡片（子任务列表：agent 名 / 状态 / 耗时 / token）。
2. **点击拉详情**：卡片上放"查看详情"，调 `subagent({ action: "status", id, view: "transcript" })` 或走官方 inspect RPC 协议，读回完整过程渲染成可滚动视图。
3. **（可选）对话内关联**：给对话里的 subagent 工具气泡和底部卡片加同一个 runId 关联，点击互跳，解决"两处露面互不相认"的混乱感。

### 备选方案（更省事但体验打折）

- 只做第 1 块（解析 JSON 成卡片），不做点击详情——能看到"有哪些子任务、什么状态"，但看不到过程，治标不治本。
- 或者改插件侧：让插件在 RPC 模式下不要降级成单行 JSON，而是发多行文本快照（多行 > 3 就能展开）——改动最小，但内容还是文本，不是结构化视图。

## 五、建议

优先做"识别 + 解析 + 详情拉取"的薄适配，一个专属组件搞定。收益最大的是第 3 点（对话气泡 ↔ 底部卡片关联），它直接消灭"管理混乱"的观感；其次是详情拉取，解决"看不到过程"。

---

*调研基于 pi-web-sky 当前代码（rpc-manager.ts / ExtensionWidgets.tsx / ExtensionStatusBar.tsx / MessageView.tsx）与 pi-subagents 插件源码（render.ts / fleet-status.ts / async-status-snapshot.ts）*
