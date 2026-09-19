# session_meta 集合链路审计（数据库作为会话列表唯一事实依据）

日期：2026-09-18
代码版本：7bf46af（工作树 fix-fork-miss，与 /Users/baique/work/pi-web-sky 同一提交）
运行实例：30143（仓库 dev）、30141（已发布 0.1.56，npx 缓存）；两者共用 `~/.pi/agent/pi-web.db`

## 契约

1. 会话操作的标准链路：**先执行 pi 操作 → 成功后才写库 → 然后刷新列表**。
   核心原则：**写库必须在 pi 操作成功之后、刷新之前**。顺序既不能提前（pi 失败却已落库），也不能缺失或滞后到后台（刷新出来的列表就是错的）。
2. 推论：pi 操作失败 → 不写库；pi 操作成功但库写失败 → 本次请求必须失败或可靠重试，**不允许静默留给扫描器兜底**（扫描器补不出归属/标题这类语义列）。
3. 会话列表以库为唯一事实：库至少提供 `会话id / 标题 / 创建时间`；`最后一条消息 / 最后活跃时间` 从文件反向读（速度设计：只 `stat` / 反向分块读块，不读全文）。

> 前一版审计把 V2/V3 记成「顺序反了（先文件后库）」——按上述契约这不算错，它们的真实缺陷是「库写不完整 / 父子链不同步 / 失败无兜底」。本版已更正。

## 写入时序核对表（核心结论）

| 操作 | pi 操作 | 库写入 | 同请求内 | pi 失败行为 | 库写失败行为 | 判定 |
|---|---|---|---|---|---|---|
| 新建会话 | `SessionManager.create` + 落盘空 header（`rpc-manager.ts:1552`） | `ensureSessionMetaRow` 建全列行 | ✓ | 不写库 ✓ | 静默 catch → 等扫描器 ≤30s | ⚠（新建无归属，可接受） |
| 新建会话带任务 | 上同上 | `assignSessionToTask`（`task-store.ts:304`） | ✓ | — | 抛错 → 500 ✓ | ✓ |
| **fork** | `createBranchedSession` + 手动落盘（`rpc-manager.ts:638-689`） | `ensureSessionMetaRow`（`:700`） | ✓ | 不写库 ✓ | **静默 catch**（`:711`） | ✗ 无 task 继承；失败静默 |
| **fork_branch** | 同上（`rpc-manager.ts:604-631`） | `indexSessionFileNow`（`:634`） | ✓ | 不写库 ✓ | 无 catch → 500 ✓ | ✗ 无 task 继承 |
| **内置 subagent** | `SessionManager.create(..., {parentSession})`（`subagent-runtime.ts:216-241`） | **完全无写入** | ✗ | — | — | ✗ 违反核心原则 |
| 改名 | `appendSessionInfo`（`sessions/[id]/route.ts:107`） | `setSessionTitle`（`:111`） | ✓ | 不写库 ✓ | 抛错 → 500，文件已改、库留旧名且无重试 | ⚠ 局部行（见下） |
| 置顶 | 无（纯应用态） | `setSessionPinned`（`:119`） | ✓ | — | 抛错 → 500 | ⚠ 局部行 |
| 删除单会话 | 子会话 header 重挂 + `unlinkSync`（`sessions/[id]/route.ts:126-200`） | `unassignSession(id)`（`:198`） | ✓ | 文件不存在也删库 ✓ | 抛错 → 500（幽灵行，扫描器下轮清） | ⚠ 子会话 `parent_id` 不同步 |
| 删除任务 | 递归删文件（`session-delete.ts:74`） | 逐会话 `unassignSession` + `deleteTask` | ✓ | 单文件失败被吞、继续 | — | ⚠ 树成员靠磁盘父链 |
| **auto-name** | `setSessionName` 写 jsonl 尾（`auto-name/route.ts:31`） | **完全无写入** | ✗ | — | — | ✗ 违反核心原则 |
| **发消息 / 跑 agent** | prompt 写 jsonl（`app/api/agent/[id]/route.ts`） | **无写入**（`modified` 不更新） | — | — | — | ✗ 活跃时间最多滞后 30s |
| 拖入任务 / 拖入看板 | 无 | `assignSessionToTask`（`/assign-session`、`/add-session`） | ✓ | — | — | ✓（本批唯一正例） |

## 结论速览

