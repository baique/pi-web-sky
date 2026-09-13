import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// GET /api/yjs-version — yjs 文档全局版本号（重建一次 +1）。
//
// 用途：前端连接看板时核对。不一致 = 服务端期间压过历史（文档已重建），本地内存里的
// 旧副本已过期——必须丢弃，否则重连时旧 struct 会被同步回来（历史复活、重建白做）。
// 版本号由 server.mjs 注入的 __yjsBoard 提供（Next 不打包 node:sqlite）。
export async function GET() {
  const version = globalThis.__yjsBoard?.getYjsVersion?.() ?? 0;
  return NextResponse.json({ version }, { headers: { "Cache-Control": "no-store" } });
}
