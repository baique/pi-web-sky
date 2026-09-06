# 会话列表管理重构 · 设计定稿（v2：后台扫描 + 完整索引）

日期：2026-09-06
分支：dev/0905

## 1. 背景与目标

左栏"聊天"会话列表存在结构性问题：

- 列表接口每次**全量扫所有项目会话文件**（读头尾），多项目累积后刷新变慢；
- 列表**未按项目隔离**，"聊天"区展示所有项目混排会话；
- 6 个前端消费方各自拉全量 `/api/sessions`，副本分散、各刷各的；
- 标题靠"尾读文件找 session_info"，大会话改名记录被挤出尾窗读到旧标题；
- 单项目会话数（几十~一两百）本不必分页，分页是"全量扫多项目"的补丁。

**核心转向（v2）**：不再纠结"读取时扫哪些目录"。由 pi-web **承担会话发现职责**——服务端**启动时 + 定期全量扫描**磁盘会话目录，把所有发现的会话**全量写入 session_meta**，使 session_meta 成为**完整会话索引**。列表读取退化为**纯单表查询**。

> 目标：左栏"聊天"列表 = **当前项目**的会话；session_meta 是完整索引（启动+定期扫描维护）；标题改名实时写库；列表读取不碰文件系统、不受文件大小影响。

**范围**：只治列表线。聊天窗口消息加载、看板跨项目聚合、未读红点、任务区列表不纳入。

## 2. 核心决策记录

| 代号 | 决策 | 理由 |
|---|---|---|
| A | 聊天区列表 = **当前项目**（projectKey）的会话 | projectKey 把主仓库 + worktree 会话归到同一项目；切换 worktree 会话不丢 |
| 分页 | **去掉分页、不做兼容**；未来量级到了再考虑虚拟滚动 | 单项目量级一次全量毫秒级 |
| v2-M1 | **session_meta 升格为完整会话索引**：启动 + 定期全量扫描磁盘，所有会话（含老/外部新建）全量建行 | 会话发现从"请求路径"挪到"后台路径"，读取退化为纯单表查 |
| v2-scan | 新增**会话扫描器**：instrumentation 启动注册 + 定期（模板复用 board-reconcile-scheduler 的 globalThis 防重入模式） | 发现磁盘新文件/已删文件，更新 mtime |
| A1 | 在现有 `session_meta` 上加列，不新建表；沿用表名 | 会话旁路状态收敛为一个聚合根 |
| 归属判据 | 一律看 `task_id` 列，不看行有无 | 看板补卡 reconcile 兼容（普通聊天会话行 task_id=NULL 不混入） |
| 排序键 | **mtime 入库**（新增 `modified` 列，扫描时写入）；列表读表排序 | 列表读取不再现场 stat |
| 改名 | 写 jsonl + **同请求内 UPDATE title**（原子） | 标题实时；不靠扫描/懒更新 |
| last_reply | **不落库**，列表按需**尾读文件** | 库不背"内容"债 |
| 扫描粒度 | 扫描器 **stat + header（id/cwd/首条消息）**，**不读尾部**；title 只在改名/建行时写 | 外部改名不追（管不了）；last_reply 列表尾读 |
| 运行中 | registry 提供（getRpcSessionInfos），与磁盘列表 union；前端 G1 浮顶 | 运行态实时性由 registry 保证，不等扫描周期 |
| 恢复上次会话 | AppShell 用记忆 id **点查** `GET /api/sessions/[id]` | 脱离列表依赖 |
| 索引初始化 | 读取前确保扫描器至少跑过一轮（懒初始化 + 后台周期续） | 避免启动首请求打到空索引 |

## 3. Schema（sqlite，SCHEMA_VERSION 10 → 11）

现有 `session_meta(session_id TEXT PRIMARY KEY, task_id TEXT, updated INTEGER, pinned INTEGER)` 新增列：

