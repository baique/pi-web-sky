/**
 * 会话 TODO 内联扩展 —— 由 pi-web-sky 在创建 AgentSession 时注入
 * （见 lib/rpc-manager.ts 的 `extensionFactories`），用户无需安装任何 pi 包。
 *
 * 职责：
 * - 注册 `todo` 工具（契约与 `@zhushanwen/pi-todo` 一致：list/add/update/delete）
 * - 每次变更把快照写入 custom entry `pi-todo.state`（顶栏面板的数据源）
 * - `session_start` / `session_tree` 回放最后一条快照重建状态（会话隔离靠工厂闭包）
 * - auto-clear：全部完成后再过 2 轮自动清空并复位 nextId（轮数从分支重算）
 * - 节奏提醒：连续 4 轮没用 todo 工具且仍有未完成项时，在 `context` 事件里注入
 *   **瞬时**提醒（不落盘、不进会话文件、聊天界面不出现卡片）；轮数在回放时
 *   从分支续算，不受 AgentSession 空闲回收影响
 *
 * 刻意不做：`before_agent_start` 返回 custom_message / completion-steer 等落盘注入。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  dispatchTodoAction,
  formatTodoLine,
  hasOpenTodos,
  parseTodoSnapshot,
  TODO_STATE_CUSTOM_TYPE,
  TODO_TOOL_NAME,
  VALID_STATUSES,
  type Todo,
  type TodoActionParams,
  type TodoSnapshot,
} from "./todo-store";

/** 全部完成后再保留的轮数，之后自动清空。 */
export const AUTO_CLEAR_DELAY_ROUNDS = 2;

/** 连续多少轮没用 todo 工具才提醒一次。 */
export const REMINDER_INTERVAL = 4;

// ── auto-clear ──────────────────────────────────────

/** `getBranch()` 的最小结构（只读三个字段，不依赖 SDK 的联合类型）。 */
export interface BranchEntry {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string };
}

/**
 * `agent_end` 时求值：分支上最后一条快照处于「全部完成」，且其后已过去
 * AUTO_CLEAR_DELAY_ROUNDS 条用户消息 → 清空。
 *
 * 为什么不记内存计数器：pi-web 的 AgentSession 空闲 10 分钟即销毁（见
 * lib/rpc-manager.ts 的 idle timer），扩展闭包里的计数活不过两次交互的间隔，
 * 真实使用中「2 轮」几乎永远数不满（实测：全完成后 7 轮过去仍未清空）。
 * 分支是持久的，重算一次 O(分支长度)，且 agent_end 本来就每轮只跑一次。
 */
export function shouldAutoClear(entries: readonly BranchEntry[]): boolean {
  let userMessages = 0;
  let snapshot: unknown;
  let snapshotAt = 0;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE) {
      snapshot = entry.data;
      snapshotAt = userMessages;
    } else if (entry.message?.role === "user") {
      userMessages++;
    }
  }

  const parsed = parseTodoSnapshot(snapshot);
  if (!parsed || parsed.todos.length === 0 || hasOpenTodos(parsed.todos)) return false;
  return userMessages - snapshotAt >= AUTO_CLEAR_DELAY_ROUNDS;
}

/**
 * 分支上「最后一次改 todo」（最后一条快照 entry）之后又过了几个模型回合。
 *
 * 只认快照、不认 `todo list`：`list` 不落盘，分支上看不到（同一实例内的即时重置
 * 另外靠 `noteToolResult` 处理）。
 *
 * 计的是**模型回合**（assistant 消息）而不是 user 消息：提醒要盯的是「一次长任务里
 * 模型自己跑偏了」，一条 user 消息下可能跑十几个回合，按 user 消息数永远数不满。
 * 计数单位与 `onTurnStart` 一致（turn_start = 一次模型往返）。
 */
export function turnsSinceLastTodoUse(entries: readonly BranchEntry[]): number {
  let turns = 0;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE) {
      turns = 0;
      continue;
    }
    if (entry.message?.role === "assistant") turns++;
  }
  return turns;
}

// ── 节奏提醒（纯函数，可单测）──────────────────────────

export interface ReminderState {
  /** 已经过的对话轮数（`turn_start` 自增）。 */
  currentTurn: number;
  /** 上一次用 todo 工具、或上一次发出提醒时的轮数。 */
  lastTodoToolUseTurn: number;
}

export function createReminderState(): ReminderState {
  return { currentTurn: 0, lastTodoToolUseTurn: 0 };
}

