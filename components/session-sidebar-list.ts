import type { SessionTimeGroup } from "@/lib/session-time-group";
import type { SessionInfo } from "@/lib/types";

/**
 * 侧栏会话列表的纯规则：段内排序、时间分组角标、行拖拽与归属落点判定。
 *
 * 只 `import type`（运行时零依赖；时间分组函数由调用方注入）——`node:test` 才能
 * 直接 import 本模块：node 的 ESM 解析既不给相对路径补扩展名，也不认 `@/` 别名。
 */

/** 侧栏会话树节点（全仓唯一一份定义，`SessionSidebar.tsx` 从这里 import）。 */
export interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

/**
 * 段内排序：置顶段整体在前，段内再按「运行中 → modified 降序」。
 * 运行中会话的 modified 由后端事件驱动写入，但 agent_start 的写入受 30s 扫描器窗口
 * 影响，所以前端自己保证浮顶：把 runningIds 当排序键（而不是拼在输入数组前面——
 * 那样会被这里的 modified 排序全量重排掉）。
 * 排序放在客户端做，服务端就不会用另一套键再排一遍。
 */
export function orderPinnedFirst<T extends SessionTreeNode>(
  nodes: readonly T[],
  runningIds?: ReadonlySet<string>,
): T[] {
  const byRunningThenModified = (a: T, b: T) => {
    const aRunning = runningIds?.has(a.session.id) ?? false;
    const bRunning = runningIds?.has(b.session.id) ?? false;
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return a.session.modified < b.session.modified
      ? 1
      : a.session.modified > b.session.modified
        ? -1
        : 0;
  };
  return [
    ...nodes.filter((n) => n.session.pinned).sort(byRunningThenModified),
    ...nodes.filter((n) => !n.session.pinned).sort(byRunningThenModified),
  ];
}

/**
 * 会话行能否作为拖拽源（改名 / 删除确认态一律禁拖）。
 * 注意：**不按 depth 关**——整行 `draggable={false}` 会连「拖到看板行 / 画布建卡」
 * 一起干掉：手动看板的落卡是新增内容（只有任务看板才按归属处理），所以深度判定
 * 只能放在落点里（见下 membershipDropAllowed）。
 */
export function sessionRowDraggable(ctx: { renaming: boolean; confirmDelete: boolean }): boolean {
  return !ctx.renaming && !ctx.confirmDelete;
}

/** 拖拽载荷：会话行在树里的深度（十进制字符串），与 text/session-title 并列由拖拽源写入。 */
export const SESSION_DEPTH_MIME = "text/session-depth";

/** 读回拖拽深度：缺失 / 非法 / 负数一律当作 0（旧载荷或非本侧栏来源 = 顶层行）。 */
export function parseSessionDepth(payload: string): number {
  const depth = Number.parseInt(payload, 10);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/**
 * 归属类落点是否接受该深度的行：只接受顶层行。会话归属按子树存（lib/task-store 的
 * 不变量——祖先还在任务里，子会话就留在任务里），单独把子会话移入 / 移出都会被服务端
 * 按子树归一化，拖了等于没反应。
 *
 * 谁算归属类落点（调用点必须与此一致）：
 *   · 聊天区「移出任务」、任务区「加入任务」= 归属变更；
 *   · **任务看板**落卡（侧栏看板行 / 画布落卡）也走服务端归属——add-session 路由先
 *     assign 再落卡——所以同样是归属变更，同样受此限；
 *   · **手动看板**（board.taskId 为空）落卡只是加卡片（新增内容，不归属），不受此限。
 */
export function membershipDropAllowed(depth: number): boolean {
  return depth === 0;
}

export interface SessionListItem<T extends SessionTreeNode> {
  node: T;
  /** 该行上方要渲染的时间分组小角标；null = 不打标签。 */
  header: SessionTimeGroup | null;
  /** 置顶段 → 非置顶段的分隔线画在这一行上方。 */
  pinDivider: boolean;
}

/**
 * 聊天区的行计划：时间分组角标 + 置顶段分隔线。
 * 置顶段不参与分组（置顶会话本就脱离时间顺序）；越过置顶分隔线后重新开始分组，
 * 分组标签只在同一段内换组时出现一次。**运行中浮顶的行也不打标签、不推进游标**：
 * 浮顶把更旧的行提到段首，给它打标签就会出现「昨天 → 今天 → … → 昨天」的重复角标。
 * `timeGroupOf` 由调用方注入 `sessionTimeGroup`（保持本模块零 runtime 依赖）。
 */
export function planSessionListItems<T extends SessionTreeNode>(
  nodes: readonly T[],
  runningIds: ReadonlySet<string>,
  now: number,
  timeGroupOf: (modified: string, now: number) => SessionTimeGroup,
): SessionListItem<T>[] {
  let lastGroup: SessionTimeGroup | null = null;
  return nodes.map((node, i) => {
    const isPinned = Boolean(node.session.pinned);
    const prevPinned = i > 0 && Boolean(nodes[i - 1]?.session.pinned);
    const startsUnpinned = !isPinned && (i === 0 || prevPinned);
    if (startsUnpinned) lastGroup = null;
    const group = isPinned || runningIds.has(node.session.id)
      ? null
      : timeGroupOf(node.session.modified, now);
    const header = group && group !== lastGroup ? group : null;
    if (group) lastGroup = group;
    return { node, header, pinDivider: prevPinned && !isPinned };
  });
}
