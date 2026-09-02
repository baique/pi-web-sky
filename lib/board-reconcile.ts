// ============================================================================
// 看板派生 reconcile（后端权威）—— 替代前端 useBoardCanvas 的 reconcile
//
// 设计（方案 rev2 核心）：
//   - 业务表（tasks / task_cards / task_card_links / session_meta）= 唯一真相源，后端写
//   - 派生元素（会话卡存在性 / exec 线 / 依赖线 / 孤儿删）= 后端读业务表 → 增量写 Y.Doc
//   - 确定性 id 幂等：会话卡 `session-<sid>`、exec 线 `exec-<cardId>-<sessionId>`、
//     依赖线 `link-<fromShapeId>-<toShapeId>-<kind>` → 缺补多删，绝不整表覆盖
//   - 用户内容（布局/尺寸/便笺文本）由前端写 Y.Doc，本模块只动派生元素，不碰用户布局
//   - 孤儿删只删「业务表确认不存在的会话卡」，跳过新会话卡（cwd 非空 = 会话尚未创建）
//
// 触发：调度器写业务表后 / 任务归属变化 / 建卡删卡 / 定时兜底（见 board-reconcile-scheduler）
// ============================================================================
import { getBoard, listAllBoards } from "./board-store";
import { listTaskSessionIds } from "./task-store";
import { listCards, listLinks } from "./task-card-store";

// ---- yjs maps 类型 + mutateBoard（由 server.mjs 通过 globalThis 注入，避免 Next 打包 node:sqlite）----
interface BoardMaps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- yjs Map 泛型在服务端宽松处理（避免过度类型工程）
  nodes: import("yjs").Map<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edges: import("yjs").Map<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: import("yjs").Map<any>;
  ydoc: import("yjs").Doc;
}

declare global {
  var __yjsBoard: {
    mutateBoard: (boardId: string, transaction: (maps: BoardMaps) => void) => Promise<unknown>;
    destroyBoardDocument: (boardId: string) => Promise<void>;
  } | undefined;
}

const mutateBoard: (boardId: string, transaction: (maps: BoardMaps) => void) => Promise<unknown> =
  ((boardId: string, transaction: (maps: BoardMaps) => void) => {
    const yjs = globalThis.__yjsBoard;
    if (!yjs) return Promise.resolve(); // server.mjs 未加载（独立构建/测试环境）→ 跳过
    return yjs.mutateBoard(boardId, transaction);
  });

/** Y.Doc 节点（RF Node 形状的宽松类型） */
interface DocNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  style?: { width?: number; height?: number };
  data?: Record<string, unknown>;
}


// ---- 卡片尺寸（与前端组件对齐，作补卡摆位锚点）----
export const CARD_W = 340;
export const CARD_H = 160;
const FORM_W = 380;
const COLLAPSED_MIN_H = 240;

/** 会话卡默认尺寸（收合态） */
export const SESSION_CARD_W = CARD_W;
export const SESSION_CARD_H = CARD_H;

/** 任务卡 shape 尺寸（未建卡占位 / 已建卡） */
const TASK_CARD_W = FORM_W;
const TASK_CARD_H = COLLAPSED_MIN_H;

/** 判断 Y.Doc 中某节点是否为「新会话卡」（cwd 非空 = 会话尚未创建，跳过补卡/孤儿删） */
function isPendingNewSession(node: DocNode | undefined): boolean {
  const cwd = node?.data?.cwd;
  return Boolean(node && typeof cwd === "string" && cwd.length > 0);
}

/** 找空闲落点（4 列布局：每行 4 卡，逐行找空位）。与前端 findFreeSpot 同构。 */
function findFreeSpot(nodes: DocNode[], width = CARD_W, height = CARD_H) {
  const STEP = 24;
  const PER_ROW = 4;
  const occupied = nodes
    .filter((n) => n?.type === "session-card")
    .map((n) => ({
      x: n.position?.x ?? 0,
      y: n.position?.y ?? 0,
      w: n.style?.width ?? width,
      h: n.style?.height ?? height,
    }));
  const overlaps = (x: number, y: number) =>
    occupied.some((o) => x < o.x + o.w + STEP && x + width + STEP > o.x && y < o.y + o.h + STEP && y + height + STEP > o.y);
  let y = 60;
  let guard = 0;
  while (guard < 2000) {
    for (let col = 0; col < PER_ROW; col += 1) {
      const x = 60 + col * (width + STEP);
      if (!overlaps(x, y)) return { x, y };
    }
    y += height + STEP;
    guard += 1;
  }
  return { x: 60, y: 60 };
}

