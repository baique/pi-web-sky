# 会话列表管理重构 · 设计定稿

日期：2026-09-06
分支：dev/0905

## 1. 背景与目标

左栏"聊天"会话列表当前存在结构性问题：

- 列表接口每次**全量扫所有项目的会话文件**（按目录扫、读头尾），多项目累积后刷新变慢；
- 列表**没有按当前项目隔离**——"聊天"区展示的是所有项目混排的会话，单项目语义未立起来；
- 6 个前端消费方各自拉全量 `/api/sessions`（侧栏分页+全量、AppShell 恢复、工作台展开卡、看板 10s 轮询、未读清理），数据副本分散、各刷各的；
- 标题依赖"尾读文件找 session_info"，大会话改名记录被挤出尾窗时会读到旧标题。

本次目标（限定范围：**只治列表线**，聊天窗口消息加载不碰）：

> 左栏"聊天"列表 = **当前项目**的会话；数据来自 **stat 文件 + session_meta 结合**；应用内改动（改名/归属/置顶/新建/删除）实时写库；标题不靠每次挖文件、不受文件大小影响。列表稳定后，未来再考虑让 session_meta 升格为唯一事实源。

**不纳入本次范围**：看板跨项目聚合、聊天窗口消息加载、未读红点机制、任务区列表（`/api/tasks` 已独立下发）。

## 2. 核心决策记录

| 代号 | 决策 | 理由 |
|---|---|---|
| A | 聊天区列表 = **只显示当前项目**（selectedCwd 所在工作区）的会话 | 会话文件磁盘上按项目分目录存储（`sessions/<encoded-cwd>/`），天然可只扫单目录 |
| 分页 | **去掉分页、不做兼容**；未来量级到了再考虑虚拟滚动 | 单项目会话量几十~一两百，一次全量毫秒级；分页是全量扫多项目时代引入的补丁，前提消失 |
| A1 | 在现有 `session_meta` 上**加列**，不新建表 | 会话级旁路状态应收敛为一个聚合根 |
| M1 | 会话**首次被本应用操作（新建/改名/归属/置顶）建行**，之后常驻；归属判据一律看 `task_id` 列，**不看行有无** | 看板补卡 reconcile 依赖"task_id=某任务"判定归属，普通聊天会话行（task_id=NULL）不得混入 |
| — | 沿用表名 `session_meta` | 避免大范围改名风险；代码注释说明职责扩展 |
| — | 列表读取 = **文件与 meta 结合使用**，不是单一事实源 | 文件 stat 永远是"存在性"事实源（pi 引擎/外部可能随时建文件）；meta 是"我们认识并操作过的会话"的标题持久层 |
| 改名 | 改名 = 写 jsonl + **同请求内 UPDATE session_meta.title**（原子，不依赖乐观更新兜正确性） | 标题新鲜度实时保证；乐观更新退居视觉反馈层 |
| 消息增长 | **不更新 meta**（不影响标题）；不做外部改动兜底扫描 | 消息增长不影响名称；外部改动管不了，做自己能做的 |
| last_reply | **不落库**，列表按需**尾读文件** | 库不背"内容"债；尾读（scanTail）对非关键展示足够 |
| 无 meta 行 | **读取时不主动补行**（列表 stat 见文件无 meta → 读头部首条消息降级展示）；但改名/置顶/归属等本应用操作会建行（M1：首次被本应用操作即建行，含老会话首改） | 列表读取不做扫描兜底建行；写入入口天然建行，两者不冲突 |
| 排序 | 服务端排好：**运行中 → 置顶 → mtime 降序**；前端只对运行态做本地微调（浮顶） | E1；运行态是易变信号，本地重排不重拉列表（G1） |
| 恢复上次会话 | AppShell 用记忆的 id **点查** `GET /api/sessions/[id]`（404 则忘记），脱离列表依赖 | D1 |

## 3. Schema（sqlite，SCHEMA_VERSION 10 → 11）

