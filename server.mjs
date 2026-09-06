// ============================================================================
// 自定义 Next.js server：HTTP 交 Next，WebSocket 升级分流
//   - HTTP/HTTPS：next.getRequestHandler()（页面/API/HMR 全走 Next）
//   - WS upgrade：/connect → 内嵌 yjs 协同房间（Hocuspocus，每看板一个 Y.Doc）
//                其余（/_next/webpack-hmr 等）→ next.getUpgradeHandler()
//   - 启动：npm run dev / npm start（均走本文件，单进程同端口）
// ============================================================================
import { createServer } from "node:http";
import next from "next";
import { handleYjsUpgrade, compactYjsDocuments } from "./lib/yjs-room-server.mjs";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 30143);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const server = createServer((req, res) => handle(req, res));

// WebSocket 升级分流：yjs 房间优先，其余（HMR）交给 Next
server.on("upgrade", (req, socket, head) => {
  if (handleYjsUpgrade(req, socket, head)) return;
  app.getUpgradeHandler()(req, socket, head).catch((err) => {
    console.error("[server] upgrade error:", err);
    socket.destroy();
  });
});

await app.prepare();
server.listen(port, hostname, () => {
  console.log(`> Pi Web ready on http://${hostname}:${port} (dev=${dev})`);
  console.log(`> yjs sync rooms embedded on ws://${hostname}:${port}/connect`);
});

// ---- yjs 文档历史定期压缩（治理看板卡顿）----
// 启动后跑一次 + 每天定时跑；只压无活跃连接的看板（不踢正在编辑的用户），防重叠。
const YJS_COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;
setTimeout(() => {
  compactYjsDocuments().catch((e) => console.warn("[yjs] compact 启动扫描异常:", e?.message ?? e));
}, 15_000).unref?.();
setInterval(() => {
  compactYjsDocuments().catch((e) => console.warn("[yjs] compact 定时异常:", e?.message ?? e));
}, YJS_COMPACT_INTERVAL_MS).unref?.();
