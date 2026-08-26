# Composer 控制台化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (本任务改动集中在同两个大文件，单写者串行执行；不使用 subagent-driven)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `.agent/spec/2026-08-26-composer-console-design.md` 将 composer 改造为"控制台"：常驻顶栏播报槽（状态/公告/额度）、右下角锚定输入按钮、发件箱收编、草稿更名 TODO 并浮层化。

**Architecture:** 新增 `useBroadcast` hook（纯优先级选择器 + 本地 pinned error 状态，公告排队复用 `useAgentSession` 既有机制）与 `ComposerHeader` 组件；`ChatWindow` 删除消息流胶囊与桌面端 NoticeShelf，改喂新 prop；`ChatInput` 面板内自上而下重组为 顶栏→发件箱→图片预览→输入行→工具栏。

**Tech Stack:** Next.js App Router / React 19 / 原生 CSS token（不新增样式）/ node:test（`*.test.mjs`）

## Global Constraints

- 不新增任何样式 token：只用既有 `--frame-glass`、`--bubble-*`、`--text*`、`--border` 等（spec §6）
- 不新增依赖包；thinking-orbs 已有
- 移动端行为全部保持现状（NoticeShelf 顶部居中保留，spec §8）
- 每个任务结束：`node_modules/.bin/tsc --noEmit` 通过 + 相关测试通过 + git commit
- 测试运行：`npm test`（node --test）；组件逻辑测试放对应 `*.test.mjs`
- 提交信息用中文 conventional commits

---

### Task 1: `useBroadcast` 播报槽状态机

**Files:**
- Create: `hooks/useBroadcast.ts`
- Test: `hooks/useBroadcast.test.mjs`

**Interfaces:**
- Consumes: `NoticeItem`（`hooks/useAgentSession.ts:94`，字段 `{id, message, type, exiting?}`）
- Produces:

```ts
export type QuotaInfo =
  | { kind: "balance"; text: string }
  | { kind: "usage"; items: { label: string; pct: number; text: string }[] };

export type Broadcast =
  | { level: "error"; text: string }                      // P0 常驻直到 dismiss
  | { level: "notice"; text: string; kind: NoticeType }   // P1 插播（随 notices 自身过期消失）
  | { level: "phase"; text: string; orb: "breathing" | "working" } // P2 含重试
  | { level: "idle"; quota: QuotaInfo | null };           // P3

export function pickPinnedErrorId(notices: NoticeItem[]): string | null;
export function pickAnnouncement(notices: NoticeItem[]): NoticeItem | null; // 末条非 error 且非 exiting
export function resolveBroadcast(input: {
  notices: NoticeItem[];
  dismissedErrors: string[];       // 已手动关闭的 error notice id
  phase: { text: string; orb: "breathing" | "working" } | null;
  retryText: string | null;
  quota: QuotaInfo | null;
}): Broadcast;

export function useBroadcast(opts: {
  notices: NoticeItem[];
  phase: { text: string; orb: "breathing" | "working" } | null;
  retryText: string | null;
  quota?: QuotaInfo | null;        // 本期调用方恒传 null，仅留座
}): { broadcast: Broadcast; dismissError: () => void };
```

- [ ] **Step 1: 写失败测试**

