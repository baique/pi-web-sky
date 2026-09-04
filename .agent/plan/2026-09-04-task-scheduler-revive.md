# 任务调度器完善：恢复状态机闭环 + 会话状态镜像

> 日期：2026-09-04　分支：feat/task-scheduler-revive（worktree 隔离开发）　前置：dev/0903

## 0. 背景

调度器"半残"：派发段刚恢复（9af4760），但后半段状态机（审核/回复/阻塞巡检）全部停用，
任务走不完生命周期（现 11 张 waiting_reply、2 张 failed 卡永久卡死）。
停用直接原因：审核/巡检全量解析会话文件（实测单文件 700KB+），同步阻塞事件循环。

## 1. 目标与非目标

### 目标
1. 恢复完整状态机闭环：`not_started → running → review → done/failed/waiting_reply →(回复)→ running`
2. **所有新增逻辑绝不阻塞事件循环**（最高优先级）
3. 任务卡状态与会话真实状态**双向可同步**，兼容"用户直接打开执行会话交流"

### 非目标
- ❌ 不做回答 UI / QuestionCenter —— 只让 waiting_reply 被正确识别展示
- ❌ 不做并发上限配置（保持硬编码 1）
- ❌ 不做 worktree 派发支持、不做失败原因 UI
- ❌ 不做阻塞处置的"仅提示"模式（用户已拍板：严格判定后自动处置）

## 2. 用户拍板（2026-09-04）

1. **状态跟聊天走**：卡状态以关联会话真实状态为镜像源，不区分驱动者。
2. **阻塞处置必须 AI 判定且严格**：硬条件过滤（最后一条必须是命令类工具调用、且已执行超过
   阈值）+ 传最后几条消息给 AI 判定是否真挂起；确认挂起才 abort + 重发引导。宁可不杀，不误杀长任务。
3. **开发隔离**：新 worktree `feat/task-scheduler-revive`，不动主目录。
4. **测试成本**：测试派发任务卡时，卡需求一律写「回复ok即可」，不让 AI 在测试里干重活。

## 3. 总体设计：tick = 一镜像 + 五段

每 10s 一轮 tick，顺序执行（前段结果影响后段）：

| 序 | 段 | 职责 | 状态 |
|---|---|---|---|
| 0 | **会话状态镜像**（新增） | 卡状态 ← 会话真实状态 | 🆕 |
| 1 | 自愈 | review 卡但会话在跑 → running | ✅ 已恢复 |
| 2 | 结束巡检 | running 卡会话已静默结束 → review | ✅ 已恢复 |
| 3 | 审核 | review → done/failed/waiting_reply | 🔧 恢复 |
| 4 | 回复队列 | waiting_reply + answered → 续会话 → running | 🔧 恢复 |
| 5 | 阻塞巡检 | running 卡挂起判定 → 处置 | 🔧 恢复 |

镜像排最前：会话在跑时绝不去审核（防误判运行中任务）。

## 4. 关键设计 1：会话尾部反读（性能核心）

**问题**：`readSessionAuditSnapshot` 用 `SessionManager.open().getEntries()` 全量解析 jsonl
（单文件可达 700KB+/上千行），审核/巡检每次同步全读 → 事件循环卡死。

**改法**：新增尾部反读快照，替代全量解析：
- 从文件末尾 seek 读最后 ~64KB（覆盖最近几十条消息）
- 只按行反解析尾部行，绝不读整个文件
- 仍产出：`failure`（最后消息失败迹象）、`recentText`（最后几条消息文本）、`lastActivityMs`
- 性能：64KB 读 + 几十行 JSON.parse ≈ 微秒~毫秒级

审核 / 阻塞巡检 / 状态镜像三处统一走尾部快照，全量解析路径消失。

## 5. 关键设计 2：会话状态镜像（状态同步）

对每张有 `sessionId` 的卡（tick 第 0 段）：

| 会话真实状态 | 卡状态 | 说明 |
|---|---|---|
| 在跑（流式/工具/命令/压缩） | → `running` | 覆盖 review/waiting_reply/not_started |
| 挂起等输入（waiting_input） | → `waiting_reply` | AI 在等用户 |
| 已结束且静默超期 | 保持现状 | 交给审核/巡检 |

**不区分"消息是调度器发的还是用户发的"**——同一会话承载两种用途，镜像只认会话真实状态。

解决 4 场景：用户直接发消息→回 running；AI 提问挂起→转 waiting_reply；手动 abort→转 review；
闲聊几句→idle 保持/流转 review，AI 审核基于任务描述判定。

## 6. 关键设计 3：三段恢复

### 6.1 审核（review → done/failed/waiting_reply）
- 程序检测先行：尾部快照 `failure=true` → 直接 failed + 重试计次，不烧模型
- 无会话/无内容 → done（空执行）
- 其余走 AI 判定（`--no-session` 临时会话，不落盘），冷却 `AUDIT_COOLDOWN_MS=5min`
- 判定 `other` → 保持 review，等下一轮

### 6.2 回复队列（waiting_reply → running）
- 用户回答走已有 API（`POST /task-card-questions/[id]/answer`），不新建 UI
- 拾取 `answered` → 发回复 → 卡回 running，走统一并发闸门

### 6.3 阻塞巡检（running 卡挂起判定）——严格版
- **硬条件**：最后一条必须是命令类工具调用（toolResult 且带 exitCode==0 的 command 场景，
  或最后事件是命令启动），且该命令已执行超过 `BLOCK_IDLE_MS`
- **AI 判定**：传任务描述 + 最后几条消息 → 判定阻塞类型（sync_server/infinite_loop/
  rate_limit/error/asking/normal）
- **处置**：sync_server / infinite_loop → abort + tmux 引导重发（保持 running 观察）；
  rate_limit → 退避不杀；asking → 转 waiting_reply；error → 转 review；normal → 继续观察
- 每卡冷却 `BLOCK_COOLDOWN_MS=10min`
- **严格原则**：硬条件不满足直接跳过不烧模型；AI 判定犹豫 → 按 normal 处理

## 7. 实施步骤

1. **P0**：worktree 内重启 dev server → 验证派发恢复（测试卡需求「回复ok即可」）
2. **性能底座**：写尾部反读快照函数 → 替换 `readSessionAuditSnapshot` 全部调用点
3. **镜像段**：tick 新增第 0 段
4. **恢复三段**：审核 → 回复队列 → 阻塞巡检（全部跑在尾部快照上）
5. **验证**：`npm test` / `tsc --noEmit` / `npm run lint` + 手动造卡走完整生命周期
6. **收尾**：更新 docs/reference/task-cards.md、spec 状态、合并回 dev/0903

## 8. 验收标准

- 新建 todo 任务卡（需求「回复ok即可」）→ 自动派发 → running → review → AI 审核 → done
- 卡状态随会话真实状态实时镜像（用户直接交流场景）
- 大会话文件（700KB+）下审核/巡检不卡事件循环（计时验证）
- 全部测试通过、typecheck/lint 干净
