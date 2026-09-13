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

// 文档版本号（全局一份）：每重建一次文档（历史截断）就 +1。
// 前端连接看板时核对：不一致 = 本地副本已过期（服务端压过历史）→ 强刷页面丢弃本地副本。
// 落库是为了重启后不误刷新；即使不落库方向也是安全的（只会多刷，不会漏刷）。
db.exec(`
  CREATE TABLE IF NOT EXISTS yjs_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
let yjsVersion = Number(db.prepare("SELECT value FROM yjs_meta WHERE key = 'version'").get()?.value ?? 0) || 0;

/** 当前文档版本号（全局）。 */
export function getYjsVersion() {
  return yjsVersion;
}

function bumpYjsVersion() {
  yjsVersion += 1;
  db.prepare(
    "INSERT INTO yjs_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(yjsVersion));
  return yjsVersion;
}

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
// 背景：Y.Doc 存的是 CRDT 操作日志（update 增量），每次 set 都 append，历史可胀到
// 几十 MB（实测 5 节点看板 → 6MB，99.9% 是已删条目的 tombstone），当前状态仅几 KB。
// onLoadDocument / onStoreDocument 全量读写这份日志 → 打开看板 / reconcile 秒级卡顿。
// yjs 没有「历史上限 / 自动裁剪」机制，GC 只丢已删条目的 content、条目骨架永久保留。
//
// 方案：重建——当前状态灌进一份全新 Y.Doc 再编码，历史归零（实测 17.68MB → 89.9KB）。
// 重建会丢弃合并基准（struct 身份全变），因此：
//   ① 严格窗口：有任何连接（客户端或后端直连）就整轮跳过；
//   ② 版本号 +1，前端连接时核对不一致即强刷页面，丢弃可能残留的旧副本
//      （否则旧 struct 会在重连时被合并回来，历史复活）。
// 每 5 分钟一轮（server.mjs 注册），命中窗口即执行。
// ============================================================================

/** 压缩阈值：小于该大小的文档不压（无收益白耗一次全量读写） */
export const YJS_COMPACT_MIN_BYTES = 512 * 1024;

let yjsCompacting = false;

/** 严格窗口：任何已加载文档有连接（WebSocket 客户端或后端直连）就不动手。
 *  失焦 / 空闲不算——重建必须保证没有任何端持有旧副本。 */
function hasAnyConnection() {
  const docs = hocuspocus?.hocuspocus?.documents;
  if (!docs) return false;
  for (const doc of docs.values()) if (doc.getConnectionsCount() > 0) return true;
  return false;
}

/** 重建：当前状态 → 全新 Y.Doc → 编码，历史（tombstone）归零。
 *  重编码（applyUpdate + encodeStateAsUpdate）对已是编码产物的 blob 恒等长，
 *  一个字节都压不掉；只有换一份新文档才能真正截断历史。 */
function rebuildBlob(blob) {
  const src = new Y.Doc();
  Y.applyUpdate(src, blob);
  const clean = new Y.Doc();
  for (const name of ["nodes", "edges", "view"]) {
    src.getMap(name).forEach((value, key) => clean.getMap(name).set(key, value));
  }
  const out = Y.encodeStateAsUpdate(clean);
  src.destroy();
  clean.destroy();
  return out;
}

/** 压缩所有超过阈值的看板 yjs 文档。返回 { compacted, skipped, error? }。 */
export async function compactYjsDocuments() {
  if (yjsCompacting) return { compacted: [], skipped: [], error: "already-running" };
  yjsCompacting = true;
  const compacted = [];
  const skipped = [];
  try {
    if (hasAnyConnection()) {
      skipped.push("(any-connection)");
      return { compacted, skipped, error: null };
    }
    // 只挑超过阈值的文档（同步 DB 查询，毫秒级）
    const rows = db
      .prepare("SELECT board_id FROM yjs_documents WHERE length(data) > ?")
      .all(YJS_COMPACT_MIN_BYTES);
    for (const { board_id } of rows) {
      try {
        const h = hocuspocus?.hocuspocus;
        const live = h?.documents?.get(board_id);
        if (live) {
          // 连接数含直连（getConnectionsCount = connections + directConnectionsCount）——
          // 只看 connections 会漏掉 reconcile 的直连，读到可能落后的 blob。
          if (live.getConnectionsCount() > 0) {
            skipped.push(board_id);
            continue;
          }
          // 内存仍驻留的文档：先 flush pending store（否则它写回时用全量历史覆盖刚重建的
          // blob）、再卸载。不卸载的话下次连接复用内存里的旧 doc（不重新 onLoadDocument）。
          if (h.debouncer?.isDebounced(`onStoreDocument-${board_id}`)) {
            await h.debouncer.executeNow(`onStoreDocument-${board_id}`);
          }
          await h.unloadDocument(live).catch(() => {});
          // 确认真的卸载了——没卸掉就重建，等于白做。
          if (h.documents.has(board_id)) {
            console.warn(`[yjs] compact ${board_id.slice(0, 8)} 跳过：文档未能卸载`);
            skipped.push(board_id);
            continue;
          }
        }
        const row = db.prepare("SELECT data FROM yjs_documents WHERE board_id = ?").get(board_id);
        if (!row) continue;
        const before = row.data.length;
        const clean = rebuildBlob(new Uint8Array(row.data));
        if (clean.length >= before) {
          skipped.push(board_id);
          continue;
        }
        db.prepare("UPDATE yjs_documents SET data = ?, updated = ? WHERE board_id = ?").run(
          Buffer.from(clean),
          Date.now(),
          board_id,
        );
        bumpYjsVersion();
        compacted.push({ boardId: board_id, before, after: clean.length });
        console.log(
          `[yjs] compact ${board_id.slice(0, 8)}: ${(before / 1024 / 1024).toFixed(2)}MB → ${(clean.length / 1024).toFixed(1)}KB`,
        );
      } catch (e) {
        console.warn(`[yjs] compact ${board_id} 异常:`, e instanceof Error ? e.message : e);
      }
      // 重建是同步重活（6MB 解压≈1.4s），逐板让出事件循环，避免一次焊死几秒。
      await new Promise((r) => setImmediate(r));
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
  getYjsVersion,
};
