/**
 * 会话 TODO 的纯数据层 —— 不依赖 pi 运行时，可独立单测。
 *
 * 三态：pending → in_progress → completed（刻意无状态机约束，任意方向自由流转）。
 * 字段名用 `content`（不是 `text`）是为了贴合 pi-web 既有契约：`lib/session-reader.ts`
 * 只认 `content` 为 string 的项，顶栏面板直接消费它。
 */

/** 会话文件里的快照 entry 类型（custom entry，不进 LLM 上下文）。 */
export const TODO_STATE_CUSTOM_TYPE = "pi-todo.state";

export const VALID_STATUSES = ["pending", "in_progress", "completed"] as const;

export type TodoStatus = (typeof VALID_STATUSES)[number];

export interface Todo {
  id: number;
  content: string;
  status: TodoStatus;
}

export interface TodoSnapshot {
  todos: Todo[];
  nextId: number;
}

/** 工具参数的可选形状（与 typebox schema 派生的 Static 结构兼容）。 */
export interface TodoActionParams {
  action: "list" | "add" | "update" | "delete";
  text?: string;
  texts?: string[];
  id?: number;
  ids?: number[];
  status?: string;
  updates?: Array<{ id: number; status?: string; text?: string }>;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (VALID_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 未完成项判定（pending / in_progress）—— 提醒与「是否还有活」都以它为准。 */
export function hasOpenTodos(todos: readonly Todo[]): boolean {
  return todos.some((t) => t.status !== "completed");
}

function requireText(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${what} cannot be empty or whitespace-only`);
  return trimmed;
}

// ── 快照解析 ─────────────────────────────────────────

/**
 * 解析 custom entry 的 `data`。脏数据逐项降级跳过（会话回放不能因一条坏数据中断）。
 * 空列表也是合法快照（auto-clear 落盘的就是它）→ 返回空快照而非 null。
 */
export function parseTodoSnapshot(data: unknown): TodoSnapshot | null {
  if (!isRecord(data) || !Array.isArray(data.todos)) return null;

  const todos: Todo[] = [];
  for (const raw of data.todos) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) continue;
    if (typeof raw.content !== "string" || raw.content.length === 0) continue;
    if (!isTodoStatus(raw.status)) continue;
    todos.push({ id: raw.id, content: raw.content, status: raw.status });
  }

  const maxId = todos.reduce((max, t) => Math.max(max, t.id), 0);
  const nextId = typeof data.nextId === "number" && data.nextId > maxId ? data.nextId : maxId + 1;
  return { todos, nextId };
}

// ── 增量推送 ──────────────────────────────────────

// ── 格式化 ───────────────────────────────────────────

export function formatTodoLine(todo: Todo): string {
  const mark = todo.status === "completed" ? "x" : todo.status === "in_progress" ? "~" : " ";
  return `[${mark}] #${todo.id}: ${todo.content}`;
}

export function formatTodoList(todos: readonly Todo[]): string {
  return todos.length > 0 ? todos.map(formatTodoLine).join("\n") : "No todos";
}

// ── 动作 ─────────────────────────────────────────────

/** `add` 不接受单数 `text`（那是 update 的字段）—— 弱模型最常踩的双形陷阱。 */
export function addTodos(
  snapshot: TodoSnapshot,
  texts: readonly string[],
): { snapshot: TodoSnapshot; resultText: string } {
  if (texts.length === 0) {
    throw new Error('add requires texts parameter (non-empty array). Correct: {"action":"add","texts":["..."]}');
  }
  const contents = texts.map((t) => requireText(t, "texts item"));

  const startId = snapshot.nextId;
  const todos = contents.map((content, index) => ({
    id: startId + index,
    content,
    status: "pending" as const,
  }));
  const nextId = startId + todos.length;

  return {
    snapshot: { todos: [...snapshot.todos, ...todos], nextId },
    resultText: `Added ${todos.length} todos (#${startId}-#${nextId - 1})`,
  };
}

/** 批量更新；任一 id 缺失或状态非法则整体拒绝（原子性）。 */
export function updateTodos(
  snapshot: TodoSnapshot,
  updates: ReadonlyArray<{ id: number; status?: string; text?: string }>,
): { snapshot: TodoSnapshot; resultText: string } {
  if (updates.length === 0) throw new Error("update requires at least status or text parameter");

  const seen = new Set<number>();
  for (const update of updates) {
    if (seen.has(update.id)) throw new Error(`duplicate id ${update.id} in updates`);
    seen.add(update.id);
    if (update.status === undefined && update.text === undefined) {
      throw new Error(`update item for id ${update.id} has neither status nor text`);
    }
    if (update.status !== undefined && !isTodoStatus(update.status)) {
      throw new Error(`status only accepts ${VALID_STATUSES.join(" / ")}`);
    }
    if (update.text !== undefined) requireText(update.text, `update item id ${update.id}: text`);
    if (!snapshot.todos.some((t) => t.id === update.id)) throw new Error(`Todo #${update.id} not found`);
  }

  const todos = snapshot.todos.map((todo) => {
    const update = updates.find((u) => u.id === todo.id);
    if (!update) return todo;
    return {
      ...todo,
      ...(update.status !== undefined ? { status: update.status as TodoStatus } : {}),
      ...(update.text !== undefined ? { content: update.text.trim() } : {}),
    };
  });

  return {
    snapshot: { todos, nextId: snapshot.nextId },
    resultText: `Updated ${updates.length} todo(s)`,
  };
}

/** 批量删除；部分 id 不存在则整体拒绝（原子性）。 */
export function deleteTodos(
  snapshot: TodoSnapshot,
  ids: readonly number[],
): { snapshot: TodoSnapshot; resultText: string } {
  if (ids.length === 0) {
    throw new Error('delete requires ids parameter (non-empty array). Correct: {"action":"delete","ids":[1]}');
  }
  for (const id of ids) {
    if (!snapshot.todos.some((t) => t.id === id)) throw new Error(`Todo #${id} not found`);
  }
  const removed = new Set(ids);
  return {
    snapshot: { todos: snapshot.todos.filter((t) => !removed.has(t.id)), nextId: snapshot.nextId },
    resultText: `Deleted ${ids.length} todo(s)`,
  };
}

export interface TodoActionResult {
  action: TodoActionParams["action"];
  snapshot: TodoSnapshot;
  resultText: string;
}

/**
 * 参数 → 动作。必填校验与双形陷阱都在这里（schema 字段全 Optional，见
 * lib/todo-extension.ts 的 OpenAI 兼容说明）：失败直接 throw，不返回「错误成功模式」。
 */
export function dispatchTodoAction(
  params: TodoActionParams,
  snapshot: TodoSnapshot,
): TodoActionResult {
  switch (params.action) {
    case "list":
      return { action: "list", snapshot, resultText: formatTodoList(snapshot.todos) };

    case "add": {
      if (params.text !== undefined && params.texts !== undefined) {
        throw new Error('add only accepts texts array; do not also pass singular "text"');
      }
      if (params.texts === undefined || params.texts.length === 0) {
        if (params.text !== undefined) {
          throw new Error(
            'add needs texts (array). You passed singular "text" — that field is for update. '
            + 'Correct: {"action":"add","texts":["<your text>"]}',
          );
        }
        throw new Error('add requires texts parameter (non-empty array). Correct: {"action":"add","texts":["..."]}');
      }
      const { snapshot: next, resultText } = addTodos(snapshot, params.texts);
      return { action: "add", snapshot: next, resultText };
    }

    case "update": {
      // updates[] 优先于单条 id/status/text
      if (params.updates !== undefined && params.updates.length > 0) {
        const { snapshot: next, resultText } = updateTodos(snapshot, params.updates);
        return { action: "update", snapshot: next, resultText };
      }
      if (params.id === undefined) {
        throw new Error('update requires id parameter. Correct: {"action":"update","id":1,"status":"in_progress"}');
      }
      const single: { id: number; status?: string; text?: string }[] = [
        {
          id: params.id,
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(params.text !== undefined ? { text: params.text } : {}),
        },
      ];
      const { snapshot: next, resultText } = updateTodos(snapshot, single);
      return { action: "update", snapshot: next, resultText };
    }

    case "delete": {
      if (params.ids === undefined || params.ids.length === 0) {
        if (params.id !== undefined) {
          throw new Error(
            'delete needs ids (array). You passed singular "id". Correct: {"action":"delete","ids":[1]}',
          );
        }
        throw new Error('delete requires ids parameter (non-empty array). Correct: {"action":"delete","ids":[1]}');
      }
      const { snapshot: next, resultText } = deleteTodos(snapshot, params.ids);
      return { action: "delete", snapshot: next, resultText };
    }

    default:
      throw new Error(`Unknown action: ${String((params as { action?: unknown }).action)}`);
  }
}
