import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  AUTO_CLEAR_DELAY_ROUNDS,
  REMINDER_INTERVAL,
  buildReminder,
  createReminderState,
  createTodoExtension,
  noteToolResult,
  onTurnStart,
  shouldAutoClear,
  takeReminderSlot,
  turnsSinceLastTodoUse,
} = await jiti.import("./todo-extension.ts");
const { TODO_STATE_CUSTOM_TYPE } = await jiti.import("./todo-store.ts");

const EXTENSION_SOURCE = readFileSync(
  fileURLToPath(new URL("./todo-extension.ts", import.meta.url)),
  "utf8",
);

// ── 测试替身 ─────────────────────────────────────────

function stateEntry(data) {
  return { type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data };
}

function userEntry() {
  return { type: "message", message: { role: "user" } };
}

function assistantEntry() {
  return { type: "message", message: { role: "assistant", content: [] } };
}

/**
 * 装配一个内联扩展实例。
 * 分支数组在 pi 与 ctx 之间共享：`appendEntry` 真的往分支追加 entry（与真实
 * sessionManager 一致）—— auto-clear 与回放都从分支推导，替身必须照做。
 */
function mount(branch = []) {
  const tools = new Map();
  const handlers = new Map();
  const appended = [];
  const pi = {
    registerTool: (definition) => tools.set(definition.name, definition),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
      branch.push(stateEntry(data));
    },
    tools,
    appended,
    /** 往分支末尾追加 `count` 条用户消息（= 又过了 count 轮）。 */
    rounds: (count) => {
      for (let i = 0; i < count; i++) branch.push(userEntry());
    },
    /** 往分支末尾追加 `count` 个模型回合（= 又跑了 count 次模型往返）。 */
    turns: (count) => {
      for (let i = 0; i < count; i++) branch.push(assistantEntry());
    },
    async emit(event, ctx, payload = {}) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler({ type: event, ...payload }, ctx));
      }
      return results;
    },
  };

  createTodoExtension().factory(pi);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const tool = pi.tools.get("todo");
  const call = (params) => tool.execute("call-1", params, undefined, undefined, ctx);
  return { pi, ctx, tool, call, branch };
}

const lastSnapshot = (pi) => pi.appended[pi.appended.length - 1]?.data;

// ── 扩展装配 ─────────────────────────────────────────

test("the inline extension is hidden and registers the todo tool", () => {
  const extension = createTodoExtension();
  assert.equal(extension.name, "pi-web-todo");
  assert.equal(extension.hidden, true);

  const { tool } = mount();
  assert.ok(tool, "todo tool registered");
  assert.equal(tool.name, "todo");
  assert.equal(tool.executionMode, "sequential");
  assert.equal(tool.parameters.type, "object");
  // 顶层 union 会被严格 OpenAI 兼容网关 400 —— schema 顶层必须是 object
  assert.equal(tool.parameters.additionalProperties, false);
});