| 编号 | 问题 | 严重度 |
|---|---|---|
| V1 | 子会话（fork / 内置 subagent）不继承父的任务归属；任务区用**磁盘父链**推导成员 → 子会话同时出现在任务区和聊天区 | 高（已复现） |
| V2 | 有 pi 操作却**不写库 / 写了也静默失败**：auto-name 只写文件；内置 subagent 不写库；fork 建行静默 catch | 高（违反核心原则） |
| V3 | 库写**滞后到后台**：最后活跃时间靠 30s 扫描器；删除会话后子会话 `parent_id` 仍指向已删会话 ≤30s | 高（可见错序/脏父链） |
| V4 | 库写**不完整**：改名/置顶对无行会话是「局部行 INSERT」（缺 path/project_key/created）→ 会话可短暂从聊天列表消失、任务区显示 1970 | 中 |
| V5 | 列表不提供「最后一条消息」（`lastReply` 仅看板摘要点查有） | 中 |
| V6 | 读取路径仍读文件/扫盘：`/api/tasks` 每次全量 readdir+stat+读每个 header；列表 GET 会写库；`resolveSessionPath` miss 触发全量头尾扫 | 中 |
| V7 | 扫描器只做一层 readdir：`forks/`、`<session>/<uuid>/run-0/session.jsonl` 等子目录中的会话永不被发现 | 待确认（写入方未知） |
| V8 | 共享库多实例无版本护栏（30141 与 30143 同库） | 低 |

---

## V1 子会话两区重复（用户反馈的症状，已用现场数据复现）

**现象**（2026-09-18 16:40 快照）：会话 `01a0b393-c818-78e7-9463-9b4106f35041`
- `/api/sessions?project=/Users/baique/work/pi-web-sky`（**聊天区**）返回它 → 它的父 `cceb620c` 不在该列表里 → 前端 `resolveAncestor()` 找不到祖先 → **渲染成一条根行**
- `/api/tasks?projectKey=…`（**任务区**）任务 `0918问题测试`(`3af9bcf3`) 的 sessions 里也有它 → 挂在 `cceb620c` 下**嵌套显示**
- 库里只有一行：`task_id = NULL`，`parent_id = cceb620c-…`

**根因：两个区用了两套归属判据**
- 聊天区成员：`session_meta WHERE project_key = ? AND task_id IS NULL`（`lib/session-reader.ts:110`）
- 任务区成员：DB 里的根 id（`listTaskSessionIds`）+ **磁盘 header.parentSession 递归出来的子树**（`lib/session-reader.ts:238-300` 的 `buildTaskSessionIndex` / `collectSubtree`）
- 于是「父在任务里」和「自己 task_id 为空」同时成立 → 两区都收。子会话只要 task_id 是 NULL（fork 与内置 subagent 都是），一定被踢进聊天区。

**为什么子会话一定拿不到归属**
- fork：`lib/rpc-manager.ts:700` `ensureSessionMetaRow(newSessionId, {path, cwd, projectKey, parentId})` —— 参数里**没有 taskId**，写行恒为 `task_id = NULL`
- fork_branch（引用 fork）：`lib/rpc-manager.ts:634` `indexSessionFileNow(forkedPath, parent)` —— `lib/session-index-scanner.ts:48-77` 的 INSERT 里 task_id 硬编码 `NULL`
- 内置 subagent：`lib/subagent-runtime.ts:216-241` 用 `SessionManager.create(..., { parentSession: parent.sessionFile })` 造会话，**完全没写 session_meta**，行由 30s 扫描器补（同样 task_id NULL）；运行期还会被 `getRpcSessionInfos()` 当 runtime 会话塞进聊天区（`app/api/sessions/route.ts:33-40` 只按 `task_id` 过滤）

**没有自愈**：扫描器只收敛 `parent_id` / `first_message` / `modified`，**从不修 task_id**，坏行会永久留存。

**镜像缺陷（同源，尚未在库里出现）**：把带子树的任务会话移出任务时，前端只提交这一个 id（`components/SessionSidebar.tsx:1137-1148` → `PATCH /api/tasks/[id]` 全量替换），子会话仍带旧 task_id → 子会话留在任务区当根行，父会话跑到聊天区。同一处两侧判据不一致，方向相反而已。

> 判定：**归属是「按节点存」的，而 UI 分组是「按树渲染」的**，两者必然打架。
>
> **修法（2026-09-18 已定：走「子会话继承 task_id」，理由：查询方便）**：
> 1. fork / fork_branch / subagent 建行时，`task_id` 继承源会话的 `task_id`（`ensureSessionMetaRow` / `indexSessionFileNow` 都要能传 taskId；subagent 建会话后必须同请求内建行）
> 2. **归属变更必须连带整棵子树**（否则镜像缺陷照旧）：拖入/移出任务（`PATCH /api/tasks/[id]` 全量替换、`assign-session`、`add-session`）、删除任务，都要按 `parent_id` 递归应用到后代
> 3. 一次性修数据：把已存在的「父在任务、自己 task_id 为空」的行补上归属（当前库中 1 条：`01a0b393-c818`）
> 4. 扫描器加「归属一致性」收敛：子会话与父归属不一致时以父为准（防外部/旧版本写歪）
> 5. 任务区目前用磁盘父链推导子树（V6）——继承方案下它可以继续这样，但**父子链的两套来源仍在**，建议一并改成读 `session_meta.parent_id`