```js
// hooks/useBroadcast.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
// TS 源码经 --experimental-strip-types 直接加载
const mod = await import("./useBroadcast.ts");
const { pickPinnedErrorId, pickAnnouncement, resolveBroadcast } = mod;

test("pickPinnedErrorId 返回第一条 error", () => {
  const notices = [
    { id: "a", message: "info1", type: "info" },
    { id: "b", message: "boom", type: "error" },
    { id: "c", message: "boom2", type: "error" },
  ];
  assert.equal(pickPinnedErrorId(notices), "b");
  assert.equal(pickPinnedErrorId([{ id: "x", message: "ok", type: "success" }]), null);
});

test("pickAnnouncement 取末条非 error 非 exiting", () => {
  const notices = [
    { id: "a", message: "rtk run", type: "info" },
    { id: "b", message: "boom", type: "error" },
    { id: "c", message: "done", type: "success", exiting: true },
  ];
  assert.equal(pickAnnouncement(notices)?.id, "a");
});

test("resolveBroadcast 优先级 error > notice > retry > phase > idle", () => {
  const base = { dismissedErrors: [], retryText: null, phase: null, quota: null };
  const n = (id, type) => ({ id, message: `m-${id}`, type });
  // P0
  let b = resolveBroadcast({ ...base, notices: [n("a", "info"), n("b", "error")] });
  assert.equal(b.level, "error");
  // P0 被 dismissed 后回落
  b = resolveBroadcast({ ...base, notices: [n("a", "info"), n("b", "error")], dismissedErrors: ["b"] });
  assert.equal(b.level, "notice");
  // P1
  b = resolveBroadcast({ ...base, notices: [n("a", "warning")] });
  assert.equal(b.level, "notice");
  // P2 重试压过 phase
  b = resolveBroadcast({
    ...base, notices: [],
    retryText: "重试中 2/5 — boom",
    phase: { text: "正在等待模型…", orb: "breathing" },
  });
  assert.equal(b.level, "phase");
  assert.match(b.text, /重试中/);
  // P2 phase
  b = resolveBroadcast({ ...base, notices: [], phase: { text: "正在等待模型…", orb: "breathing" } });
  assert.equal(b.level, "phase");
  assert.equal(b.orb, "breathing");
  // P3
  b = resolveBroadcast({ ...base, notices: [], quota: { kind: "balance", text: "$4.21" } });
  assert.deepEqual(b, { level: "idle", quota: { kind: "balance", text: "$4.21" } });
  b = resolveBroadcast(base);
  assert.deepEqual(b, { level: "idle", quota: null });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test 2>&1 | grep -A3 useBroadcast || node --experimental-strip-types --test hooks/useBroadcast.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// hooks/useBroadcast.ts
"use client";
import { useCallback, useEffect, useState } from "react";

export type NoticeType = "info" | "success" | "warning" | "error";

export interface BroadcastNotice {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
}

export type QuotaInfo =
  | { kind: "balance"; text: string }
  | { kind: "usage"; items: { label: string; pct: number; text: string }[] };

export type Broadcast =
  | { level: "error"; text: string }
  | { level: "notice"; text: string; kind: NoticeType }
  | { level: "phase"; text: string; orb: "breathing" | "working" }
  | { level: "idle"; quota: QuotaInfo | null };

/** 第一条 error 公告的 id（notices 为旧→新序） */
export function pickPinnedErrorId(notices: BroadcastNotice[]): string | null {
  const err = notices.find((n) => n.type === "error" && !n.exiting);
  return err?.id ?? null;
}

/** 末条非 error、非 exiting 的公告 */
export function pickAnnouncement(notices: BroadcastNotice[]): BroadcastNotice | null {
  for (let i = notices.length - 1; i >= 0; i--) {
    const n = notices[i];
    if (n.type !== "error" && !n.exiting) return n;
  }
  return null;
}

export function resolveBroadcast(input: {
  notices: BroadcastNotice[];
  dismissedErrors: readonly string[];
  phase: { text: string; orb: "breathing" | "working" } | null;
  retryText: string | null;
  quota: QuotaInfo | null;
}): Broadcast {
  const { notices, dismissedErrors, phase, retryText, quota } = input;
  const errId = pickPinnedErrorId(notices);
  if (errId && !dismissedErrors.includes(errId)) {
    return { level: "error", text: notices.find((n) => n.id === errId)!.message };
  }
  const ann = pickAnnouncement(notices);
  if (ann) return { level: "notice", text: ann.message, kind: ann.type };
  if (retryText) return { level: "phase", text: retryText, orb: "working" };
  if (phase) return { level: "phase", text: phase.text, orb: phase.orb };
  return { level: "idle", quota };
}

/**
 * 播报槽：单一出口按 P0>P1>P2>P3 显示。
 * error 在 notices 过期后仍需常驻 → 记住最近一次出现的 error id，
 * 直到用户 dismiss。公告排队/过期直接复用 useAgentSession 的 notice 机制。
 */
export function useBroadcast(opts: {
  notices: BroadcastNotice[];
  phase: { text: string; orb: "breathing" | "working" } | null;
  retryText: string | null;
  quota?: QuotaInfo | null;
}) {
  const { notices, phase, retryText, quota = null } = opts;
  const [dismissedErrors, setDismissedErrors] = useState<string[]>([]);
  const currentErrId = pickPinnedErrorId(notices);
  const seenErrRef = useRef<string | null>(null);

  useEffect(() => {
    if (currentErrId && currentErrId !== seenErrRef.current) {
      // 新的 error 出现：清掉旧 dismissal，只 pin 最新这条
      seenErrRef.current = currentErrId;
      setDismissedErrors((prev) => (prev.includes(currentErrId) ? prev : [...prev.slice(-9), currentErrId]));
    }
    if (!currentErrId) seenErrRef.current = null;
  }, [currentErrId]);

  const dismissError = useCallback(() => {
    if (seenErrRef.current) setDismissedErrors((prev) => [...prev, seenErrRef.current!]);
  }, []);

  return { broadcast: resolveBroadcast({ notices, dismissedErrors, phase, retryText, quota }), dismissError };
}

import { useRef } from "react";
```