/**
 * 对单个看板执行派生 reconcile（幂等）。
 * 读业务表 → mutate Y.Doc：补/清会话卡、补/清 exec 线、补/清依赖线。
 * 仅任务看板（board.taskId 非空）有派生元素；普通看板跳过。
 */
export async function reconcileBoard(boardId: string): Promise<void> {
  const board = getBoard(boardId);
  if (!board?.taskId) return; // 普通看板：会话卡由用户拖入/新建管理，无派生
  const taskId = board.taskId;

  const sessionIds = listTaskSessionIds(taskId);
  const cards = listCards(boardId);
  // 全部会话 id（任务会话 + 任务卡执行会话）——执行会话卡必然存在（先有会话才有关联）
  const allSessionIds = new Set(sessionIds);
  for (const c of cards) if (c.sessionId) allSessionIds.add(c.sessionId);

  await mutateBoard(boardId, (maps) => {
    const nodesMap = maps.nodes;
    const edgesMap = maps.edges;
    const nodes = Array.from(nodesMap.values()) as unknown as DocNode[];

    // ---- 1) 会话卡：缺补、孤儿删 ----
    const existingSessionBySid = new Map(); // sid -> node（转正卡）
    const pendingSids = new Set(); // 新建中占位卡（cwd 非空）的 sid——视为「该 sid 已有卡，不补、不孤儿删」
    for (const n of nodes) {
      if (n?.type !== "session-card") continue;
      const sid = n.data?.sessionId;
      if (!sid) continue;
      // 新建中占位卡（cwd 非空）：不参与转正卡 map，也不做孤儿删；
      // 但它的 sid 要进 pendingSids——窗口期（服务端已 assign、前端尚未转正清 cwd）
      // 补卡循环应把该 sid 视为「已覆盖」，否则会补出第二张确定性 session-<sid> 卡。
      if (isPendingNewSession(n)) {
        pendingSids.add(sid);
        continue;
      }
      existingSessionBySid.set(sid, n);
    }
    // 孤儿删：画布有、业务表没有的会话卡（非新会话卡）→ 删
    // 例外：卡声明归属本板任务（data.taskId === 本板 taskId，拖入已存在会话时前端先落卡
    // 异步归属，归属完成前本板 reconcile 不能把它当孤儿删——否则用户刚拖的卡消失）
    const orphanIds = [];
    for (const [sid, n] of existingSessionBySid) {
      if (allSessionIds.has(sid)) continue;
      if (n.data?.taskId === taskId) continue;
      orphanIds.push(n.id);
    }
    for (const id of orphanIds) {
      nodesMap.delete(id);
      // 级联删以它为端点的边（exec/依赖/手绘线）
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === id || e.target === id) edgesMap.delete(e.id);
      }
    }
    // 缺卡补：业务表有、画布没有的会话卡 → 补（确定性 id，4 列布局落点）
    // 补全 allSessionIds（任务根会话 + 任务卡执行会话）——exec 线目标会话卡必须有节点。
    // 注意：不能因画布存在「新建中占位卡」（pendingNew，cwd 非空）就跳过补卡——
    // 那会让任务卡执行会话卡永远不补、exec 线断（历史 bug）。补卡 id 为确定性 session-<sid>，
    // 与随机 id 的占位卡不冲突、幂等。
    {
      const remaining = Array.from(nodesMap.values());
      for (const sid of allSessionIds) {
        // 已有转正卡 或 存在同 sid 新建中占位卡（窗口期视为已覆盖）→ 不补
        if (existingSessionBySid.has(sid) || pendingSids.has(sid)) continue;
        const id = `session-${sid}`;
        const spot = findFreeSpot(remaining);
        nodesMap.set(id, {
          id,
          type: "session-card",
          position: { x: spot.x, y: spot.y },
          style: { width: SESSION_CARD_W, height: SESSION_CARD_H },
          data: {
            sessionId: sid,
            title: "",
            projectName: "",
            messageCount: 0,
            lastReply: "",
            phase: "idle",
            runningMs: 0,
            endedAt: 0,
            lastActivityAt: 0,
            stale: false,
            expanded: false,
            cwd: "",
            taskId: "",
            w: SESSION_CARD_W,
            h: SESSION_CARD_H,
            expandedW: 0,
            expandedH: 0,
            collapsedW: 0,
            collapsedH: 0,
          },
        });
        remaining.push(nodesMap.get(id));
      }
    }

    // ---- 1.5) 任务卡节点补齐：业务表存在、画布无对应节点 → 补（exec 线锚点）----
    // 任务卡由用户从工具栏拖出创建；业务表已存在的卡（外部建卡/历史数据）自动入板。
    // 确定性 id（task-<cardId>）→ 幂等；孤儿任务卡节点（业务表已删）→ 删。
    const existingCardByCardId = new Map(); // cardId -> node
    for (const n of nodes) {
      if (n?.type === "task-card" && n.data?.cardId) existingCardByCardId.set(n.data.cardId, n);
    }
    // 孤儿任务卡：画布有 cardId 但业务表没有 → 删节点（级联删边）
    const knownCardIds = new Set(cards.map((c) => c.id));
    const orphanCardIds = [];
    for (const [cid, n] of existingCardByCardId) {
      if (!knownCardIds.has(cid)) orphanCardIds.push(n.id);
    }
    for (const id of orphanCardIds) {
      nodesMap.delete(id);
      for (const e of Array.from(edgesMap.values())) {
        if (e.source === id || e.target === id) edgesMap.delete(e.id);
      }
    }
    // 缺卡补：业务表有、画布没有 → 补（form 尺寸，4 列布局）
    {
      const remaining = Array.from(nodesMap.values()) as unknown as DocNode[];
      for (const card of cards) {
        if (existingCardByCardId.has(card.id)) continue;
        const id = `task-${card.id}`;
        const spot = findFreeSpot(remaining, TASK_CARD_W, TASK_CARD_H);
        nodesMap.set(id, {
          id,
          type: "task-card",
          position: { x: spot.x, y: spot.y },
          style: { width: TASK_CARD_W, height: TASK_CARD_H },
          data: {
            cardId: card.id,
            number: card.number,
            name: card.name,
            description: card.description,
            readyStatus: card.readyStatus,
            execStatus: card.execStatus,
            priority: card.priority,
            due: card.due ?? undefined,
            expanded: false,
            w: TASK_CARD_W,
            h: TASK_CARD_H,
            expandedW: 0,
            expandedH: 0,
            collapsedW: 0,
            collapsedH: 0,
          },
        });
        remaining.push(nodesMap.get(id));
      }
    }

    // ---- 2) exec 线：任务卡 sessionId → 卡节点 + 会话节点 → 建线 ----
    // 卡 shape：cardId 映射到节点
    const cardShapes = new Map(); // cardId -> node
    for (const n of Array.from(nodesMap.values()) as unknown as DocNode[]) {
      if (n?.type === "task-card" && n.data?.cardId) cardShapes.set(n.data.cardId, n);
    }
    const sessionShapes = new Map(); // sid -> node（含刚补的）
    for (const n of Array.from(nodesMap.values())) {
      if (n?.type === "session-card" && n.data?.sessionId) sessionShapes.set(n.data.sessionId, n);
    }
    // 现有 exec 线按 from 卡节点分组
    const execByCard = new Map<string, Array<{ to: string | null; edgeId: string }>>(); // fromShapeId -> [{ to, edgeId }]
    for (const e of Array.from(edgesMap.values())) {
      if (!e.data?.execLink) continue;
      const from = e.source;
      const list = execByCard.get(from) ?? [];
      list.push({ to: e.target, edgeId: e.id });
      execByCard.set(from, list);
    }
    for (const card of cards) {
      const cardShape = cardShapes.get(card.id);
      if (!cardShape) continue;
      const wanted = card.sessionId ? sessionShapes.get(card.sessionId) : null;
      const existing = execByCard.get(cardShape.id) ?? [];
      // 删端点不匹配的旧线（卡 sessionId 变了 / 已清空）
      for (const e of existing) {
        if (e.to !== (wanted?.id ?? null)) edgesMap.delete(e.edgeId);
      }
      if (!wanted || existing.some((e) => e.to === wanted.id)) continue;
      const id = `exec-${card.id}-${card.sessionId}`;
      edgesMap.set(id, {
        id,
        source: cardShape.id,
        target: wanted.id,
        type: "default",
        data: { execLink: true, cardId: card.id, sessionId: card.sessionId },
        markerEnd: { type: "arrowclosed" },
        style: { strokeWidth: 1.5, stroke: "#3184f8", strokeDasharray: "6 4" },
      });
    }

    // ---- 3) 依赖线：task_card_links → 建线（缺补多删）----
    const existingLinks = new Map(); // "<from>-><to>:<kind>" -> edgeId
    for (const e of Array.from(edgesMap.values())) {
      if (!e.data?.taskLink) continue;
      const from = e.source;
      const to = e.target;
      const kind = e.data.taskLink;
      if (from && to && kind) existingLinks.set(`${from}->${to}:${kind}`, e.id);
    }
    const wantLinks = new Set();
    for (const card of cards) {
      const fromShape = cardShapes.get(card.id);
      if (!fromShape) continue;
      for (const link of listLinks(card.id)) {
        const toShape = cardShapes.get(link.targetCardId);
        if (!toShape) continue;
        const key = `${fromShape.id}->${toShape.id}:${link.kind}`;
        wantLinks.add(key);
        if (!existingLinks.has(key)) {
          const id = `link-${fromShape.id}-${toShape.id}-${link.kind}`;
          edgesMap.set(id, {
            id,
            source: fromShape.id,
            target: toShape.id,
            type: "default",
            data: { taskLink: link.kind },
            markerEnd: { type: "arrowclosed" },
            style: { strokeWidth: 1.5, stroke: "#f59e0b" },
          });
        }
      }
    }
    for (const [key, edgeId] of existingLinks) {
      if (!wantLinks.has(key)) edgesMap.delete(edgeId);
    }
  });
}