---

## V2 有 pi 操作却不写库 / 写了也静默失败

1. **auto-name**（`app/api/sessions/[id]/auto-name/route.ts:27-33`）：`session.inner.setSessionName(title)` 只落 jsonl 尾部的 `session_info`，没有 `setSessionTitle`。扫描器明确不读文件尾部 → 库标题永远是旧值／首条消息。结果是「侧栏一个名、聊天顶部另一个名」永久分叉。UI 入口虽已摘除，路由与 `lib/session-title.ts` 仍在，扩展/第三方调用即中招。
2. **内置 subagent**：子会话 pi 侧已落盘，库侧零写入（见 V1）。
3. **fork 建行静默失败**：`lib/rpc-manager.ts:711` 的 `catch {}` 注释写「扫描器下一轮兜底补行」——扫描器能补 `path/cwd/project_key/parent_id/first_message`，但**补不出 task_id**，正好是 V1 的病灶。核心原则要求：pi 已成功就必须让本次请求失败或可靠重试，不能静默。

## V3 库写滞后到后台（「刷新之前」不成立）

- **最后活跃时间**：`session_meta.modified` 的写入方只有扫描器（30s 一轮，`lib/session-index-scanner.ts:41/129/193`）与建行时的 `now()`。**发消息不写库**（`app/api/agent/[id]/route.ts` 全程无 DB 写入）。现场证据（16:25）：`0c42c220` 库内 `modified = 16:24:58`，文件 mtime = `16:25:31`，**滞后 33.6s** → 刷新立刻发生，但库还没更新，契约里「刷新之前写库」这一环缺失。
- 侧栏按 `session.modified` 排序（`components/SessionSidebar.tsx:1151-1167`），因此「刚聊完的会话不会立刻上浮」。
- 声称的补救「运行中浮顶 G1」**实际无效**：`chatNodes`（同文件 1186-1193）把 running 排在前，紧接着 `buildSessionTree` + `orderPinnedFirst` 又按 `modified` 全量重排，running 前缀被丢弃。
- 聊天区优先用库行（`app/api/sessions/route.ts` 的 runtime union 只在 `!persistedIds.has(s.id)` 时补），运行时快照里更准的 `lastActivityMs` 也被忽略。
- **删单会话后子会话 `parent_id` 滞后**：`sessions/[id]/route.ts:126-165` 只把子会话的 header 重挂到祖父（磁盘），库里的 `parent_id` 要等下一轮 mtime 变化才收敛 → 这 ≤30s 内子会话在聊天区被当成根行（父已不在列表）。

## V4 库写不完整（局部行 INSERT）

`lib/task-store.ts:337-345` `setSessionTitle` / `:326-334` `setSessionPinned` 对**无行会话**是局部 INSERT，只写 `session_id/updated/title(pinned)`，缺 `path/cwd/project_key/created`：
- 该会话从「按 `project_key` 过滤」的聊天区列表消失，直到下一轮扫描（≤30s）
- 任务区按 id 查到的 `created/modified` 是 0 → 显示 1970-01-01
（同样形态：`assignSessionToTask` 对未知会话的 INSERT。）
原则要求库写必须一步到位，不能留半行等后台补。

## V5 列表不提供「最后一条消息」

`SessionInfo.lastReply` 只在 `POST /api/sessions/summary`（看板卡 `loadSessionSummariesByIds` → `scanOneSessionFile` 头尾读）与遗留全量扫路径里填充；`loadProjectSessions` / `loadAllSessionIndex` 都不带。侧栏聊天行若要有「最后一条消息」预览，这个契约项等于未实现。

## V6 读取路径仍读文件 / 扫盘

- `/api/tasks`：每次请求 `buildTaskSessionIndex()` 全量 `readdir + stat` + **逐个会话读首行 header** 只为重建父链（`lib/session-reader.ts:238-268`）——而 `session_meta.parent_id` 早就有这份数据。这既是「库唯一事实」的直接违反，也是 V1 两套判据的来源。
- `fillFirstMessageFromFile`（`lib/session-reader.ts:73-90`）：列表 GET 会对 `first_message` 为空的行读文件头并 **UPDATE 库**（读路径写库）。
- `resolveSessionPath(id)` 缓存 miss → `listAllSessions()` → `loadAllSessions()`（`lib/session-reader.ts:188-215`）**全量头+尾扫**（结果缓存 5 分钟）。任何指向已删会话的 id（看板残留卡、外部调用）都能触发一次 ~150 文件的扫盘。

