// ============================================================================
// yjs 协同房间服务器（Hocuspocus 内嵌版）—— 替代 tldraw sync（TLSocketRoom）
//   - 每看板一个 Y.Doc（documentName = boardId），结构：nodes/edges/view 三个 Y.Map
//   - 持久化：SQLite（sync.db 独立表 yjs_documents），onStoreDocument 存全量 update
//   - 内嵌：server.mjs 的 upgrade 事件分流 —— 仅 /connect 走 crossws，其余交 Next
//   - 服务端权威写：openDirectConnection(boardId).transact() —— 派生 reconcile 用
//
// 用法（内嵌）：server.on("upgrade", handleYjsUpgrade) —— 返回 false 表示未处理
// ============================================================================
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { homedir } from "node:os";
import { join, normalize } from "node:path";

const { DatabaseSync } = require("node:sqlite");
const { Server } = require("@hocuspocus/server");
const Y = require("yjs");

// ---- agent dir（与 lib/sqlite-db.ts 同语义）----
export function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    const expanded = envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
    return normalize(expanded);
  }
  return join(homedir(), ".pi", "agent");
}
export const YJS_DB_FILE = join(getAgentDir(), "sync.db");

// 单一 DatabaseSync 连接（node:sqlite 同步，单连接线程安全）
const db = new DatabaseSync(YJS_DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS yjs_documents (
    board_id TEXT PRIMARY KEY,
    data     BLOB NOT NULL,
    updated  INTEGER NOT NULL
  );
`);

/** Hocuspocus server 实例（惰性创建） */
let hocuspocus = null;

/** 建（或复用）Hocuspocus server */
function getServer() {
  if (hocuspocus) return hocuspocus;
  hocuspocus = new Server({
    // 端口留给外部 httpServer，这里不 listen
    port: 0,
    // 客户端断开后延迟持久化再卸载
    unloadImmediately: false,
    // 文档变更持久化 debounce（默认 2s，配小一点让写库及时）
    debounce: 500,
    async onLoadDocument({ documentName, document }) {
      const row = db.prepare("SELECT data FROM yjs_documents WHERE board_id = ?").get(documentName);
      if (row) {
        try {
          Y.applyUpdate(document, new Uint8Array(row.data));
        } catch (e) {
          console.warn(`[yjs] ${documentName} onLoad 解码失败:`, e?.message ?? e);
        }
      }
    },
    async onStoreDocument({ documentName, document }) {
      const update = Y.encodeStateAsUpdate(document);
      db.prepare(
        "INSERT INTO yjs_documents (board_id, data, updated) VALUES (?, ?, ?) " +
          "ON CONFLICT(board_id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
      ).run(documentName, Buffer.from(update), Date.now());
    },
  });
  return hocuspocus;
}

/**
 * 处理一条 WebSocket upgrade 请求（挂在 Node http server 的 "upgrade" 事件）。
 * 仅 /connect 路径交 Hocuspocus（provider 的 name 参数 = documentName）；
 * 其余（Next HMR 等）返回 false，调用方转交 Next。
 * @returns {boolean} 是否已处理
 */
export function handleYjsUpgrade(req, socket, head) {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    return false;
  }
  if (url.pathname !== "/connect") return false;
  const server = getServer();
  server.crossws.handleUpgrade(req, socket, head).catch((e) => {
    console.error(`[yjs] /connect handleUpgrade 异常:`, e?.message ?? e);
    try { socket.destroy(); } catch { /* ignore */ }
  });
  return true;
}

/**
 * 服务端权威写：对指定看板执行一个事务（直接改 Y.Doc，不经 WebSocket）。
 * transaction(maps, doc) 内用 maps.nodes / maps.edges / maps.view 操作。
 * 变更自动经 Hocuspocus 广播到已连接客户端并持久化（onStoreDocument）。
 */
export async function mutateBoard(boardId, transaction) {
  const server = getServer();
  const dc = await server.hocuspocus.openDirectConnection(boardId);
  try {
    await dc.transact((document) => {
      const maps = {
        nodes: document.getMap("nodes"),
        edges: document.getMap("edges"),
        view: document.getMap("view"),
        ydoc: document,
      };
      transaction(maps, document);
    });
  } finally {
    await dc.disconnect().catch(() => {});
  }
}

/** 删除看板文档（删除看板时调用） */
export async function destroyBoardDocument(boardId) {
  const server = getServer();
  try {
    await server.hocuspocus.closeConnections(boardId);
    db.prepare("DELETE FROM yjs_documents WHERE board_id = ?").run(boardId);
  } catch (e) {
    console.warn(`[yjs] destroy ${boardId} 异常:`, e?.message ?? e);
  }
}

/** 当前加载中的文档数（诊断用） */
export function getYjsRoomCount() {
  return hocuspocus?.hocuspocus?.documents?.size ?? 0;
}

// ---- 注入 globalThis（供 lib/board-reconcile.ts 调用，避免 Next 打包 node:sqlite）----
globalThis.__yjsBoard = {
  mutateBoard,
  destroyBoardDocument,
};