/**
 * 任务下新建的会话入板（需求 2：外部/本页新建会话自动加入任务看板）。
 * 调度器 assignSessionToTask 后调用：补一张会话卡到对应任务看板。
 * 幂等（确定性 id）；看板不存在（任务看板未创建）时静默跳过。
 */
export async function ensureTaskSessionCard(boardId: string, sessionId: string): Promise<void> {
  const board = getBoard(boardId);
  if (!board?.taskId) return;
  await mutateBoard(boardId, (maps) => {
    const nodesMap = maps.nodes;
    const nodes = Array.from(nodesMap.values());
    const id = `session-${sessionId}`;
    if (nodesMap.has(id)) return;
    const spot = findFreeSpot(nodes);
    nodesMap.set(id, {
      id,
      type: "session-card",
      position: { x: spot.x, y: spot.y },
      style: { width: SESSION_CARD_W, height: SESSION_CARD_H },
      data: {
        sessionId,
        title: "",
        projectName: "",
        messageCount: 0,
        lastReply: "",
        phase: "idle",
        runningMs: 0,
        endedAt: 0,
        lastActivityAt: 0,
        stale: false,
        expanded: false,
        cwd: "",
        taskId: "",
        w: SESSION_CARD_W,
        h: SESSION_CARD_H,
        expandedW: 0,
        expandedH: 0,
        collapsedW: 0,
        collapsedH: 0,
      },
    });
  });
}

