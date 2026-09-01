// ============================================================================
// tldraw sync 房间服务器核心（可内嵌 Next.js server，也可独立进程）
//   - 每看板一个 TLSocketRoom + SQLiteSyncStorage（sync.db，tablePrefix 按 board 隔离）
//   - 纯文档同步：不懂业务，派生边/补卡由前端 reconcile（读业务数据 → CRDT 写文档）
//   - 自定义 shape（session-card / task-card / sticky-note）两端注册
//
// 用法（内嵌）：server.on("upgrade", handleSyncUpgrade) —— 返回 false 表示未处理，调用方转交 Next
// 用法（独立）：见 scripts/sync-server.mjs
// ============================================================================
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, normalize } from "node:path";

const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer } = require("ws");
const core = require("@tldraw/sync-core");
const tlschema = require("@tldraw/tlschema");
const T = require("@tldraw/validate").T;

// ---- agent dir（与 lib/sqlite-db.ts 同语义）----
export function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    const expanded = envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
    return normalize(expanded);
  }
  return join(homedir(), ".pi", "agent");
}
export const SYNC_DB_FILE = join(getAgentDir(), "sync.db");

// ---- 自定义 shape props 校验器（与 components/canvas/{SessionCardShape,StickyNoteShape,TaskCardShape}.tsx 保持一致）----
const sessionCardProps = {
  sessionId: T.string, title: T.string, projectName: T.string,
  messageCount: T.number, lastReply: T.string, phase: T.string,
  runningMs: T.number, endedAt: T.number, lastActivityAt: T.number,
  stale: T.boolean, expanded: T.boolean, cwd: T.string, taskId: T.string,
  w: T.number, h: T.number, expandedW: T.number, expandedH: T.number,
  collapsedW: T.number, collapsedH: T.number,
};
const stickyNoteProps = {
  text: T.string, w: T.number, h: T.number,
  badge: T.string.optional(), createdAt: T.number.optional(),
};
const taskCardProps = {
  cardId: T.string, number: T.number, name: T.string,
  readyStatus: T.string, execStatus: T.string, priority: T.number,
  due: T.number.optional(), expanded: T.boolean,
  w: T.number, h: T.number, expandedW: T.number, expandedH: T.number,
  collapsedW: T.number, collapsedH: T.number,
};

export const syncSchema = tlschema.createTLSchema({
  shapes: {
    ...tlschema.defaultShapeSchemas,
    "session-card": { props: sessionCardProps },
    "sticky-note": { props: stickyNoteProps },
    "task-card": { props: taskCardProps },
  },
  bindings: { ...tlschema.defaultBindingSchemas },
  assets: { ...tlschema.defaultAssetSchemas },
});

// ---- 房间管理：每 boardId 一个 TLSocketRoom；SQLite 持久化（同一 sync.db，tablePrefix 隔离）----
// 单一 DatabaseSync 连接（node:sqlite 同步，单连接线程安全）
const db = new DatabaseSync(SYNC_DB_FILE);
const rooms = new Map();

function safePrefix(boardId) {
  return `board_${boardId.replace(/[^a-zA-Z0-9_]/g, "_")}_`;
}

export function getSyncRoom(boardId) {
  let room = rooms.get(boardId);
  if (room) return room;
  const storage = new core.SQLiteSyncStorage({
    sql: new core.NodeSqliteWrapper(db, { tablePrefix: safePrefix(boardId) }),
  });
  room = new core.TLSocketRoom({
    storage, schema: syncSchema, clientTimeout: 0,
    log: {
      warn: (...a) => console.warn("[sync:room]", ...a),
      error: (...a) => console.error("[sync:room]", ...a),
    },
  });
  rooms.set(boardId, room);
  return room;
}

export function getSyncRoomCount() {
  return rooms.size;
}

// noServer WSS：不做端口监听，只负责把 upgrade 的 net.Socket 握手成 ws 实例
const wss = new WebSocketServer({ noServer: true });

/**
 * 处理一条 WebSocket upgrade 请求（挂在 Node http server 的 "upgrade" 事件）。
 * 路径匹配 /connect/:boardId → 房间接管；否则返回 false（调用方转交 Next 自身 handler，如 HMR）。
 * @returns {boolean} 是否已处理
 */
export function handleSyncUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return false;
  }
  const m = url.pathname.match(/^\/connect\/([^/]+)$/);
  if (!m) return false;

  const boardId = decodeURIComponent(m[1]);
  const room = getSyncRoom(boardId);
  // sessionId 必须复用客户端提供的（useSync 每次重连带固定 TAB_ID）——
  // 若随机生成，重连被当成新会话，服务器端 session 堆积、协议错乱。
  const sessionId = url.searchParams.get("sessionId") ?? randomUUID();

  // 握手成功后 ws 即为 EventTarget 兼容实例；handleSocketConnect 自动挂
  // message/close/error 监听。绝不手动再 ws.on("message")——否则每条消息处理
  // 两次 → push_result 双发 → 重连死循环。
  wss.handleUpgrade(req, socket, head, (ws) => {
    room.handleSocketConnect({ sessionId, socket: ws, isReadonly: false });
    console.log(`[sync] ${boardId}: client ${sessionId.slice(0, 8)} connected (${room.getNumActiveSessions()})`);
  });
  return true;
}