现有 `session_meta(session_id TEXT PRIMARY KEY, task_id TEXT, updated INTEGER, pinned INTEGER)` 新增列：

```sql
ALTER TABLE session_meta ADD COLUMN path         TEXT;   -- jsonl 完整路径
ALTER TABLE session_meta ADD COLUMN cwd          TEXT;   -- 会话所属项目目录
ALTER TABLE session_meta ADD COLUMN project_key  TEXT;   -- 归一化项目标识
ALTER TABLE session_meta ADD COLUMN title        TEXT;   -- 最新标题（自定义名；无则 NULL，展示读首条消息）
ALTER TABLE session_meta ADD COLUMN first_message TEXT;  -- 首条用户消息（建行时写一次）
ALTER TABLE session_meta ADD COLUMN parent_id    TEXT;   -- fork 父会话（根为 NULL）
ALTER TABLE session_meta ADD COLUMN created      INTEGER; -- 创建时间(ms)

CREATE INDEX idx_meta_project ON session_meta(project_key);
```

**说明**：
- `title` 仅改名时写；无自定义名会话 title=NULL，展示层回退读头部首条消息。
- `last_reply` 不入库（见决策表）。
- **不新增 modified 列**：排序的 mtime 来自 stat 文件，无需入库。现有 `updated` 列语义不变（任务归属/置顶时间，任务区排序用）。
- `task_id` / `pinned` 语义不变，归属判据只看 `task_id`（看板 reconcile 兼容）。

## 4. 写入点（事件驱动，无兜底扫描）

| 时机 | 入口 | 动作 |
|---|---|---|
| 新会话首条消息落盘 | `lib/rpc-manager.ts` `persistNewSessionFile` | INSERT 行：path/cwd/project_key/first_message/title(=首条)/created/updated |
| 改名 | `app/api/sessions/[id]/route.ts` PATCH name 分支 | 写 jsonl（append session_info）后**同请求内** UPDATE title（原子）。若该会话无 meta 行（老会话首改），INSERT title 行 |
| 置顶 / 取消 | PATCH pinned 分支 | UPDATE pinned（已有 `setSessionPinned`，确认同一行） |
| 归属任务 / 取消 | `lib/task-store.ts` | UPDATE task_id + updated（已有，确认同一行） |
| 删除会话 | `DELETE /api/sessions/[id]` | DELETE 行（已有） |

> 改名 INSERT（老会话首改无行）时：path 从 `resolveSessionPath(id)` 拿；cwd/project_key 从该文件 header 首行读（`readSessionHeader`）；first_message/created 可留 NULL（列表展示时头部降级兜底），title 写本次改的名。

外部进程/CLI 改动 jsonl：**不管**（无兜底扫描，不做主动补行）。

## 5. 读取（列表 = stat + meta 结合）

服务端 `GET /api/sessions?project=<key>` 流程：

1. **stat 扫描**当前项目目录（只 readdir+stat，不读内容）→ id + mtime + 存在性
2. 用这些 id **批量查 session_meta** → title/pinned/task_id/parent_id/created（排序 mtime 用 stat，不入库）
   - 有 meta 行 → 用 meta.title
   - 无 meta 行 → 读该文件头部首条消息降级展示（不建行）
3. **last_reply** → 尾读文件（复用 `session-scanner.scanTail`）
4. **排序**：运行中（registry）→ 置顶 → mtime 降序，服务端一次排好
5. 返回当前项目完整列表（**无分页**）

## 6. 接口与调用矩阵（新）

