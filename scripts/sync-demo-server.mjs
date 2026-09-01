#!/usr/bin/env node
// ============================================================================
// 试点：tldraw sync 最小房间服务器（独立于 Next.js，端口 30144）
//   - ws + node:sqlite + @tldraw/sync-core(TLSocketRoom + SQLiteSyncStorage)
//   - 路由：ws://127.0.0.1:30144/connect/:roomId  → 客户端 join 房间
//   - 注入：POST /inject/:roomId  → 模拟后台派生边/补卡（room.updateStore）
//   - 持久化：.sync-demo/rooms.db（SQLiteSyncStorage，tablePrefix 按房间隔离）
// 启动：node scripts/sync-demo-server.mjs
// ============================================================================
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const core = require("@tldraw/sync-core");
const tlschema = require("@tldraw/tlschema");
const tldraw = require("tldraw");

const PORT = Number(process.env.SYNC_DEMO_PORT ?? 30144);
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", ".sync-demo");
mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = join(DATA_DIR, "rooms.db");

// ---- 自定义 shape props 校验器（纯 T.* 数据，内联避免 require TSX 组件）----
// 与 components/canvas/{SessionCardShape,StickyNoteShape,TaskCardShape}.tsx 保持一致
const T = tldraw.T;
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

const schema = tlschema.createTLSchema({
  shapes: {
    ...tlschema.defaultShapeSchemas,
    "session-card": { props: sessionCardProps },
    "sticky-note": { props: stickyNoteProps },
    "task-card": { props: taskCardProps },
  },
  bindings: { ...tlschema.defaultBindingSchemas },
  assets: { ...tlschema.defaultAssetSchemas },
});

// ---- 房间管理：每 roomId 一个 TLSocketRoom，SQLite 持久化（tablePrefix 隔离）----
const db = new DatabaseSync(DB_FILE);
const rooms = new Map();
let injectCounter = 0;

function safePrefix(roomId) {
  return `room_${roomId.replace(/[^a-zA-Z0-9_]/g, "_")}_`;
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  const storage = new core.SQLiteSyncStorage({
    sql: new core.NodeSqliteWrapper(db, { tablePrefix: safePrefix(roomId) }),
  });
  room = new core.TLSocketRoom({
    storage, schema, clientTimeout: 0,
    log: {
      warn: (...a) => console.log("[sync-demo:room] warn:", ...a),
      error: (...a) => console.log("[sync-demo:room] error:", ...a),
    },
  });
  rooms.set(roomId, room);
  return room;
}

// ---- HTTP + WS ----
const server = createServer((req, res) => {
  // 后台注入端点：POST /inject/:roomId?shape=geo|session-card|task-card
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/inject\/([^/]+)$/);
  if (req.method === "POST" && m) {
    const roomId = decodeURIComponent(m[1]);
    const type = url.searchParams.get("shape") ?? "geo";
    const room = getRoom(roomId);
    void injectShape(room, type).then(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, injected: type }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/connect\/([^/]+)$/);
  if (!m) {
    ws.close(1008, "bad path");
    return;
  }
  const roomId = decodeURIComponent(m[1]);
  const room = getRoom(roomId);
  // sessionId 必须复用客户端提供的（useSync 每次重连带固定 TAB_ID）——
  // 若每次随机生成，重连会被当成新会话，服务器端 session 堆积、协议错乱。
  const clientSessionId = url.searchParams.get("sessionId") ?? null;
  const sessionId = clientSessionId || randomUUID();

  // handleSocketConnect 内部会自动给 socket 挂 message/close/error 监听
  // （ws 库支持 addEventListener / EventTarget）。绝不手动再挂 ws.on("message")——
  // 否则每条消息处理两次 → push_result 双发 → 客户端 rebase 报错 → 重连死循环。
  room.handleSocketConnect({ sessionId, socket: ws, isReadonly: false });
  console.log(`[sync-demo] ${roomId}: client ${sessionId.slice(0, 8)} connected (${room.getNumActiveSessions()})`);
});

async function injectShape(room, type) {
  await room.updateStore((store) => {
    const geo = new tldraw.GeoShapeUtil().getDefaultProps();
    const idx = "a" + (++injectCounter); // 合法 IndexKey（fractional-indexing：a1, a2, ...）
    const shapes = {
      geo: {
        typeName: "shape", type: "geo",
        props: { ...geo, richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `后台注入 ${new Date().toLocaleTimeString()}` }] }] } },
      },
      "session-card": {
        typeName: "shape", type: "session-card",
        props: { sessionId: randomUUID(), title: `后台会话 ${new Date().toLocaleTimeString()}`, projectName: "demo", messageCount: 0, lastReply: "", phase: "idle", runningMs: 0, endedAt: 0, lastActivityAt: 0, stale: false, expanded: false, cwd: "", taskId: "", w: 340, h: 160, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0 },
      },
      "task-card": {
        typeName: "shape", type: "task-card",
        props: { cardId: randomUUID(), number: 1, name: "后台任务", readyStatus: "todo", execStatus: "not_started", priority: 0, expanded: false, w: 380, h: 270, expandedW: 0, expandedH: 0, collapsedW: 0, collapsedH: 0 },
      },
    };
    const sh = shapes[type] ?? shapes.geo;
    store.put({
      id: `shape:${randomUUID()}`,
      typeName: "shape",
      x: 60 + Math.random() * 400,
      y: 60 + Math.random() * 300,
      rotation: 0,
      index: idx,
      parentId: "page:page",
      isLocked: false,
      opacity: 1,
      meta: {},
      ...sh,
    });
  });
  console.log(`[sync-demo] injected ${type}`);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sync-demo] tldraw sync demo server on ws://127.0.0.1:${PORT}/connect/:roomId`);
  console.log(`[sync-demo] inject via POST /inject/:roomId?shape=geo|session-card|task-card`);
  console.log(`[sync-demo] db: ${DB_FILE}`);
});