export function resetReminderState(state: ReminderState): void {
  Object.assign(state, createReminderState());
}

export function onTurnStart(state: ReminderState): void {
  state.currentTurn++;
}

/** 用了 todo 工具就重置节奏（下次提醒重新从 0 起算）。 */
export function noteToolResult(state: ReminderState, toolName: string): void {
  if (toolName === TODO_TOOL_NAME) state.lastTodoToolUseTurn = state.currentTurn;
}

/**
 * `context` 事件时求值：距上次 todo 工具使用已过 REMINDER_INTERVAL 轮且有未完成项 → 取走
 * 一次提醒配额。
 *
 * 求值点必须在 `context`（每轮 LLM 请求前都到），不能只在 `tool_result` 里 arm：
 * 纯文本轮（模型没调任何工具）不发 `tool_result`，那样的回合永远不会触发提醒。
 * 取走配额即把计时器推到当前轮 —— 这保证一个周期只提醒一次。
 *
 * 叫 take 而不是 should：它写 `state.lastTodoToolUseTurn`，是有副作用的取配额动作。
 */
export function takeReminderSlot(state: ReminderState, hasOpenWork: boolean): boolean {
  if (!hasOpenWork) return false;
  if (state.currentTurn - state.lastTodoToolUseTurn < REMINDER_INTERVAL) return false;
  state.lastTodoToolUseTurn = state.currentTurn;
  return true;
}

/** 由当前 open todo 构造瞬时提醒正文；没有未完成项时返回 null（调用方不得注入）。 */
export function buildReminder(todos: readonly Todo[]): string | null {
  const open = todos.filter((t) => t.status !== "completed");
  if (open.length === 0) return null;

  const inProgress = open.filter((t) => t.status === "in_progress");
  const focus = inProgress.length > 0
    ? `#${inProgress[0].id}（"${inProgress[0].content}"）仍标记为 in_progress。这一步如果已经做完，立刻用 todo update 把它标成 completed，并在同一次调用里把下一项 pending 置为 in_progress，不要留下过期的 [~]。`
    : "还有 pending 项但没有任何 in_progress。准备继续动手前，先用 todo update 把其中一项置为 in_progress。";

  return [
    "<system-reminder>",
    `todo 工具已连续 ${REMINDER_INTERVAL} 轮没有被使用，但仍有未完成任务：`,
    "",
    ...open.map(formatTodoLine),
    "",
    focus,
    "",
    "只在与本轮工作相关时行动；这是一条温和提醒，不适用就忽略。绝不要向用户提及这条提醒，也不要为了回应它而新造任务。",
    "</system-reminder>",
  ].join("\n");
}

// ── 工具 schema（扁平 Type.Object，OpenAI 兼容）──────────

// 顶层必须是 type:"object"（严格网关会 400 掉顶层 union）。字段全 Optional，
// 必填与 text/texts、id/ids 双形陷阱交给 dispatchTodoAction 运行时校验。
const TodoParams = Type.Object(
  {
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("add"), Type.Literal("update"), Type.Literal("delete")],
      { description: "list | add | update | delete" },
    ),
    text: Type.Optional(Type.String({ description: "新文本，仅 update 使用（trim 后不可为空）" })),
    texts: Type.Optional(Type.Array(Type.String(), { description: "待添加的 todo 文本数组（仅 add 使用）" })),
    id: Type.Optional(Type.Number({ description: "要更新的 todo id" })),
    ids: Type.Optional(Type.Array(Type.Number(), { description: "要删除的 todo id 数组" })),
    status: Type.Optional(StringEnum(VALID_STATUSES, { description: "pending | in_progress | completed" })),
    updates: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Number({ description: "要更新的 todo id" }),
            status: Type.Optional(StringEnum(VALID_STATUSES)),
            text: Type.Optional(Type.String({ description: "新文本（trim 后不可为空）" })),
          },
          { additionalProperties: false },
        ),
        { description: "批量更新数组（优先于单条 id/status/text）" },
      ),
    ),
  },
  { additionalProperties: false },
);

// ── 扩展 ─────────────────────────────────────────────