/**
 * 从所有 RF 看板的 yjs 文档中删除指定会话的会话卡（含占位卡）并级联删边。
 *
 * 背景：会话删除（单删 / 删任务整树）只走 removeSessionFromBoards 清 tldraw 遗留的
 * board_nodes 废弃表，对 RF 画布（yjs Y.Doc）无效——任务看板由 10s reconcile 兜底删，
 * 普通看板 reconcileBoard 直接 return，会话卡永久残留（幽灵卡）。
 *
 * 定位：会话卡落在哪块看板没有反向索引，只能枚举全部看板逐个扫（低频操作可接受；
 * 维护反向索引属过度设计）。幂等：板上没有匹配卡时无变更。
 */
export async function removeSessionsFromYjsBoards(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const yjs = globalThis.__yjsBoard;
  if (!yjs) return; // server.mjs 未加载（独立构建/测试环境）→ 跳过
  const targets = new Set(sessionIds);
  for (const board of listAllBoards()) {
    try {
      await yjs.mutateBoard(board.id, (maps) => {
        const nodesMap = maps.nodes;
        const edgesMap = maps.edges;
        const hitIds: string[] = [];
        for (const n of Array.from(nodesMap.values()) as unknown as DocNode[]) {
          if (n?.type === "session-card" && n.data?.sessionId && targets.has(String(n.data.sessionId))) {
            hitIds.push(n.id);
          }
        }
        if (hitIds.length === 0) return;
        for (const id of hitIds) {
          nodesMap.delete(id);
          for (const e of Array.from(edgesMap.values())) {
            if (e.source === id || e.target === id) edgesMap.delete(e.id);
          }
        }
      });
    } catch (e) {
      // 单板清理失败不中断其余板（也绝不拖垮会话删除主流程）
      console.warn(`[board] 会话删除清理 yjs 板 ${board.id} 异常:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * 删除看板的 yjs 文档（业务行删完后调用）。
 * deleteBoard/deleteTask 只清 boards/board_nodes 等业务表，yjs_documents 行残留会导致
 * 看板 id 复用时旧文档复活；此处同时断开该看板的活动连接。
 */
export async function destroyBoardYjsDocument(boardId: string): Promise<void> {
  const yjs = globalThis.__yjsBoard;
  if (!yjs) return;
  await yjs.destroyBoardDocument(boardId);
}
