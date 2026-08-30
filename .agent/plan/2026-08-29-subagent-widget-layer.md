# Subagent 显示薄层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（本任务改动集中在少量独立文件，单写者串行执行）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 pi-web 把 pi-subagents 推来的 `subagent-async` 结构化 JSON 快照渲染成可读卡片，并可点击查看子任务完整执行过程。

**Architecture:** 在 `ExtensionStatusBar`（fork 后已与上游分叉的组件）里拦截 `subagent-async` widget，交给新组件 `SubagentWidgetCard` 渲染；点"查看详情"走现有 `prompt` 通道调 `/subagents-inspect-rpc` 扩展命令（SDK 已验证会直接执行 handler、不走模型），SSE 捕获 emit-then-retract 的 `subagent-inspect` 回包渲染详情面板。不新增依赖、不改 RPC 协议、不碰 SDK。

**Tech Stack:** React（Next.js App Router），现有 `ExtensionStatusBar`/`ExtensionWidgets`/`useAgentSession` 事件流。

## Global Constraints

- **不改 RPC 协议**：不新增 RPC 命令；详情复用现有 `prompt` 通道发 `/subagents-inspect-rpc`
- **不新增 npm 依赖**
- **不碰上游核心文件**：`lib/rpc-manager.ts`、`hooks/useAgentSession.ts`、`lib/types.ts` 不动（除非万不得已）
- **插件零改动**：pi-subagents 不升级不改配置
- **降级安全**：非 `subagent-async` widget 行为完全不变；解析失败时降级为文本显示
- 提交粒度：每个任务结束一次提交

---

## 文件结构

```
新增：
  components/subagent/SubagentWidgetCard.tsx      快照→卡片（列表/状态/耗时/token）+ "查看详情"按钮
  components/subagent/SubagentInspectPanel.tsx    详情面板（messages 时间线 + finalOutput）
  lib/subagent-widget.ts                          解析 PI_SUBAGENT_ASYNC_JSON → 结构化数据；注册表骨架
  lib/extension-command.ts                        invokeExtensionCommand() 封装（prompt 通道 + requestId 缓冲 + SSE 捕获）

修改（仅1个上游分叉文件）：
  components/ExtensionStatusBar.tsx               拦截 subagent-async → 交给 SubagentWidgetCard
```

## 任务分解

### Task 1: `lib/subagent-widget.ts` — 快照解析 + 注册表骨架

**文件:** `lib/subagent-widget.ts`（新增）

**职责:**
- `parseSubagentSnapshot(lines: string[]): SubagentSnapshot | null`：首行匹配 `PI_SUBAGENT_ASYNC_JSON:` 前缀 → `JSON.parse` 余下部分；校验 `kind === "pi-subagents.async-status-snapshot"`；失败返回 null
- 类型定义 `SubagentSnapshot`（对齐 pi-subagents 的 `AsyncStatusSnapshotV1`：`runs: NodeV1[]`，Node 含 `id/label/state/startedAt/activity/children`）
- 注册表骨架：`export const widgetParsers: Record<string, (lines: string[]) => unknown | null>`，现在只注册 `subagent-async → parseSubagentSnapshot`，注释说明未来插件扩展方式

**测试**（`lib/subagent-widget.test.mjs`）:
- 正常快照解析成功，字段映射正确
- 非 JSON 前缀返回 null
- 非法 JSON 返回 null
- 前缀对但 kind 不符返回 null

### Task 2: `lib/extension-command.ts` — inspect 命令封装

**文件:** `lib/extension-command.ts`（新增）

**职责:**
- `invokeSubagentInspect(args: { asyncId: string; childId?: string }, onReply: (reply: InspectReply) => void): Promise<void>`
  - 生成 `requestId`（符合 `[A-Za-z0-9_-]{1,64}`）
  - 通过现有 `sendAgentCommand(sid, { type: "prompt", message: \`/subagents-inspect-rpc ${requestId} ${asyncId} [childId] [--lines N]\` })` 触发
  - 依赖外部传入的"inspect 回包监听器"（由调用方用 SSE 捕获）——这里只负责发命令 + 提供回包类型校验
- 类型定义 `InspectReply`（对齐 `pi-subagents.inspect-reply` v1：`kind/version/requestId/asyncId/status/messages/finalOutput/error`）