export function createTodoExtension(): InlineExtension {
  return {
    name: "pi-web-todo",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      // 闭包内状态 → 每个 AgentSession 一份，天然会话隔离。
      const state: TodoSnapshot = { todos: [], nextId: 1 };
      const reminder = createReminderState();

      const persist = (): void => {
        pi.appendEntry(TODO_STATE_CUSTOM_TYPE, { todos: state.todos, nextId: state.nextId });
      };

      /**
       * 回放当前分支上最后一条快照（切分支/新会话时重建），并把提醒节奏续算到分支上
       * 已过去的回合数 —— 闭包计数器活不过 AgentSession 的 10 分钟空闲回收
       * （见 lib/rpc-manager.ts），不续算的话「隔几分钟问一句」永远数不到 4 轮。
       */
      const reconstruct = (ctx: ExtensionContext): void => {
        const branch = ctx.sessionManager.getBranch() as BranchEntry[];
        state.todos = [];
        state.nextId = 1;
        resetReminderState(reminder);
        for (const entry of branch) {
          if (entry.type !== "custom" || entry.customType !== TODO_STATE_CUSTOM_TYPE) continue;
          const restored = parseTodoSnapshot(entry.data);
          if (restored) {
            state.todos = restored.todos;
            state.nextId = restored.nextId;
          }
        }
        reminder.currentTurn = turnsSinceLastTodoUse(branch);
      };

      pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
      pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

      pi.on("agent_end", async (_event, ctx) => {
        // 没有未完成项时 shouldAutoClear 必为 false（末尾快照就是 state），
        // 提前返回省掉一次全分支遍历 —— 大多数会话根本没有 todo。
        if (state.todos.length === 0 || hasOpenTodos(state.todos)) return;
        if (!shouldAutoClear(ctx.sessionManager.getBranch() as BranchEntry[])) return;
        state.todos = [];
        state.nextId = 1;
        persist();
      });

      // ── 节奏提醒 ──────────────────────────────────
      pi.on("turn_start", async () => onTurnStart(reminder));

      pi.on("tool_result", async (event) => {
        noteToolResult(reminder, String((event as { toolName?: unknown }).toolName ?? ""));
      });

      // 瞬时注入：只改这一次请求的 messages，不进会话文件、不出现在聊天流。
      pi.on("context", async (event) => {
        if (!takeReminderSlot(reminder, hasOpenTodos(state.todos))) return undefined;
        const text = buildReminder(state.todos);
        if (!text) return undefined;
        return {
          messages: [
            ...event.messages,
            { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() },
          ],
        };
      });

      // ── 工具 ────────────────────────────────────
      pi.registerTool({
        name: TODO_TOOL_NAME,
        label: "Todo",
        description:
          "管理当前会话的 todo 列表。"
          + "\n\n动作："
          + "\n- list: 查看全部 todo"
          + "\n- add: 批量添加 todo（texts 数组）"
          + "\n- update: 按 id 更新 todo——status 和/或 text；批量用 updates[]"
          + "\n- delete: 按 id 删除 todo（ids 数组）"
          + "\n\n规则："
          + "\n- 同一时间只有一个 todo 处于 in_progress"
          + "\n- 完成一个 todo 立即标记 completed，不要攒到最后批量标记"
          + "\n- 未真正完成不得标记 completed：被阻塞或测试失败时保持 in_progress",
        promptSnippet: "用 todo 跟踪多步骤工作；记得为验证步骤（测试、类型检查）单独建 todo。",
        promptGuidelines: [
          "[Usage] 多步骤工作（3+步）时使用，AI 自发创建，无需用户触发",
          "[验证任务] 为测试 / 类型检查等验证步骤单独建 todo，完成前确保验证通过",
          "[批量优先] 完成多项任务时使用 updates[] 批量更新，减少工具调用次数",
          "[自动闭合] 全部完成后自动清理，无需手动 delete",
          "[Not for] 单步操作、简单对话",
        ],
        executionMode: "sequential",
        parameters: TodoParams,

        async execute(_toolCallId, params, signal) {
          if (signal?.aborted) throw new Error("Todo call aborted by signal.");

          const result = dispatchTodoAction(params as TodoActionParams, state);
          const mutated = result.action !== "list";
          if (mutated) {
            state.todos = result.snapshot.todos;
            state.nextId = result.snapshot.nextId;
            persist();
          }

          const text = mutated
            ? `${result.resultText}\n${state.todos.map((t) => formatTodoLine(t)).join("\n") || "No todos"}`
            : result.resultText;

          return {
            content: [{ type: "text" as const, text }],
            // 前端靠这份 details 做增量刷新（lib → hooks/useAgentSession.ts 的 tool_execution_end）。
            details: { action: result.action, todos: [...state.todos], nextId: state.nextId },
          };
        },
      });
    },
  };
}
