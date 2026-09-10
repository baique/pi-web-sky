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
import { mkdirSync } from "node:fs";
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

// 打开前必须确保目录存在：SQLite 打不开不存在的父目录（unable to open database file），
// 而本模块在 server.mjs import 时顶层立即执行，全新机器上 ~/.pi/agent 尚未被 SDK 创建。
mkdirSync(getAgentDir(), { recursive: true });

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

// ============================================================================
// 定期压缩（治理 yjs 文档历史堆积）
//
// 背景：Y.Doc 存的是 CRDT 操作日志（update 增量），每次 set 都 append、多 client
// 会话累积后历史可胀到几十 MB（实测 5 节点看板 → 21MB），而当前状态仅几 KB。
// onLoadDocument / onStoreDocument 全量读写这份日志 → 打开看板 / reconcile 秒级卡顿。
// yjs GC 只清 tombstone 且需所有 client 确认，跨 client 清理保守，实际几乎不清。
//
// 方案：重建无历史的干净快照写回（当前状态 → 新 Doc → encodeStateAsUpdate），
// 只压超过阈值文档；只压无活跃连接的看板（不踢正在编辑的用户）；
// 有连接者本轮跳过，下轮再来。低频调用（启动 + 定时）即可，防重叠。
// ============================================================================

/** 压缩阈值：小于该大小的文档不压（无收益白耗一次全量读写） */
export const YJS_COMPACT_MIN_BYTES = 512 * 1024;

let yjsCompacting = false;

/** 压缩所有超过阈值的看板 yjs 文档。返回 { compacted, skipped, error? }。 */
export async function compactYjsDocuments() {
  if (yjsCompacting) return { compacted: [], skipped: [], error: "already-running" };
  yjsCompacting = true;
  const compacted = [];
  const skipped = [];
  try {
    // 只挑超过阈值的文档（同步 DB 查询，毫秒级）
    const rows = db
      .prepare("SELECT board_id FROM yjs_documents WHERE length(data) > ?")
      .all(YJS_COMPACT_MIN_BYTES);
    for (const { board_id } of rows) {
      try {
        // 活跃连接判定：Hocuspocus 文档处于加载中（有客户端/直连）才跳过
        const live = hocuspocus?.hocuspocus?.documents?.get(board_id);
        const hasActive = Boolean(live && live.connections && live.connections.size > 0);
        if (hasActive) {
          skipped.push(board_id);
          continue;
        }
        // 无连接但内存仍驻留的文档（unloadImmediately:false 下要等 store debounce
        // 写回后才卸载）：先 flush 其 pending store、再卸载内存文档。否则① debounce
        // 的 onStoreDocument 会把全量历史写回覆盖刚压缩的 blob；② 下次客户端连接
        // 复用内存里的全量 doc（不重新 onLoadDocument），压缩对运行中的进程无效。
        // 卸载后下次连接重新 onLoadDocument，从紧凑 blob 加载。
        const h = hocuspocus?.hocuspocus;
        if (live && h) {
          if (h.debouncer?.isDebounced(`onStoreDocument-${board_id}`)) {
            await h.debouncer.executeNow(`onStoreDocument-${board_id}`);
          }
          await h.unloadDocument(live).catch(() => {});
        }
        const row = db.prepare("SELECT data FROM yjs_documents WHERE board_id = ?").get(board_id);
        if (!row) continue;
        const before = row.data.length;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(row.data));
        // 无损重编码：保留原 doc 的 struct 身份（含 tombstone），只重新编码写回。
        // 不要重建干净 Doc（fresh Y.Doc + 重新 set）——那会改变所有 struct 的
        // clientID/身份：UndoManager 的撤销栈记录旧 struct 范围，身份变了回滚
        // 全部失效（`!struct.deleted` 为 false 跳过），撤销/重做被整体破坏。
        // tombstone（已删 struct）是 CRDT 合并语义必需的，不能删；
        // 文档体积增长是协同正确性的代价，靠 encodeStateAsUpdate 重编码收敛冗余即可。
        const clean = Y.encodeStateAsUpdate(doc);
        if (clean.length >= before) continue; // 无收益不写
        db.prepare("UPDATE yjs_documents SET data = ?, updated = ? WHERE board_id = ?").run(
          Buffer.from(clean),
          Date.now(),
          board_id,
        );
        compacted.push({ boardId: board_id, before, after: clean.length });
        console.log(
          `[yjs] compact ${board_id.slice(0, 8)}: ${(before / 1024 / 1024).toFixed(2)}MB → ${(clean.length / 1024).toFixed(1)}KB`,
        );
      } catch (e) {
        console.warn(`[yjs] compact ${board_id} 异常:`, e instanceof Error ? e.message : e);
      }
    }
    return { compacted, skipped, error: null };
  } finally {
    yjsCompacting = false;
  }
}

// ---- 注入 globalThis（供 lib/board-reconcile.ts 调用，避免 Next 打包 node:sqlite）----
globalThis.__yjsBoard = {
  mutateBoard,
  destroyBoardDocument,
  compactYjsDocuments,
};
