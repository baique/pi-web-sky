# 会话 TODO（内建 todo 工具）

pi-web-sky **自带**会话 todo：装好即用，不需要用户安装任何 pi 包。工具给 LLM 用，顶栏右上角的面板给人看。

```
lib/todo-store.ts        纯数据层：三态模型 + 快照解析 + 4 个 action（可单测，不依赖 pi）
lib/todo-extension.ts    内联扩展：注册 todo 工具 / 落盘快照 / 回放 / auto-clear / 节奏提醒
lib/rpc-manager.ts       createTodoExtension() 进 extensionFactories（注入点）
lib/session-reader.ts    extractTodosFromEntries() 读快照（面板数据源）
app/api/sessions/[id]/todos/route.ts   轻量快照接口（会话切换 / 打开面板时拉一次；读活动分支）
components/AppShell.tsx  顶栏按钮 + 面板外壳（portal 到 body，自己算 fixed 定位）
components/TodoList.tsx  面板内容本体（表头/空态/条目列表）—— 顶栏与看板卡片顶栏**共用同一份**，
                         改圆点/删除线/空态文案只改这里
hooks/useAgentSession.ts tool_execution_end → 增量推送快照
```

## 工具契约

```
todo({ action: "list" | "add" | "update" | "delete",
       texts?: string[], text?: string, ids?: number[], id?: number,
       status?: "pending" | "in_progress" | "completed",
       updates?: { id, status?, text? }[] })
```

| action | 必填 | 行为 |
|---|---|---|
| `list` | — | 返回全部 |
| `add` | `texts[]` | 批量追加，连续 id，初始 `pending` |
| `update` | `id` + (`status` \| `text`)；或 `updates[]` | `updates[]` **优先于**单条字段 |
| `delete` | `ids[]` | **部分 id 缺失则整体拒绝**（原子性） |

- **schema 是扁平 `Type.Object`，字段全 Optional**：OpenAI 兼容网关会 400 掉顶层 union；必填与 `text`/`texts`、`id`/`ids` 双形陷阱全放 `dispatchTodoAction` 运行时校验（错误文案直接教模型怎么写对的 JSON）。改 schema 或校验时，`lib/todo-store.test.mjs` 的「shape traps」用例是回归网。
- 错误一律 `throw`，不返回「错误成功模式」。
- `in_progress` 不强制、`pending → completed` 直接跳转合法（刻意无状态机，与 goal 扩展的 6 态相反）。
- `nextId` **单调自增不复用**（删掉 #1 后再 add 得到 #2），只有 auto-clear 才复位 1。

## 持久化契约（改面板必读）

- 每次**变更**（add/update/delete/auto-clear）写一条 custom entry：
  `{"type":"custom","customType":"pi-todo.state","data":{"todos":[{id,content,status}],"nextId":N}}`
- 字段名是 **`content`**（不是 pi 插件惯用的 `text`）—— `lib/session-reader.ts` 只认 `content` 为 string 的项。改字段名会静默清空面板。
- 快照式（非增量）→ 回放只取最后一条；`pi.appendEntry` 不参与 LLM 上下文。
- `session_start` / `session_tree`（切分支）时从**当前分支**回放重建；状态存在扩展工厂闭包内，**每个 AgentSession 一份 → 会话隔离天然成立**。
- auto-clear 必须落盘**空快照**，否则面板残留旧列表。

## 数据到 UI 的三条路径（无轮询）
| 路径 | 何时 | 说明 |
|---|---|---|
| 增量推送 | 每次 todo 工具调用 | `tool_execution_end` 事件带完整 `result`，`hooks/useAgentSession.ts` 读 `result.details` → `setTodos`。**这是唯一的实时路径** |
| agent_end 重拉 | 每轮结束 | auto-clear 不走工具调用，只能靠它反映（框架先发扩展、后发订阅者，所以重拉一定看到已清空的状态） |
| 一次性拉取 | 会话切换 / 打开面板 | `refreshTodos()`。**没有轮询**：曾经的 6s 轮询是给已死的外部插件兜底的，2026-09-12 删除（拦 fetch 实测：一次 prompt 里按钮改两次、全程 0 次 `/todos` 请求） |

坑：`components/ChatWindow.tsx` 里把 todos 推给 AppShell 的 effect 用 `todosKey` 做依赖，**key 里必须带 `status`** —— 只按 id/content 算 key 时，`pending → completed` 不改 key，effect 不触发，面板会停在旧状态。

