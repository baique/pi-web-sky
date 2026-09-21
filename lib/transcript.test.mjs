import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createTranscriptState,
  transcriptReducer,
  transcriptMessages,
  transcriptEntryIds,
} = await jiti.import("./transcript.ts");

/** 造一条用户消息（提交时客户端自己的形态）。 */
const user = (text, timestamp) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const system = (text, timestamp) => ({ role: "system", content: text, timestamp });

/** 服务端窗口里的一条 entry。 */
const entry = (entryId, message, parentId = null) => ({ entryId, parentId, message });

const reduce = (state, ...actions) => actions.reduce(transcriptReducer, state);

test("提交把消息作为 pending 条目放进列表，并给出稳定的客户端 id", () => {
  const state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("你好", 100), runId: 1, submittedAt: 100 },
  );
  assert.equal(state.items.length, 1);
  assert.deepEqual(
    { id: state.items[0].id, state: state.items[0].state, serverEntryId: state.items[0].serverEntryId },
    { id: "c1", state: "pending", serverEntryId: null },
  );
  assert.deepEqual(transcriptMessages(state).map((m) => m.role), ["user"]);
});

// 回归：当前实现里 message_end(user) 只有在"乐观气泡刚好还在末尾"时才认它；
// 中间夹一条别的 message_end 就会改走追加分支 → 界面上两个一样的用户气泡。
test("回声到达时原地升级，绝不新增条目（即使前面先夹了一条 system）", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("重复测试", 100), runId: 1, submittedAt: 100 },
  );
  // pi 先推一条 system（历史上就是把乐观气泡挤出末尾的那条）
  state = reduce(state, { type: "server", message: system("system prompt 更新", 101) });
  // 紧接着才是这条用户消息的回声
  state = reduce(state, { type: "echo", runId: 1, message: user("重复测试", 102) });

  assert.equal(state.items.filter((i) => i.message.role === "user").length, 1, "用户消息必须只有一条");
  assert.equal(state.items[0].id, "c1", "必须是同一条目（id 不变 → 渲染不重挂）");
  assert.equal(state.items[0].state, "confirmed");
  assert.equal(state.items[0].serverEntryId, null, "回声不带 entryId，等合并时补");
});

test("合并服务端整表：同一位置沿用原条目 id，不新增、不重挂", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("合并测试", 100), runId: 1, submittedAt: 100 },
    { type: "echo", runId: 1, message: user("合并测试", 102) },
    { type: "server", message: assistant("收到", 110) },
  );
  const idsBefore = state.items.map((i) => i.id);

  state = reduce(state, {
    type: "mergeTail",
    entries: [
      entry("e1", user("更早的问题", 10)),
      entry("e2", assistant("更早的回答", 20)),
      entry("e3", user("合并测试", 102), "e2"),
      entry("e4", assistant("收到", 110), "e3"),
    ],
  });

  assert.equal(state.items.filter((i) => i.message.role === "user").length, 2, "用户消息两条：历史一条 + 本次一条");
  // 已存在的条目沿用原 id（命中位置不重挂），更早的历史作为新条目补在前面
  assert.deepEqual(state.items.map((i) => i.id).slice(-2), idsBefore, "已存在的条目 id 一个都不能变");
  assert.deepEqual(transcriptEntryIds(state), ["e1", "e2", "e3", "e4"]);
  assert.ok(state.items.every((i) => i.state === "confirmed"));
});

// 回归：当前实现里 loadSession 整表替换会把还没落盘的乐观气泡抹掉（"消息消失、AI 直接开始回复"）。
test("确认前合并：服务端还没有这一条，pending 条目原位保留", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("还没落盘", 100), runId: 1, submittedAt: 100 },
  );
  state = reduce(state, {
    type: "mergeTail",
    entries: [entry("e1", user("历史问题", 10)), entry("e2", assistant("历史回答", 20))],
  });

  assert.equal(state.items.filter((i) => i.message.role === "user").length, 2);
  const pending = state.items.find((i) => i.id === "c1");
  assert.equal(pending?.state, "pending", "未确认的条目必须还在");
  assert.equal(state.items[state.items.length - 1].id, "c1", "pending 排在末尾");
});