```sql
ALTER TABLE session_meta ADD COLUMN path         TEXT;   -- jsonl 完整路径
ALTER TABLE session_meta ADD COLUMN cwd          TEXT;   -- 会话所属 cwd 目录
ALTER TABLE session_meta ADD COLUMN project_key  TEXT;   -- 归一化项目标识（resolveProject 推算）
ALTER TABLE session_meta ADD COLUMN title        TEXT;   -- 最新标题（本应用改名写；无则 NULL 展示读首条消息）
ALTER TABLE session_meta ADD COLUMN first_message TEXT;  -- 首条用户消息（建行时读 header 写入）
ALTER TABLE session_meta ADD COLUMN parent_id    TEXT;   -- fork 父会话 id（header.parentSession 反查，根为 NULL）
ALTER TABLE session_meta ADD COLUMN created      INTEGER; -- 创建时间(ms)
ALTER TABLE session_meta ADD COLUMN modified     INTEGER; -- 文件 mtime(ms)，扫描器维护，列表排序键

CREATE INDEX idx_meta_project_modified ON session_meta(project_key, modified DESC);
```

**说明**：
- `title` 仅在"本应用改名 / 建行"时写；无自定义名 title=NULL，展示层读 first_message 兜底。
- `last_reply` 不入库。
- `task_id`/`pinned`/`updated` 语义不变（归属判据只看 task_id）。
- 每行 `path` 唯一性：同一会话文件被扫描多次 → upsert（ON CONFLICT(session_id)），天然幂等。

## 4. 会话扫描器（新增，核心）

**文件**：`lib/session-index-scanner.ts`（新）+ `instrumentation.ts` 注册。

**职责（一轮 tick）**：
1. 全量 `readdir + stat` 磁盘会话目录（复用/扩展 `session-scanner.scanSessionFileMeta`，O(项目目录数)，不读内容）；
2. 对每个磁盘文件：
   - meta 无此行 → 读 header（id/cwd/首条消息）+ resolveProject(cwd) 算 project_key → **INSERT**（created=header.timestamp、modified=mtime、first_message=首条）；
   - meta 有行 → 仅当 mtime 变化时 **UPDATE modified**（不读内容）；
3. 对 meta 里存在但磁盘已无此文件的会话 → **DELETE 行**；
4. 幂等（upsert），可重入；globalThis 防热重载重复启动（复用 board-reconcile-scheduler 模板）。

**调度**：
- `startSessionIndexScanner()`：启动即跑首轮 + 定期（建议 30s，可调）续跑；`tickInFlight` 防重叠；`timer.unref()` 不阻塞退出。
- 懒初始化：列表读取函数先检查"首轮是否完成"标志，未完成则 `await` 首轮，避免首请求空索引。

**不做的**：扫描不读文件尾部（不追外部改名、不存 last_reply）；不 resolveProject 缓存之外的开销（复用 60s TTL）。

## 5. 写入点（事件驱动，与扫描器互补）

| 时机 | 入口 | 动作 |
|---|---|---|
| 新会话首条消息落盘 | `rpc-manager.ts` `persistNewSessionFile` | upsert 行（title=首条，立即可见，不必等扫描周期） |
| 改名 | `app/api/sessions/[id]` PATCH name | 写 jsonl + 同请求 UPDATE title（无行则 INSERT，M1 含老会话首改） |
| 置顶 | PATCH pinned | UPDATE pinned（已有） |
| 归属/取消 | `task-store.ts` | UPDATE task_id（已有） |
| 删除 | DELETE | DELETE 行（已有）；磁盘文件删除由扫描器下一轮确认 |
| 外部新建/改动/删除 | 无入口 | **扫描器**兜底（建行/更新 mtime/删行） |

## 6. 读取（列表 = 纯查 session_meta + runtime union）