注意：`useRef` 与其余 import 合并到文件顶部（上面尾行仅为示意位置，实现时归位）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-strip-types --test hooks/useBroadcast.test.mjs`
Expected: PASS 全部

- [ ] **Step 5: Commit**

```bash
git add hooks/useBroadcast.ts hooks/useBroadcast.test.mjs
git commit -m "feat: useBroadcast 播报槽状态机（P0-P3 优先级）"
```

---

### Task 2: `ComposerHeader` 常驻顶栏组件

**Files:**
- Create: `components/ComposerHeader.tsx`
- Test: `components/ComposerHeader.test.mjs`（渲染快照级断言，沿用现有组件测试风格）

**Interfaces:**
- Consumes: Task 1 的 `Broadcast`、`dismissError`
- Produces:

```tsx
export function ComposerHeader(props: {
  broadcast: Broadcast | null;          // null 时整条顶栏仍渲染（常驻），左侧显示空
  onDismissError: () => void;
  right?: React.ReactNode;              // 右侧插槽：发件箱 chip、TODO chip 由父级放入
  isDark: boolean;                      // thinking-orbs theme
});
```

- 样式只用既有 token：外层一行 `display:flex; align-items:center; justify-content:space-between; height:34px`；左区文字 12px mono `var(--text)`，底色透明（面板已有 `--frame-glass`），error 态加 `boxShadow: inset 2px 0 0 #ef4444` 于左缘（内阴影线，不加新 token）
- orb 渲染规则照抄 `ChatWindow.tsx:1047` 现有用法（size=20、显式 theme、浅色 filter），orb 只在 `level==="phase"` 或 `level==="error"` 时出现
- `level==="notice"` 左侧显示彩色圆点（颜色映射照抄 `NoticeShelf`：error #ef4444 / warning #d97706 / success #10b981 / info var(--accent)）
- `level==="idle"` 且 quota 存在：balance 显示 mono 文本；usage 显示 `label ▓▓░ text` 微缩条（▓=pct 填充，纯字符实现）
- 文本一律单行 ellipsis；error 行尾有 ✕ 按钮（onDismissError）；notice/phase 无按钮

- [ ] **Step 1: 写失败测试**——断言：① broadcast=null 渲染空顶栏不抛错；② error 级渲染文本+✕；③ notice 级渲染圆点+文本且无 ✕；④ phase 级含 orb 占位与文本；⑤ idle+quota balance 渲染 `$4.21`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（结构如下）

```tsx
<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 8, height: 34, padding: "0 6px", minWidth: 0 }}>
  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1,
                boxShadow: isError ? "inset 2px 0 0 #ef4444" : undefined,
                paddingLeft: isError ? 8 : 0, transition: "padding-left .15s" }}>
    {orbOrDot}
    <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text)",
                   overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    {isError && <button onClick={onDismissError} title="关闭">✕</button>}
  </div>
  <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>{props.right}</div>
</div>
```

- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `git commit -m "feat: ComposerHeader 常驻顶栏（播报槽渲染 + 右侧插槽）"`

---

### Task 3: ChatWindow 接线——删胶囊、删桌面 NoticeShelf、喂数据