test("合并时空窗口不清空列表（避免瞬态空响应把界面刷白）", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "mergeTail", entries: [entry("e1", user("已有", 10))] },
  );
  state = reduce(state, { type: "mergeTail", entries: [] });
  assert.equal(state.items.length, 1);
});

test("同文本两条 steer：各自认领，不互相替换、不丢", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("同样的话", 100), runId: 1, submittedAt: 100 },
  );
  state = reduce(
    state,
    { type: "echo", runId: 1, message: user("同样的话", 102) },
    { type: "submit", id: "c2", message: user("同样的话", 200), runId: 1, submittedAt: 200 },
    { type: "echo", runId: 1, message: user("同样的话", 202) },
  );
  assert.deepEqual(state.items.map((i) => i.id), ["c1", "c2"]);
  assert.equal(state.items.filter((i) => i.message.role === "user").length, 2);
});

test("没有本地回显的服务端用户消息（别的客户端/扩展发的）作为新条目追加", () => {
  const state = reduce(
    createTranscriptState(),
    { type: "echo", runId: 3, message: user("来自别处", 500) },
  );
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].state, "confirmed");
});

test("提交被拒：按 id 移除 pending，别的条目不受影响", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "mergeTail", entries: [entry("e1", assistant("历史", 10))] },
    { type: "submit", id: "c1", message: user("被拒的消息", 100), runId: 1, submittedAt: 100 },
  );
  state = reduce(state, { type: "fail", id: "c1" });
  assert.deepEqual(state.items.map((i) => i.id), [state.items[0].id]);
  assert.equal(state.items.length, 1);
  assert.equal(transcriptMessages(state)[0].role, "assistant");
});

test("更早一页 prepend：重复 prepend 同一页只算一次", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "mergeTail", entries: [entry("e3", user("最新", 30))] },
  );
  const older = [entry("e1", user("最早", 10)), entry("e2", assistant("中间", 20))];
  state = reduce(state, { type: "prependOlder", entries: older });
  const once = state.items.map((i) => i.serverEntryId);
  state = reduce(state, { type: "prependOlder", entries: older });
  assert.deepEqual(state.items.map((i) => i.serverEntryId), once, "同一页重复加载不得重复插入");
  assert.equal(state.items.length, 3);
});

// 回归：回退（navigate_tree）/「编辑从此处」会把 leaf 移到更早的 entry，服务端窗口随之变短。
// 旧的 loadSession 是整表替换，落在窗口之外的条目会消失；合并实现里必须同样把它们判为"离开当前分支"丢弃，
// 否则回退后旧消息仍然留在消息流里。
test("回退到更早的 leaf：窗口之外的已落盘条目必须消失，pending 保留", () => {
  const e1 = entry("e1", user("第一问", 10));
  const e2 = entry("e2", assistant("第一答", 20), "e1");
  const e3 = entry("e3", user("第二问", 30), "e2");
  const e4 = entry("e4", assistant("第二答", 40), "e3");

  let state = reduce(
    createTranscriptState(),
    { type: "mergeTail", entries: [e1, e2, e3, e4] },
    { type: "submit", id: "c1", message: user("新提交还没落盘", 500), runId: 2, submittedAt: 500 },
  );
  assert.equal(state.items.length, 5);

  // 回退到 e2：服务端窗口只到 e2
  state = reduce(state, { type: "mergeTail", entries: [e1, e2] });

  assert.deepEqual(transcriptEntryIds(state).filter(Boolean), ["e1", "e2"], "离分支的 e3/e4 必须移除");
  assert.deepEqual(state.items.map((i) => i.id).filter((id) => id.startsWith("srv")), ["srv:e1", "srv:e2"]);
  assert.deepEqual(state.items.filter((i) => i.state === "pending").map((i) => i.id), ["c1"], "未落盘的提交不能被顺手丢掉");
});

test("切分支 reset：显式清空（唯一允许清空列表的动作）", () => {
  let state = reduce(
    createTranscriptState(),
    { type: "submit", id: "c1", message: user("旧分支", 100), runId: 1, submittedAt: 100 },
  );
  state = reduce(state, { type: "reset" });
  assert.equal(state.items.length, 0);
});
