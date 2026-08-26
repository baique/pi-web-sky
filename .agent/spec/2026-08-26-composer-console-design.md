# Composer 控制台化重设计（状态播报 / 输入行 / 发件箱 / TODO / 额度预留）

日期：2026-08-26
状态：待用户审阅
范围：桌面端先行，移动端本期不动（§8）

## 背景与痛点

1. "正在等待模型/执行命令"胶囊插在消息流内部，出现/消失导致消息流高度跳变；玻璃浓度低于消息气泡，浅色主题下文字看不清。
2. Composer 内按钮在多行输入时占据整列高度，未锚定右下角。
3. DraftStash"草稿"命名不当（实为 TODO 暂存），且顶栏空间未被利用。
4. 右下角 NoticeShelf 堆叠通知遮挡输入框，RTK 类 hook 高频弹出时体验差。
5. 排队消息面板是 composer 外的散装盒子：无玻璃质感、不与输入框联动。
6. Retry / Compact 结果横幅风格各异，散落在 composer 上方。
7. 缺少额度展示位（余额型 / 用量窗口型，因提供商而异）。

## 设计总纲

心智模型：**composer 是控制台，顶栏是它的状态灯**。全界面只有一个瞬态播报出口；
消息流尾部永远干净；composer 外部无任何浮动卡片或散装横幅。

## §1 播报槽状态机（常驻顶栏左侧）

单一槽位，四级优先级，高级别抢占、低级别让位：

| 级别 | 内容 | 行为 |
|---|---|---|
| P0 error | 错误公告 | 常驻直到点击 ✕ 关闭；顶栏左边线变红 2px；orb 停止动画 |
| P1 warn/info 公告 | RTK hook、compact 结果等 | 插播 4s，原地替换（crossfade ~150ms），到期回落到下一级 |
| P2 运行状态 | 等待模型 / 执行命令 / 重试中 n/m | orb 动画（breathing / working）+ 文本；运行结束消失 |
| P3 空闲信息 | 额度展示（§7） | 无上述内容时显示，静态 |

规则：

- 连续多条公告排队依次各播 4s；队列上限保留最近 3 条，溢出丢弃并以"+n"计数。
- 公告文本单行截断，点击弹小 popover 看全文。
- Retry 从独立横幅降级为 P2 状态文本。
- Compact 结果作为 P1 info 公告插播。
- orb 复用 thinking-orbs（size=20，显式传 theme，浅色加 brightness/contrast filter），即未来"小机器人 tip"的演进载体（本期不做 tip）。

数据源合并：`useBroadcast(agentPhase, notices, retryInfo)` 返回当前槽位内容，
组件只渲染槽位，不感知来源。notices/retry 不再自行渲染 UI。

## §2 Composer 总布局（自上而下）

```
┌─ 玻璃面板 ────────────────────────────────────┐
│ ① 顶栏（常驻, h≈34px）                        │
│    左: orb+播报文本+额度   右: [⏳n] [☐TODO n] │
│ ② 发件箱区（仅有队列时: 摘要行, 可展开明细）    │
│ ③ 图片预览（不变）                             │
│ ④ 输入行: textarea(恒定右留白) + 右下角文字钮   │
│ ⑤ 工具栏（高度、内容均不变）                    │
└───────────────────────────────────────────────┘
```

- ⏳ 排队计数 chip 在顶栏右侧，点击展开发件箱区。
- 面板外散装横幅清零：Retry → P2 状态；Compact 结果 → P1 公告；排队面板 → §4 发件箱。
- 顶栏不引入任何新样式：底色/边框/文字全部复用输入框区域已有 token
  （面板同款 --frame-glass 玻璃体系与 --bubble-* 层级，近实底选 --bubble-code-bg 一档）；
  删除旧 `.chat-status-pill` 样式与消息流内两处胶囊渲染（浅色对比度问题随之根治）。

## §3 输入行与右下角按钮

- **保持现有纯文字按钮形态**（不用圆形图标钮），仅位置改为绝对定位锚定输入区右下角。
- textarea **恒定右 padding ≈110px**（容纳"发送/引导/Steer/Follow-up"中最宽态），多行时文字永不流入按钮下方；单行时按钮自然处于行尾。
- 流式时同一位置切换 Steer / Follow-up 双钮（现有文案与禁用逻辑不变）；非流式显示发送。
- 发送→引导的切换语义不变，仅位置与锚定方式变化。

## §4 发件箱区（排队消息收编）

- 移入玻璃面板内，紧贴输入行上方。
- 收起态一行：`⏳ 排队中 n 条 · [召回] ▾`；展开态列出 steer/follow-up 明细
  （复用 QueuedMessageRow 内容），底色 --bubble-tool-bg，圆角 --bubble-inner-radius。
- 召回按钮行为不变（onRecallQueue）。
- 出现/消失仅由用户主动操作引发，且收起态只有一行 → 跳变可接受。

## §5 TODO（原草稿）

- DraftStash 更名 TODO，触发器移到顶栏右侧 `☐ TODO (n)`，无草稿隐藏。
- 列表从顶栏向下弹出浮层（absolute 定位，不推挤输入区，展开零跳变）。
- Ctrl+S / Ctrl+Delete 快捷键与关联逻辑不变；i18n 文案"草稿"全部改"TODO"。

## §6 浅色主题修复

根因：旧胶囊玻璃浓度低于气泡。原则：**不新增任何样式**，全部采用当前项目输入框
部分已有的 token 与玻璃层级（见 §2），近实底选 `--bubble-code-bg` 档位，
明暗主题自动跟随既有体系，不再出现“深色正常浅色看不清”。

## §7 额度预留位（本期只留座，不实现数据）

UI 契约：

```ts
type QuotaInfo =
  | { kind: "balance"; text: string }   // 余额型
  | { kind: "usage"; items: { label: "5h" | "周" | "月"; pct: number; text: string }[] }; // 用量窗口型
```

- 渲染于 P3 空闲态：余额 = 短 mono 文本；用量 = `5h ▓▓░░ 2h10m` 微缩条（同时最多 1 条）。
- 无数据显示为空；点击详情 popover 留作后续演进。
- 数据适配器（各提供商查询方式不同）后续单独设计。

## §8 移动端

桌面端先行。移动端保持现有顶部居中 NoticeShelf 与现有 composer 结构不变。

## §9 实现落点

| 变更 | 文件 |
|---|---|
| 新增 ComposerHeader（orb+播报+额度+chip 区） | `components/ComposerHeader.tsx`（新建） |
| 播报状态机（合并 phase/notices/retry） | `hooks/useBroadcast.ts`（新建） |
| 删除消息流胶囊 ×2、NoticeShelf 桌面端删除、notices/retry 改喂数据 | `components/ChatWindow.tsx` |
| 发件箱区、右下角锚定按钮、textarea padding | `components/ChatInput.tsx` |
| DraftStash → TODO + 浮层化 | `components/DraftStash.tsx` |
| token / i18n / 测试同步（不新增样式 token） | i18n 资源、相关 `*.test.mjs` |

## 验证策略

- 每阶段：`node_modules/.bin/tsc --noEmit` + 相关 `*.test.mjs`。
- 最终：`npm run dev` + playwright e2e 走查——浅色主题对比度、播报槽抢占/回落、
  多行输入按钮不遮字、发件箱展开收起、TODO 浮层、流式 Steer/Follow-up 切换。