**Files:**
- Modify: `components/ChatWindow.tsx`（~1046-1057 两处 pill、~758-805 通知层、~660-676 ChatInput props）
- Modify: `app/globals.css`（删除 1949-1972 `.chat-status-pill` 整块）
- Test: `components/ChatWindow.notices.test.mjs` 相应调整

**Interfaces:**
- Consumes: Task 1/2 产物（在 Task 4 于 ChatInput 内消费；本任务先把数据送到 ChatInput props）
- Produces: ChatInput 新 props：

```ts
agentPhase?: AgentPhase;                 // 原 ChatWindow 内部使用，现下发
broadcastNotices?: NoticeItem[] | null;  // 仅桌面传入；移动端传 null（保持顶部居中 NoticeShelf）
quota?: QuotaInfo | null;                // 本期恒 undefined/null
```

- [ ] **Step 1**: 删除消息流内两处 `chat-status-pill` 渲染块（`agentRunning && !hasStreamingContent && agentPhase` 与 `bashRunning && !pendingBash` 两处）。等待/命令状态此后由顶栏播报槽承载（Task 4 生效，本任务先删 UI）
- [ ] **Step 2**: 桌面分支（`position:fixed; right:51; bottom:118` 的 NoticeShelf 容器）整体删除；移动端分支原样保留。`NoticeShelf` 组件本体保留（移动端仍在用）
- [ ] **Step 3**: 向 ChatInput 传新 props：桌面 `broadcastNotices={notices}`、`agentPhase={agentPhase}`、`quota={undefined}`；并复用文件内已有的 `phaseLabel()` 与 `orbModeForPhase()` 组装 `{text, orb}`（这两个 helper 若为模块私有，export 之）。`isDark` 一并下发（ChatInput 内已有 useTheme 则跳过）
- [ ] **Step 4**: 删除 `globals.css` 中 `.chat-status-pill` 及其 reduced-motion 块（1949-1972 行）
- [ ] **Step 5**: 更新/跑受影响测试：`node --experimental-strip-types --test components/ChatWindow.notices.test.mjs components/ExtensionStatusBar.test.mjs`；再全量 `npm test` 修复红测
- [ ] **Step 6**: `node_modules/.bin/tsc --noEmit` 通过
- [ ] **Step 7: Commit** `git commit -m "refactor: 消息流胶囊与桌面 NoticeShelf 下线，状态数据下发 ChatInput"`

---

### Task 4: ChatInput 挂载 ComposerHeader，Retry/Compact 横幅收编

**Files:**
- Modify: `components/ChatInput.tsx`（composer 面板顶部 ~1693 起、Retry 横幅 ~1536、Compact 横幅 ~1582）

**Interfaces:**
- Consumes: Task 1 `useBroadcast`、Task 2 `ComposerHeader`、Task 3 新 props
- Produces: 面板内部第一行固定为 `<ComposerHeader>`；`compactResult` 到达时转为一条合成公告

- [ ] **Step 1**: ChatInput 内调用 hook：

```tsx
const phaseInfo = useMemo(
  () => agentPhase ? { text: phaseLabel(agentPhase, t), orb: orbModeForPhase(agentPhase) } : null,
  [agentPhase],
);
const retryText = retryInfo ? `${t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}${retryInfo.errorMessage ? `— ${retryInfo.errorMessage}` : ""}` : null;
const { broadcast, dismissError } = useBroadcast({ notices: broadcastNotices ?? [], phase: phaseInfo, retryText, quota: quota ?? null });
```

（`phaseLabel`/`orbModeForPhase` 从 ChatWindow export 导入，避免双份文案源。）

- [ ] **Step 2**: compact 结果转合成公告：现有 `compactResult` state（6000ms 自动清空）不变，渲染处改为注入 notices 流——最简做法：`useMemo` 把它拼进喂给 useBroadcast 的数组尾部：

```tsx
const effectiveNotices = useMemo(() => {
  const arr = broadcastNotices ?? [];
  return compactResultText ? [...arr, { id: `compact:${compactResult?.tokensBefore ?? 0}`, message: compactResultText, type: "info" as const }] : arr;
}, [broadcastNotices, compactResultText, compactResult]);
```