## V7 扫描器覆盖面（待用户确认写入方）

扫描器只对每个项目目录做一层 `readdir`（`lib/session-scanner.ts:253-288`），子目录里的 `.jsonl` 一律看不见。磁盘现状：
- `<project>/<会话文件同名目录>/forks/<ts>_<id>.jsonl`：**5 个**真实会话文件（09-14 ×4、09-17 ×1，如 `01a09edb…`、`01a0ad04…`），**库里完全没有行** → 这些会话永远不出现在列表，其子会话也永远挂在不存在的父上
- `<project>/<会话文件同名目录>/<uuid>/run-0/session.jsonl`、`<project>/subagent-artifacts/*_scout_0_*.jsonl`：另一种布局

**写入方判定（2026-09-18 追查）**：这些目录不是 pi-web 写的，是**另一个 pi 系工具**写的。证据链：
- `~/.pi/agent/missions/index/*.json` 记录了 `missionId / projectRoot / recordPath / lastRunId`，其 `lastRunId` 与 `<会话文件同名目录>/<runId>/run-0/session.jsonl` 的目录名**逐一对上**（如 `dcc2ee4d-8e43-44d9-8ca0-25e80da69ea9`，projectRoot 也一致）；同目录下还有 `subagent-artifacts/*_scout_0_*.jsonl`、`~/.pi/agent/run-history.jsonl`（agent 名 `scout` / `delegate` / `reviewer`）——即一个带 missions + 内置 agent 的 runner。
- 本机所有 pi-web（0.1.55 全局 / 0.1.56 npx / 当前 HEAD）与所有 pi（0.84.3 / 0.85.1）代码里都**没有** `missions` / `forks/` / `run-0` / `subagent-artifacts` 的路径构造（pi 的 missions 关键词在 d.ts 里也不存在）。
- **需要确认**：这台机器上除了 pi-web 还跑着哪个 pi 系工具（不用给我代码，只要名字 + 它以后是否还会往 `~/.pi/agent/sessions` 写）。

影响判定：
- 若长期共存 → 明确「子目录里的文件不属于本应用的会话集合」，扫描器只认平铺 `<ts>_<id>.jsonl`，并把这条写进文档/注释，不动发现层
- 若它是你未来的主力，或 pi 新版会切到这个布局 → 会话发现层必须整体升级：扫描器递归、`resolveSessionPath` 的名字匹配、`collectSessionDescendants`（删树）目前都只认平铺命名

附带损失（现在就存在）：`forks/` 里 5 个文件是**真实对话**（父会话属 wps-ai-plugin 项目），但它们的 id 在库和列表里完全不存在 → 在 pi-web 里这些 fork 等于不存在；只要那个工具还在用，这类会话会持续「凭空消失」。

另：`~/.pi/agent/pi-web-session-index.json`（mtime 09-17 08:33）是本仓库历史里**从不存在**的索引文件，同样指向一个外部的 pi-web 系进程；它是否也在写 `pi-web.db`，需要确认。

## V8 多实例共库无护栏

30141（发布版）与 30143（dev）同时跑扫描器/reconcile，共写 `~/.pi/agent/pi-web.db`。当前两者会话链路代码逐字节相同（`diff` 五个文件一致），所以今天没出事；但没有任何版本护栏，一旦有一个实例停留在旧链路（旧 fork 语义、旧 schema 假设），就会往同一张表写不同语义的行。

---

## 修复顺序建议（待确认后动手）

1. **V1 归属一致性（已定：子会话继承 task_id）**：fork/fork_branch/subagent 建行继承父 task_id；归属变更连带整棵子树；一次性数据修正；扫描器归属收敛
2. **V2 补齐库写**：auto-name 补 `setSessionTitle`；subagent 会话建行（继承父归属）；fork 建行去掉静默 catch（失败要可见/可重试）
3. **V3 消除后台滞后**：列表读取时用 `stat` 刷 `modified`（每行一次 stat、不读内容），发消息后同请求内更新 `modified`；删会话时同请求把子会话 `parent_id` 写到库；顺手修掉被覆盖的 G1 浮顶
4. **V4 库写一步到位**：局部 INSERT 补齐 `path/cwd/project_key/created`
5. **V5/V6**：列表补 `lastReply`（或明确不做）；`/api/tasks` 改读 `session_meta.parent_id`；`fillFirstMessageFromFile` 挪到后台
6. **V7** 待确认外部工具后：明确忽略（写进文档）或升级发现层
