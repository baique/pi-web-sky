#!/usr/bin/env node
// ============================================================================
// tldraw sync 房间服务器（独立进程，端口 30144）— 兜底用法
//   核心逻辑见 lib/sync-room-server.mjs（内嵌 Next.js server 时复用同一份）
//   通常无需单独启动：npm run dev / npm start 已内嵌同端口（30143）。
//   仅当你想把 sync 拆到独立进程时才用本脚本。
// 启动：node scripts/sync-server.mjs   （npm run sync）
// 健康：GET http://127.0.0.1:30144/health
// ============================================================================
import { createServer } from "node:http";
import { handleSyncUpgrade, getSyncRoomCount } from "../lib/sync-room-server.mjs";

const PORT = Number(process.env.SYNC_PORT ?? 30144);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: getSyncRoomCount() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// 独立进程场景：所有 upgrade 都交给 sync（没有 Next 的 HMR 等其它升级）
server.on("upgrade", (req, socket, head) => {
  if (handleSyncUpgrade(req, socket, head)) return;
  // 不匹配 /connect/:boardId 的升级：拒绝
  socket.destroy();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[sync] tldraw sync server on ws://127.0.0.1:${PORT}/connect/:boardId`);
});
