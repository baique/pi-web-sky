/**
 * 会话看板类型定义（客户端/服务端共用，SDK-free）。
 * 只存布局与状态标记 —— 会话内容仍由 .jsonl 与 /api/sessions 提供。
 */

/** 系统看板固定 id：运行中（跨项目自动聚合，不可改名/删除）。 */
export const SYSTEM_RUNNING_BOARD_ID = "__running__";

export interface BoardInfo {
  id: string;
  projectKey: string;
  name: string;
  isSystem: boolean;
  /** 任务型看板：非空时即任务 id（看板 id = 任务 id）；手动看板为 null */
  taskId: string | null;
  /** 项目内手动排序（系统看板恒置顶） */
  sortOrder: number;
  created: number;
  updated: number;
  /** 节点数（列表展示用，不落库） */
  nodeCount: number;
}

export type BoardNodeKind = "session" | "shape" | "taskcard";

export interface BoardNode {
  id: string;
  boardId: string;
  kind: BoardNodeKind;
  /** sessionId（kind=session）；失效时 refId 仍保留但 session 不存在 */
  refId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  expanded: boolean;
  props: Record<string, unknown>;
  created: number;
  updated: number;
}

export interface BoardEdge {
  id: string;
  boardId: string;
  fromId: string;
  toId: string;
  label: string | null;
  color: string | null;
  dashed: boolean;
  created: number;
  updated: number;
}

export interface BoardView {
  boardId: string;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  updated: number;
}

/** GET /api/boards/[id]/canvas 响应（整张画布） */
export interface BoardCanvas {
  board: BoardInfo;
  nodes: BoardNode[];
  edges: BoardEdge[];
  view: BoardView | null;
}

/** 运行中会话细分状态（GET /api/agent/running 扩展） */
export type RunningPhase = "waiting_model" | "running_tools" | "running_command" | "waiting_input";

export interface RunningSessionState {
  phase: RunningPhase;
  /** 当前模型 `provider/modelId`（可能为空） */
  model: string | null;
  /** 本次运行开始时间（ms epoch；未知为 0） */
  startedAt: number;
}

export interface RunningSnapshot {
  runningSessionIds: string[];
  /** 细分状态：只含运行中的会话 id */
  states: Record<string, RunningSessionState>;
  /**
   * 任务卡状态（DB 唯一真相的展示镜像）。
   * 无参请求：返回调度器活跃态卡（running/review/waiting_reply，向后兼容左侧栏/旧消费方）。
   * 带 ?boardId=&cardIds=：返回这批可见卡的**全量**状态（含 failed/done/not_started），供画布徽章用。
   */
  taskCards: TaskCardRunningState[];
}

/** 任务卡状态（running 快照透传的画布可见卡状态；DB 是唯一真相源，此为展示镜像） */
export interface TaskCardRunningState {
  cardId: string;
  boardId: string;
  number: number;
  name: string;
  execStatus: string;
  readyStatus: string;
}