test("mutations return the full list in details and persist a pi-todo.state snapshot", async () => {
  const { pi, call } = mount();

  const added = await call({ action: "add", texts: ["first", "second"] });
  assert.equal(added.details.action, "add");
  assert.deepEqual(added.details.todos.map((t) => t.content), ["first", "second"]);
  assert.equal(added.details.nextId, 3);
  assert.match(added.content[0].text, /\[\s\] #1: first/);
  assert.deepEqual(pi.appended[0], {
    customType: TODO_STATE_CUSTOM_TYPE,
    data: { todos: added.details.todos, nextId: 3 },
  });

  const updated = await call({ action: "update", id: 1, status: "in_progress" });
  assert.equal(updated.details.todos[0].status, "in_progress");
  assert.equal(lastSnapshot(pi).todos[0].status, "in_progress");

  const deleted = await call({ action: "delete", ids: [2] });
  assert.deepEqual(deleted.details.todos.map((t) => t.id), [1]);

  // list 不变更 → 不落盘
  const appendedBefore = pi.appended.length;
  const listed = await call({ action: "list" });
  assert.equal(pi.appended.length, appendedBefore);
  assert.equal(listed.content[0].text, "[~] #1: first");
});

test("handler failures throw and leave state untouched", async () => {
  const { pi, call } = mount();
  await call({ action: "add", texts: ["a"] });

  await assert.rejects(() => call({ action: "add", text: "singular" }), /You passed singular "text"/);
  await assert.rejects(() => call({ action: "update", id: 99, status: "completed" }), /Todo #99 not found/);
  await assert.rejects(() => call({ action: "delete", ids: [1, 99] }), /Todo #99 not found/);

  assert.equal(pi.appended.length, 1, "失败不落盘");
  assert.equal((await call({ action: "list" })).content[0].text, "[ ] #1: a");
});

test("session_start replays the last snapshot from the current branch", async () => {
  const branch = [
    stateEntry({ todos: [{ id: 1, content: "old", status: "completed" }], nextId: 2 }),
    { type: "message", message: { role: "user", content: "hi" } },
    stateEntry({ todos: [{ id: 7, content: "latest", status: "in_progress" }], nextId: 8 }),
  ];
  const { pi, ctx, call } = mount(branch);
  await pi.emit("session_start", ctx);

  const listed = await call({ action: "list" });
  assert.equal(listed.content[0].text, "[~] #7: latest");
  assert.equal(listed.details.nextId, 8);
});

test("session_tree rebuilds from the (switched) branch and drops stale state", async () => {
  const { pi, ctx, call } = mount();
  await call({ action: "add", texts: ["a", "b"] });

  // 切到不含快照的分支 → 状态清空
  ctx.sessionManager.getBranch = () => [];
  await pi.emit("session_tree", ctx);
  assert.deepEqual((await call({ action: "list" })).details.todos, []);
});

test("auto-clear wipes the list after the configured number of rounds and persists the empty snapshot", async () => {
  const { pi, ctx, call } = mount();
  await call({ action: "add", texts: ["a", "b"] });
  await call({ action: "update", updates: [{ id: 1, status: "completed" }, { id: 2, status: "completed" }] });

  const appendedBefore = pi.appended.length;
  await pi.emit("agent_end", ctx);
  assert.equal((await call({ action: "list" })).details.todos.length, 2, "同轮不清空");

  pi.rounds(AUTO_CLEAR_DELAY_ROUNDS - 1);
  await pi.emit("agent_end", ctx);
  assert.equal((await call({ action: "list" })).details.todos.length, 2, `${AUTO_CLEAR_DELAY_ROUNDS} 轮未到不清空`);

  pi.rounds(1);
  await pi.emit("agent_end", ctx);
  assert.deepEqual((await call({ action: "list" })).details.todos, [], "自动清空");
  assert.deepEqual(lastSnapshot(pi), { todos: [], nextId: 1 });
  assert.ok(pi.appended.length > appendedBefore, "清空必须落盘，否则顶栏面板残留旧列表");

  // 清空后重新 add，id 从 1 重新开始
  assert.equal((await call({ action: "add", texts: ["fresh"] })).details.todos[0].id, 1);
});

test("auto-clear never fires while work is open", async () => {
  const { pi, ctx, call } = mount();
  await call({ action: "add", texts: ["a"] });

  pi.rounds(AUTO_CLEAR_DELAY_ROUNDS + 3);
  await pi.emit("agent_end", ctx);
  assert.equal((await call({ action: "list" })).details.todos.length, 1);
});

// 回归：会话 wrapper 空闲 10 分钟即销毁（rpc-manager 的 idle timer），
// 轮数必须能从持久的分支重算 —— 旧版记内存计数，间隔 >10 分钟的交互永远数不满。
test("auto-clear still works when the session was recreated between rounds", async () => {
  const first = mount();
  await first.call({ action: "add", texts: ["a"] });
  await first.call({ action: "update", id: 1, status: "completed" });
  const persisted = first.branch.slice(); // 模拟落盘后进程结束

  // 新进程：从分支回放（此刻快照仍是「全部完成」，其后 1 轮）
  const second = mount([...persisted, userEntry()]);
  await second.pi.emit("session_start", second.ctx);
  assert.equal((await second.call({ action: "list" })).details.todos.length, 1, "回放后可读");

  second.pi.rounds(1); // 第 2 轮
  await second.pi.emit("agent_end", second.ctx);
  assert.deepEqual((await second.call({ action: "list" })).details.todos, [], "跨会话重建仍能清空");
});

// ── cadence 纯函数 ───────────────────────────────────

test("turnsSinceLastTodoUse counts model turns after the last snapshot", () => {
  assert.equal(turnsSinceLastTodoUse([]), 0);
  assert.equal(turnsSinceLastTodoUse([assistantEntry()]), 1);
  // 快照之后才起算；快照之前的历史回合不算
  assert.equal(turnsSinceLastTodoUse([assistantEntry(), assistantEntry(), stateEntry({ todos: [] })]), 0);
  assert.equal(
    turnsSinceLastTodoUse([stateEntry({ todos: [] }), assistantEntry(), assistantEntry(), assistantEntry()]),
    3,
  );
  // 又改过 todo → 重新起算
  assert.equal(
    turnsSinceLastTodoUse([stateEntry({ todos: [] }), assistantEntry(), stateEntry({ todos: [] }), assistantEntry()]),
    1,
  );
  // user 消息不是回合（一次提问里可能跑十几个回合）
  assert.equal(turnsSinceLastTodoUse([stateEntry({ todos: [] }), userEntry(), userEntry()]), 0);
});

// 回归：扩展闭包里的计数器活不过 AgentSession 的 10 分钟空闲回收，
// 「隔几分钟问一句」永远数不到 4 轮 → 提醒等于没有（auto-clear 踩过同一个坑）。
test("reconstruct seeds the cadence from the branch so the reminder survives a recreated session", async () => {
  const persisted = [
    stateEntry({ todos: [{ id: 1, content: "stale", status: "in_progress" }], nextId: 2 }),
    assistantEntry(),
    assistantEntry(),
    assistantEntry(),
  ];

  // 新进程：session_start 回放，并把「距上次动 todo 的回合数」续算上
  const { pi, ctx } = mount([...persisted]);
  await pi.emit("session_start", ctx);

  // 下一个回合即到期（3 个已过去 + 本回合 = REMINDER_INTERVAL）
  await pi.emit("turn_start", ctx, { turnIndex: 0 });
  const [injected] = await pi.emit("context", ctx, { messages: [{ role: "user", content: "hi" }] });
  assert.match(injected.messages[1].content[0].text, /<system-reminder>/);

  // 刚改过 todo 的分支 → 不续算，静默
  const fresh = mount([
    stateEntry({ todos: [{ id: 1, content: "doing", status: "in_progress" }], nextId: 2 }),
    assistantEntry(),
  ]);
  await fresh.pi.emit("session_start", fresh.ctx);
  await fresh.pi.emit("turn_start", fresh.ctx, { turnIndex: 0 });
  const [silent] = await fresh.pi.emit("context", fresh.ctx, { messages: [] });
  assert.equal(silent, undefined, "刚动过 todo → 不提醒");
});

test("cadence fires only after N quiet turns while work is open", () => {
  const state = createReminderState();
  for (let i = 0; i < REMINDER_INTERVAL - 1; i++) {
    onTurnStart(state);
    assert.equal(takeReminderSlot(state, true), false);
  }

  onTurnStart(state);
  assert.equal(takeReminderSlot(state, true), true, `第 ${REMINDER_INTERVAL} 轮触发`);
  // 取走配额后计时器推到当前轮 → 下一轮不再触发
  onTurnStart(state);
  assert.equal(takeReminderSlot(state, true), false, "同周期只注入一次");
});

// 纯文本轮没有 tool_result：求值点必须在 context，否则提醒永不触发
// （探针实测：旧版只在 tool_result 里 arm → 模型连续 5 轮不调工具时零注入）
test("cadence fires even when the model calls no tools at all", () => {
  const state = createReminderState();
  for (let i = 0; i < REMINDER_INTERVAL; i++) onTurnStart(state);
  assert.equal(takeReminderSlot(state, true), true);
});

test("using the todo tool resets cadence", () => {
  const state = createReminderState();
  for (let i = 0; i < REMINDER_INTERVAL + 2; i++) onTurnStart(state);

  noteToolResult(state, "todo");
  assert.equal(takeReminderSlot(state, true), false, "刚用过 todo 工具，不提醒");

  onTurnStart(state);
  assert.equal(takeReminderSlot(state, true), false);
  // 重置后重新数满 REMINDER_INTERVAL 轮才提醒
  for (let i = 0; i < REMINDER_INTERVAL; i++) onTurnStart(state);
  assert.equal(takeReminderSlot(state, true), true);

  // 非 todo 工具不重置节奏
  const other = createReminderState();
  for (let i = 0; i < REMINDER_INTERVAL; i++) onTurnStart(other);
  noteToolResult(other, "bash");
  assert.equal(takeReminderSlot(other, true), true);
});

test("cadence stays silent when nothing is open", () => {
  const state = createReminderState();
  for (let i = 0; i < REMINDER_INTERVAL + 3; i++) onTurnStart(state);
  assert.equal(takeReminderSlot(state, false), false);
});

test("buildReminder lists open items and names the in_progress one", () => {
  assert.equal(buildReminder([]), null);
  assert.equal(buildReminder([{ id: 1, content: "done", status: "completed" }]), null);

  const text = buildReminder([
    { id: 1, content: "done", status: "completed" },
    { id: 2, content: "doing", status: "in_progress" },
    { id: 3, content: "waiting", status: "pending" },
  ]);
  assert.match(text, /^<system-reminder>/);
  assert.doesNotMatch(text, /done/, "已完成的项不进提醒");
  assert.match(text, /\[~\] #2: doing/);
  assert.match(text, /\[ \] #3: waiting/);
  assert.match(text, /#2（"doing"）仍标记为 in_progress/);
  assert.match(text, /绝不要向用户提及这条提醒/);

  const noInProgress = buildReminder([{ id: 4, content: "todo", status: "pending" }]);
  assert.match(noInProgress, /没有任何 in_progress/);
});

test("auto-clear counts rounds from the session branch, not from in-memory state", () => {
  const todoState = (todos) => ({ type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data: { todos, nextId: 9 } });
  const user = () => ({ type: "message", message: { role: "user" } });
  const allDone = [{ id: 1, content: "a", status: "completed" }];

  // 快照之后 0 / 1 轮 → 不清
  assert.equal(shouldAutoClear([todoState(allDone)]), false);
  assert.equal(shouldAutoClear([todoState(allDone), user()]), false);

  // 达到延迟轮数 → 清
  assert.equal(shouldAutoClear([todoState(allDone), user(), user()]), true);

  // 有未完成项 → 永不清
  const open = [{ id: 1, content: "a", status: "in_progress" }];
  assert.equal(shouldAutoClear([todoState(open), user(), user(), user(), user()]), false);

  // 没有快照 / 空快照 → 不清（空列表无需再清）
  assert.equal(shouldAutoClear([user(), user()]), false);
  assert.equal(shouldAutoClear([todoState([]), user(), user()]), false);

  // 只认最后一条快照：中途被改回未完成 → 不清
  assert.equal(
    shouldAutoClear([todoState(allDone), user(), todoState(open), user(), user()]),
    false,
  );
});

// ── 事件接线 ─────────────────────────────────────────

test("the context event injects a transient reminder and never a persisted message", async () => {
  const { pi, ctx, call } = mount();
  await call({ action: "add", texts: ["step one"] });

  // 无工具调用的纯文本轮也要能触发
  for (let i = 0; i < REMINDER_INTERVAL; i++) {
    await pi.emit("turn_start", ctx, { turnIndex: i });
  }

  const [injected] = await pi.emit("context", ctx, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(injected.messages.length, 2);
  const reminder = injected.messages[1];
  assert.equal(reminder.role, "user");
  assert.match(reminder.content[0].text, /<system-reminder>/);
  assert.match(reminder.content[0].text, /#1: step one/);

  // 注入走的是 context 的瞬时 messages —— 不落盘、不产生 custom_message
  const persistedTypes = new Set(pi.appended.map((entry) => entry.customType));
  assert.deepEqual([...persistedTypes], [TODO_STATE_CUSTOM_TYPE]);

  const [silent] = await pi.emit("context", ctx, { messages: [] });
  assert.equal(silent, undefined, "同周期不重复注入");
});

// ── 源码级约束（原始需求：不要「不停地发扩展消息」）──────────

test("the extension never injects persisted messages or steer", () => {
  assert.doesNotMatch(EXTENSION_SOURCE, /pi\.on\("before_agent_start"/);
  assert.doesNotMatch(EXTENSION_SOURCE, /pi\.sendMessage|pi\.sendUserMessage/);
  assert.doesNotMatch(EXTENSION_SOURCE, /appendCustomMessageEntry/);
  assert.match(EXTENSION_SOURCE, /pi\.on\("context"/, "提醒只走 context 瞬时注入");
});