- [ ] **Step 3**: 面板顶部挂载：`<ComposerHeader broadcast={broadcast} onDismissError={dismissError} isDark={isDark} right={null} />`（右侧插槽 Task 6/7 回填 chip）
- [ ] **Step 4**: 删除 Retry 横幅 JSX 块与 Compact 结果横幅 JSX 块（数据链路已收编）
- [ ] **Step 5**: `tsc --noEmit` + `npm test`（修 `ChatInput.test.mjs` 中断言旧横幅的用例）+ Commit `git commit -m "refactor: composer 顶栏接入播报槽，Retry/Compact 横幅收编"`

---

### Task 5: 输入行右下角锚定按钮

**Files:**
- Modify: `components/ChatInput.tsx`（主输入行容器 ~2072-2089、textarea ~2092-2145、发送/Steer/FollowUp 按钮 ~2146-2245）

**Interfaces:**
- Consumes: 无新接口，纯布局改造
- Produces: 输入行容器 `position:relative`，按钮组绝对定位右下角

- [ ] **Step 1**: 输入行容器改为 `position:"relative"`；textarea 增加 `paddingRight: 110`（恒定容纳最宽按钮态）；textarea 其余样式不动
- [ ] **Step 2**: 发送按钮与其流式态 Steer/FollowUp 包一层：

```tsx
<div style={{ position: "absolute", right: 8, bottom: 8,
              display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
  {/* 原有三元分支：isStreaming ? steer/followup : send —— 内容原样搬入 */}
</div>
```

按钮自身样式（纯文字形态）不动；删除其原有的 `alignSelf` 与 flex 子项语义
- [ ] **Step 3**: 手动走查点（记入 PR 描述）：单行时按钮位于行尾；多行时文字不流入按钮下方；IME 组合输入、Enter 发送、Shift+Enter 换行不受影响；slash/@/history 三个上弹菜单定位不受影响（它们锚定的是容器 bottom:100%，容器未变）
- [ ] **Step 4**: `tsc --noEmit` + `npm test` + Commit `git commit -m "feat: 输入按钮锚定右下角，textarea 恒定右留白"`

---

### Task 6: 发件箱区（排队消息收编进面板）

**Files:**
- Modify: `components/ChatInput.tsx`（外部排队块 ~1499-1567 → 移入面板内顶栏之下；新增 `outboxOpen` state）

**Interfaces:**
- Consumes: `queuedMessages`、`onRecallQueue`（现有 props 不变）、Task 2 的右侧插槽
- Produces: 面板内发件箱区 + 顶栏右侧 `⏳ n` chip（chip 点击展开）

- [ ] **Step 1**: 新增 `const [outboxOpen, setOutboxOpen] = useState(false)`；删除面板外的排队块整体
- [ ] **Step 2**: 面板内、图片预览之上插入发件箱区：

```tsx
{queueCount > 0 && (
  <div style={{ margin: "0 4px 4px", borderRadius: "var(--bubble-inner-radius)",
                background: "var(--bubble-tool-bg)", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px" }}>
      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)", flex: 1 }}>
        {t("chat.queued", { count: queueCount })}
      </span>
      {onRecallQueue && /* 原召回按钮原样迁入 */}
      <button onClick={() => setOutboxOpen(o => !o)} aria-expanded={outboxOpen}>{outboxOpen ? "▴" : "▾"}</button>
    </div>
    {outboxOpen && (<>
      {queuedMessages?.steering.map((text, i) => <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />)}
      {queuedMessages?.followUp.map((text, i) => <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />)}
    </>)}
  </div>
)}
```

`QueuedMessageRow` 样式微调为透明底（父级已带 `--bubble-tool-bg`）
- [ ] **Step 3**: 顶栏右侧插槽回填 chip（Task 4 的 `right={null}` 处）：

```tsx
right={queueCount > 0 ? (
  <button onClick={() => setOutboxOpen(true)} title={t("chat.queued", { count: queueCount })}
          style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--accent)",
                   background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}>
    ⏳ {queueCount}
  </button>
) : null}
```

- [ ] **Step 4**: `tsc --noEmit` + `npm test`（`ChatInput.test.mjs` 排队相关用例迁移断言）+ Commit `git commit -m "feat: 排队消息收编为面板内发件箱区，顶栏计数 chip"`

---