服务端 `GET /api/sessions?project=<key>`：
1. 确保索引已初始化（懒初始化 await 首轮，见 §4）；
2. `SELECT * FROM session_meta WHERE project_key=? ORDER BY pinned DESC, modified DESC`（置顶优先 + mtime）；
3. union `getRpcSessionInfos()` 中同 projectKey 的运行中/未落盘会话（前端已按 runtime 机制处理，服务端返回 runningSessionIds）；
4. 每行 title：`meta.title` 非空用之；NULL 则 `first_message`；两者皆空则读 header 首条消息兜底（极端：扫描刚建行但 first_message 空）；
5. last_reply 不入返回主体——前端按需对可见行**尾读**（单独点查或渲染时请求，沿用 scanTail）。

**排序**：服务端一次排好（置顶 → mtime 降序）；运行中由前端本地浮顶（G1）。

## 7. 接口与调用矩阵（新）

| 调用方 · 功能 | 接口 | 调用时机 | 调用结果 |
|---|---|---|---|
| 侧栏 · 聊天会话列表 | `GET /api/sessions?project=<key>` | 首屏；切项目；刷新事件统一 refresh() | 填充**唯一** sessions state，整体替换 |
| 侧栏 · 未读红点清理 | 不请求，消费 state | 列表刷新后 | 过滤已删会话红点 |
| AppShell · hydrate | 不请求，消费 Sidebar state | 列表就绪 | 补全选中会话字段 |
| AppShell · 恢复上次会话 | `GET /api/sessions/[id]` 点查 | 切换工作区 | id 点查，404 清记忆 |
| 聊天区 · 消息加载 | `GET /api/sessions/[id]` | 点开/切会话 | 消息内容（消息线，本次不动） |
| 列表行 · last_reply 展示 | 尾读（沿用 scanTail / 既有 detail 读取） | 行渲染 | 最后回复预览 |
| 看板 · 卡片摘要 | `GET /api/sessions`（无参全量） | 进看板/10s/回前台 | 卡片标题等（**记账，本次不改**，数据源自动落到新索引） |
| 看板 · 工作台展开卡 | `GET /api/sessions`（无参全量） | 展开卡 | 元数据（记账） |
| 运行态 | `GET /api/agent/running` | 2.5s 轮询 | running id，本地浮顶（G1） |
| 行内 · 改名 | `PATCH /api/sessions/[id]` | 改名提交 | 写 jsonl + 同请求写 title；触发 refresh |
| 行内 · 置顶/删除 | PATCH/DELETE | 操作 | 已有 + refresh |

> `GET /api/sessions`（无参）保留供看板/工作台（v2 下直接读完整索引，无分页、无文件系统读取）。

## 8. 前端收敛（Sidebar 单一事实）

1. 四份 state → 单一 `sessions`（含 pinned/running 标记）。
2. 拆分页机制（loadMoreChatSessions、哨兵 observer、offset/total、mergeChatSessions 增量合并）。
3. 刷新入口统一 refresh()（改名/删除/新建/置顶/运行变化 → 一次拉取整体替换）。
4. 运行态本地浮顶（G1）。
5. 改名：正确性靠"写库 + 刷新"，乐观仅视觉。
6. AppShell hydrate 消费 Sidebar state；恢复上次会话改点查。

## 9. 不做（记账）

- 看板卡片 10s 轮询 / 工作台展开卡：数据源自动落到新索引，但"改按 id 点查"留待列表线稳定后。
- 外部 CLI 改名：不追（title 可能旧，可接受）。
- 虚拟滚动：未来量级到了再说。
- last_reply 入库：不存。

## 10. 清理与验证

- 拆分页暴露的死代码（chat-lazy-load 死导出等）。
- 适配测试：session-reader pagination 测试、session-scanner、新 scanner 单测（建行/删行/mtime 更新/幂等/懒初始化）、route 契约测试。
- 回归：首屏 / 切项目 / 改名即生效 / 置顶 / 运行浮顶 / 删除消失 / 老会话（扫描建行后）显示 / 外部 CLI 新建会话被扫描发现。

## 11. 工作区遗留补丁

`components/SessionSidebar.tsx` 未提交改动（分页重入锁补丁）与本次拆分页机制同段代码，实现阶段随分页拆除。实现前保持原样。