## auto-clear

`agent_end` 时**从活动分支重算**（`shouldAutoClear(entries)`）：取分支上最后一条 `pi-todo.state` 快照，数它之后又过了几条 user 消息 —— 快照处于「全部 completed」且其后已满 **2 条**（`AUTO_CLEAR_DELAY_ROUNDS`）→ 清空 todos、`nextId = 1`，并落盘**空快照**（不落盘的话面板会残留旧列表）。任何变更都会重写快照，计时自然重新起算。

为什么不记内存计数器：pi-web 的 AgentSession 空闲 10 分钟即销毁（见 `lib/rpc-manager.ts` 的 idle timer），扩展闭包里的计数活不过两次交互的间隔 —— 交互式使用（隔几分钟问一句）永远数不满 2 轮。分支是持久的，重算 O(分支长度)，而 `agent_end` 每轮只跑一次。

UI 侧：列表清空 → 按钮消失（`renderTodoButton` 在 `length === 0` 时返回 null）→ `AppShell` 的 effect 顺手收起浮层（否则入口没了、浮层还开着，且下次有 todo 时会自己弹开）。

## 节奏提醒（不落盘）

连续 **4 轮**（`REMINDER_INTERVAL`）没用过 todo 工具、且仍有未完成项时，在 `context` 事件里向**当次请求的 messages** 追加一条 `<system-reminder>`：列出未完成项，点名 `in_progress` 那项（已完成就立刻标 completed 并把下一项置 in_progress）。

- **求值点只能在 `context`**（`shouldInjectReminder`）。曾经照搬参考实现，只在 `tool_result` 里 arm、到 `context` 再 drain —— 那是错的：纯文本轮（模型没调任何工具）根本不发 `tool_result`，那样的回合永远不触发提醒。探针实测：模型连续 5 轮不调工具时旧版零注入，改单点求值后第 4 轮如期注入。
- 用了 todo 工具即重置节奏（`noteToolResult`）；注入后把计时器推到当前轮 —— 这两条共同保证一个周期只提醒一次。
- 全部完成时不注入（静默 2 轮 → auto-clear）。
- **必须走 `context` 瞬时注入，绝不能改成 `before_agent_start` 返回 `custom_message`**：后者会落盘成 entry，而 `components/MessageView.tsx` 的 `CustomMessageView` **会把它渲染成聊天气泡**（`display:false` 只是半透明 + 折叠，不是隐藏）—— 那就是「每轮多一张卡片」的来源。`lib/todo-extension.test.mjs` 有源码级断言锁住这一点。
- 参考对比：`@zhushanwen/pi-todo` 用落盘 `custom_message`（每轮，pi-web 里可见为卡片）；`@tintinweb/pi-tasks` / `@nguyenquangthai/pi-todo` 用 `context` 瞬时注入 + 4 轮 cadence（我们采用后者，但求值点更靠前）。

### 怎么验证提醒真的发出了

提醒不落盘 → 会话文件里看不到。可靠的观察点是 `before_provider_request` 的 payload：在 SDK 脚本里用内联 spy 扩展监听它，检查 payload 里是否含 `system-reminder`。

状态可以用 `session.getToolDefinition("todo").execute(id, params)` **直接驱动**（返回的是注册时的原始 definition，`ctx` 参数用不到），这样不依赖模型就能造出未完成 todo，再用几个纯文本轮驱动 `context`。

## 与外部 todo 插件共存

- 内联扩展在加载列表里**排在用户包之后**，而工具重名时**先注册者胜**（`runner.js getAllRegisteredTools`）→ 用户装了 `@zhushanwen/pi-todo` 时**插件赢**，内建 todo 不生效，启动列表会有一条 `Tool "todo" conflicts with …` 提示（无害）。
- 结论：不要与外部 todo 插件同时装；用户侧卸载即可，内建无需任何排除逻辑。

## 刻意不做

- 落盘的注入消息（`before_agent_start` / completion-steer）。
- prompt 意图分类（正则判「是否多步任务」再冷启动提醒）—— 语言相关、易误判。
- TUI 状态栏 / widget / `/todos` 命令 / `renderCall`·`renderResult`：pi-web 有自己的渲染。
- todo 的 UI 增删改（列表由 AI 维护；用户要改就直接让 agent 改）。