### Task 7: DraftStash → TODO 触发器浮层化

**Files:**
- Modify: `components/DraftStash.tsx`（展示层重构，逻辑/DOM 协议/快捷键不动）
- Modify: `components/DraftStash.module.css`（panel/toggle 类改造为 chip+popover）
- Modify: `components/ChatInput.tsx`（`<DraftStash />` 从面板顶部移入顶栏右侧插槽）
- Test: `components/DraftStash.test.mjs` 同步文案断言

**Interfaces:**
- Consumes: 自身既有 drafts 状态与 DOM 协议（不改）
- Produces: 外层结构变为 `position:relative` 的 chip；展开列表为向下弹出浮层

- [ ] **Step 1**: 展示层改造：
  - 收起态：chip 按钮 `☐ TODO {n}`（无草稿整个组件返回 null——现状即如此）
  - 展开态：`position:absolute; top:calc(100% + 6px); right:0; width:300px; max-height:280px; overflow:auto; z-index:500`，底色 `var(--bg)`、边框 `var(--border)`、圆角 8（与 model 下拉同款规格）
  - activeBar / list / row 结构与交互全部保留
  - 文案：“N 条草稿”→“TODO {N}”、aria-label 同步去“草稿”字样
- [ ] **Step 2**: ChatInput 中 `<DraftStash />` 移到 `<ComposerHeader right={...}>` 插槽内（与 ⏳ chip 并列，顺序：⏳ 在左 TODO 在右）
- [ ] **Step 3**: 点击外部关闭浮层：沿用 ChatInput 现有 dropdown outside-click 模式（document mousedown 监听，ref 判断）
- [ ] **Step 4**: Ctrl+S / Ctrl+Delete 快捷键回归验证（capture 阶段拦截逻辑未动，确认 window 级监听不受 DOM 迁移影响）
- [ ] **Step 5**: `tsc --noEmit` + `npm test` + Commit `git commit -m "feat: 草稿更名为 TODO，触发器入顶栏、列表浮层化"`

---

### Task 8: 端到端走查与收尾

**Files:**
- Modify: 仅修走查发现的缺陷；无新增文件

- [ ] **Step 1**: `npm test` 全量 + `npm run lint` + `tsc --noEmit` 三绿
- [ ] **Step 2**: 启动 dev 服务（tmux）：`tmux new-session -d -s piweb 'cd ~/project/pi-web-sky && npm run dev'`，浏览器打开 `http://127.0.0.1:30143`
- [ ] **Step 3**: 用 playwright MCP 走查清单（浅色 + 深色各一遍）：
  1. 空闲：顶栏存在、高度稳定、无 orb；右下角无任何浮动卡
  2. 发送消息：等待模型期间消息流高度零变化，顶栏出现 orb+文本
  3. 工具执行期：顶栏切 working；结束后回到 idle
  4. 多行输入 10+ 行：文字不流入按钮下方；单行时按钮在行尾
  5. 流式中输入并发送引导：按钮切换 Steer/Follow-up，排队后发件箱摘要行出现、可展开可召回
  6. TODO：Ctrl+S 存草稿 → 顶栏出现 chip → 点开浮层 → 回填 → 关联编辑
  7. 触发一个 error 通知（如断开模型）：顶栏红线常驻 + ✕ 可关
  8. RTK/hook 高频通知：原地替换不堆叠、不遮挡输入框
- [ ] **Step 4**: 发现的问题小步修复提交；最终 `git log --oneline` 汇总于完成报告

---

## Self-Review 记录

- Spec §1↔Task1/2/4；§2↔Task4/6/7；§3↔Task5；§4↔Task6；§5↔Task7；§6↔Global Constraints+Task3(css删除)；§7↔Task1 类型+Task2 渲染；§8↔Task3 移动端保留；§9↔各任务 Files。无缺口。
- 与 spec 的一处刻意简化：公告"最多保留3条+‘+n'"不复刻——`useAgentSession` 既有 pending/visible 队列已提供排队与过期，直接复用（ponytail）。
- 类型一致性：`QuotaInfo`/`Broadcast` 定义仅在 `hooks/useBroadcast.ts`，下游 import；`phaseLabel`/`orbModeForPhase` 由 ChatWindow export 单一来源。
