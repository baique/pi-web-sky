import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  addTodos,
  deleteTodos,
  dispatchTodoAction,
  formatTodoList,
  hasOpenTodos,
  parseTodoSnapshot,
  updateTodos,
} = await createJiti(import.meta.url).import("./todo-store.ts");

const empty = () => ({ todos: [], nextId: 1 });

test("addTodos appends with consecutive ids from nextId", () => {
  const { snapshot, resultText } = addTodos(empty(), ["  first  ", "second"]);
  assert.deepEqual(snapshot.todos, [
    { id: 1, content: "first", status: "pending" },
    { id: 2, content: "second", status: "pending" },
  ]);
  assert.equal(snapshot.nextId, 3);
  assert.equal(resultText, "Added 2 todos (#1-#2)");

  // ids 不复用：删掉 #1 再 add 仍从 nextId 继续
  const afterDelete = deleteTodos(snapshot, [1]);
  const regrown = addTodos(afterDelete.snapshot, ["third"]);
  assert.deepEqual(regrown.snapshot.todos.map((t) => t.id), [2, 3]);
  assert.equal(regrown.snapshot.nextId, 4);
});

test("addTodos rejects empty items instead of silently dropping them", () => {
  assert.throws(() => addTodos(empty(), []), /non-empty array/);
  assert.throws(() => addTodos(empty(), ["ok", "   "]), /cannot be empty or whitespace-only/);
});

test("updateTodos patches status and text, and is atomic on unknown ids", () => {
  const { snapshot } = addTodos(empty(), ["a", "b", "c"]);

  const single = updateTodos(snapshot, [{ id: 2, status: "in_progress" }]);
  assert.equal(single.snapshot.todos[1].status, "in_progress");
  assert.equal(single.resultText, "Updated 1 todo(s)");

  const batch = updateTodos(single.snapshot, [
    { id: 1, status: "completed" },
    { id: 2, status: "completed" },
    { id: 3, text: "c2" },
  ]);
  assert.deepEqual(batch.snapshot.todos.map((t) => t.status), ["completed", "completed", "pending"]);
  assert.equal(batch.snapshot.todos[2].content, "c2");

  // 原子性：一条非法 → 整体不动
  assert.throws(() => updateTodos(batch.snapshot, [{ id: 1, status: "completed" }, { id: 99, status: "completed" }]), /Todo #99 not found/);
  assert.throws(() => updateTodos(batch.snapshot, [{ id: 1, status: "done" }]), /status only accepts/);
  assert.throws(() => updateTodos(batch.snapshot, [{ id: 1 }]), /neither status nor text/);
  assert.throws(() => updateTodos(batch.snapshot, [{ id: 1, status: "completed" }, { id: 1, text: "dup" }]), /duplicate id 1/);
});

test("deleteTodos rejects the whole batch when any id is missing", () => {
  const { snapshot } = addTodos(empty(), ["a", "b", "c"]);
  assert.throws(() => deleteTodos(snapshot, [1, 99]), /Todo #99 not found/);
  assert.deepEqual(deleteTodos(snapshot, [1, 3]).snapshot.todos.map((t) => t.id), [2]);
});

test("dispatchTodoAction validates required fields and singular/plural shape traps", () => {
  const snapshot = addTodos(empty(), ["a"]).snapshot;

  // add：双形陷阱
  assert.throws(() => dispatchTodoAction({ action: "add", text: "x" }, snapshot), /You passed singular "text"/);
  assert.throws(() => dispatchTodoAction({ action: "add", text: "x", texts: ["y"] }, snapshot), /do not also pass singular "text"/);
  assert.equal(dispatchTodoAction({ action: "add", texts: ["b"] }, snapshot).action, "add");

  // update：id 必填；updates[] 优先
  assert.throws(() => dispatchTodoAction({ action: "update", status: "completed" }, snapshot), /update requires id parameter/);
  const batched = dispatchTodoAction({
    action: "update",
    id: 1,
    status: "completed",
    updates: [{ id: 1, status: "in_progress" }],
  }, snapshot);
  assert.equal(batched.snapshot.todos[0].status, "in_progress", "updates[] 优先于单条字段");

  // delete：双形陷阱 + 必填
  assert.throws(() => dispatchTodoAction({ action: "delete", id: 1 }, snapshot), /You passed singular "id"/);
  assert.throws(() => dispatchTodoAction({ action: "delete" }, snapshot), /delete requires ids parameter/);

  // list：不变更（execute 以 action !== "list" 判定）
  const listed = dispatchTodoAction({ action: "list" }, snapshot);
  assert.equal(listed.action, "list");
  assert.equal(listed.resultText, "[ ] #1: a");
});

test("formatTodoList marks three states and falls back to No todos", () => {
  assert.equal(formatTodoList([]), "No todos");
  assert.equal(hasOpenTodos([]), false);
  const todos = [
    { id: 1, content: "done", status: "completed" },
    { id: 2, content: "doing", status: "in_progress" },
    { id: 3, content: "waiting", status: "pending" },
  ];
  assert.equal(formatTodoList(todos), "[x] #1: done\n[~] #2: doing\n[ ] #3: waiting");
  assert.equal(hasOpenTodos(todos), true);
  assert.equal(hasOpenTodos([todos[0]]), false);
});

test("parseTodoSnapshot restores a snapshot and degrades dirty entries", () => {
  const parsed = parseTodoSnapshot({
    todos: [
      { id: 1, content: "keep", status: "pending" },
      null,
      { id: 2, content: "no status" },
      { id: 3, content: "bad status", status: "done" },
      { id: 4, content: "", status: "pending" },
      { id: 5, content: "keep too", status: "completed" },
    ],
    nextId: 9,
  });
  assert.deepEqual(parsed, {
    todos: [
      { id: 1, content: "keep", status: "pending" },
      { id: 5, content: "keep too", status: "completed" },
    ],
    nextId: 9,
  });

  // 全脏 → 空列表（仍可回放）但保留 nextId（防 id 撞车）；非快照数据 → null
  assert.deepEqual(parseTodoSnapshot({ todos: [null], nextId: 3 }), { todos: [], nextId: 3 });
  assert.equal(parseTodoSnapshot({ todos: "nope" }), null);
  assert.equal(parseTodoSnapshot(null), null);
  // nextId 落后于现存 id 时取 max+1（防脏数据导致 id 撞车）
  assert.equal(parseTodoSnapshot({ todos: [{ id: 7, content: "x", status: "pending" }], nextId: 2 }).nextId, 8);
  // auto-clear 落盘的空快照必须解析成空列表而不是 null
  assert.deepEqual(parseTodoSnapshot({ todos: [], nextId: 1 }), { todos: [], nextId: 1 });
});