| 调用方 · 功能 | 接口 | 调用时机 | 调用结果 |
|---|---|---|---|
| 侧栏 · 聊天会话列表 | `GET /api/sessions?project=<key>` | 首屏；切项目；刷新事件统一走 refresh() | 填充**唯一** sessions state，一次整体替换 |
| 侧栏 · 未读红点清理 | 不请求，消费 state | 列表刷新后 | 过滤已删会话红点 |
| AppShell · hydrate 转正会话 | 不请求，消费 Sidebar 上抛 state | Sidebar 列表就绪 | 补全选中会话 projectKey 等字段 |
| AppShell · 恢复上次打开会话 | `GET /api/sessions/[id]`（点查） | 切换工作区后 | id 记忆点查，404 则清记忆；200 则打开 |
| 主聊天区 · 消息加载 | `GET /api/sessions/[id]` | 点开/切换会话 | 消息内容（消息线，本次不动） |
| 看板 · 会话卡片摘要 | `GET /api/sessions`（无参全量） | 进看板/每 10s/回前台 | 卡片标题等刷新（**记账，本次不改**） |
| 看板 · 工作台展开会话卡 | `GET /api/sessions`（无参全量） | 展开卡时一次 | 取元数据（**记账，本次不改**） |
| 侧栏/看板 · 运行态 | `GET /api/agent/running` | 2.5s 轮询 | running id，本地浮顶（G1） |
| 行内 · 改名 | `PATCH /api/sessions/[id]` | 改名提交 | 写 jsonl + 同请求写 meta.title；触发 refresh |
| 行内 · 置顶 | `PATCH /api/sessions/[id]` | 点置顶 | 写 meta.pinned；触发 refresh |
| 行内/画布 · 删除 | `DELETE /api/sessions/[id]` | 删会话/删卡 | 删 jsonl + 删 meta 行；触发 refresh |

## 7. 前端收敛（Sidebar 单一事实）

1. **四份 state → 单一 `sessions`**：`chatPinned`/`chatSessions`/`chatRuntime`/`allSessions` 合并成一份（含 pinned/running 标记），无分页接口一次填充。
2. **拆掉分页机制**：`loadMoreChatSessions`、聊天区滚动哨兵 observer、`chatOffset/chatTotal`、`mergeChatSessions` 增量合并全部删除。
3. **刷新入口统一**：改名/删除/新建/置顶/运行轮询发现变化 → 同一 `refresh()`（一次拉取 + 整体替换），不再分散 loadChatPage/乐观改五份副本。
4. **运行态本地浮顶**：2.5s `/api/agent/running` 轮询保留，本地把 running 会话浮到最前（不重拉列表）。
5. **改名**：`handleSessionRenamed` 不再维护五份副本做正确性兜底；正确性靠"改名写库 + 刷新"，本地乐观仅视觉反馈。
6. **AppShell hydrate**：消费 Sidebar 单一 state（`onSessionsLoaded` 通道补全），不自拉全量。
7. **恢复上次会话**：改点查 `GET /api/sessions/[id]`（见矩阵）。

## 8. 不做（记账，本次不实现）

- 看板卡片 10s 轮询全量：本次不动；列表线稳定后改"按 id 批量点查摘要"。
- 工作台展开卡找 session：同上，改点查。
- 外部进程改动 jsonl：不管。
- stat 见文件无 meta：不补行，头部降级。
- meta 升格唯一事实源：等数据兼容期过后再切。
- 虚拟滚动：未来量级到了再说。

## 9. 清理与验证

- 拆分页暴露的死代码（如 `lib/chat-lazy-load.ts` 死导出）。
- 适配测试：`session-reader.pagination.test.mjs`、`session-scanner.test.mjs` 及 sidebar 相关按新无分页契约改。
- 回归清单：首屏加载 / 切项目换列表 / 改名即生效 / 置顶置底 / 运行浮顶 / 删除消失 / 老会话（无 meta 行）仍显示。

## 10. 工作区遗留补丁说明

`components/SessionSidebar.tsx` 存在一份未提交的本地改动（聊天区滚动分页重入锁补丁，针对"加载不出下一页"颤抖），与本次重构拆分的分页机制是同一段代码，将在实现阶段随分页一并拆除。实现开始前保持原样不动。