**设计要点:** 回包捕获不放这里——因为 SSE 捕获点（`useAgentSession.handleExtensionUiRequest`）是上游文件。方案：`SubagentWidgetCard` 在挂载时向一个模块级 `subscribeInspectReplies(cb)` 注册，`ExtensionStatusBar` 拦截到 `subagent-inspect` widget（emit-then-retract 两帧）时分发给订阅者。这样**不用碰 useAgentSession**。

### Task 3: `components/subagent/SubagentInspectPanel.tsx` — 详情面板

**文件:** `components/subagent/SubagentInspectPanel.tsx`（新增）

**职责:**
- 展示 `InspectReply`：顶部 = 状态/标签；中间 = `messages[]` 时间线（role 着色：user/assistant/toolCall/toolResult，toolCall 显示 name）；底部 = `finalOutput`（若存在）
- 折叠式：toolCall/toolResult 默认折叠，点击展开参数/输出
- 关闭按钮 + 遮罩，复用现有 dialog 样式（参考 `ExtensionCustomPanel` 的视觉）

**测试:** 以渲染为主，用 `MessageView` 现有测试风格做基础断言（可选）。

### Task 4: `components/subagent/SubagentWidgetCard.tsx` — 快照卡片

**文件:** `components/subagent/SubagentWidgetCard.tsx`（新增）

**职责:**
- 入参 `snapshot: SubagentSnapshot`，渲染子任务树（runs 递归）：每行 = 状态圆点 + label + state + 耗时 + token（有则显示）
- 折叠态 = 一行摘要（"3 runs · 1 running · 2 done"）；展开 = 完整树
- 每行子任务右侧"查看详情"按钮 → `invokeSubagentInspect` → 弹 `SubagentInspectPanel`
- 通过 `subscribeInspectReplies` 接收回包，按 `requestId` 匹配到对应行

### Task 5: `ExtensionStatusBar.tsx` — 拦截挂载（方案 B）

**文件:** `components/ExtensionStatusBar.tsx`（修改）

**改动:**
- `widgets` 中过滤出 `key === "subagent-async"` 的项 → 若 `parseSubagentSnapshot` 成功，渲染 `<SubagentWidgetCard/>`（放在 shelf 左区，替换该 widget 的 trigger）
- 其余 widget 原样传给 `ExtensionWidgets`
- 解析失败 → 原样传给 `ExtensionWidgets`（文本降级）
- 顺带监听 `subagent-inspect` widget（`key === "subagent-inspect"`）分发给订阅者（emit-then-retract，两帧都要处理，retract 帧 lines 为 undefined 时忽略）

**注意:** 这里用 `useAgentSession` 已有的 `extensionWidgets` state 流转，不新增 state。

### Task 6: 集成验证（e2e，dev 技能约定用 playwright）

**验证项:**
1. 发起一个 subagent 任务（如 `/subagents-fleet` 或对话中调用），底部出现结构化卡片而非 JSON
2. 卡片显示子任务名/状态/耗时
3. 点击"查看详情"弹出面板，显示执行过程（工具调用/输出）
4. 其他 widget（如 web-activity）显示行为不变
5. `npm run dev` + 浏览器实测（playwright + chrome-devtools）

---

## 提交计划

- Task 1 完成 → commit "feat(subagent-widget): 快照解析 + 注册表骨架"
- Task 2 完成 → commit "feat(extension-command): inspect 命令封装"
- Task 3 完成 → commit "feat(subagent-inspect-panel): 详情面板"
- Task 4 完成 → commit "feat(subagent-widget-card): 快照卡片"
- Task 5 完成 → commit "feat(extension-status-bar): 拦截 subagent-async 渲染卡片"
- Task 6 验证 → 修复后合并提交

## 风险与回退

- **inspect 回包捕获**：依赖 `subagent-inspect` widget 两帧（emit + retract）都经 SSE 到达。若 retract 帧覆盖 emit 帧导致丢包，退路：详情面板改为显示"请查看 /subagents 命令"提示，不阻塞主功能。
- **prompt 通道并发**：inspect 命令与用户 prompt 并发时，SDK 的 prompt admission 会串行化，详情请求可能排队——可接受（只影响点开详情的延迟）。
- **上游合并**：`ExtensionStatusBar.tsx` 是 fork 后已改文件，本任务只加拦截分支，合并冲突概率低；新增文件零冲突。
