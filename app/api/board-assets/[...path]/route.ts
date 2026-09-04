import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { boardAssetsDir } from "../route";

export const dynamic = "force-dynamic";

// GET /api/board-assets/[...path] — 读取上传的图片（只读服务，不列目录）。
// 安全：文件名由服务端 UUID 生成（route.ts），这里只放行「纯文件名」形式，
// 拒绝任何目录穿越 / 子路径 / 非图片扩展名。
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

type Params = { params: Promise<{ path: string[] }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const segments = (await params).path ?? [];
  // 只允许单个文件名段（UUID.ext），拒绝目录结构
  if (segments.length !== 1 || !segments[0]) {
    return new NextResponse("Not found", { status: 404 });
  }
  const name = segments[0];
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name === ".") {
    return new NextResponse("Not found", { status: 404 });
  }
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const filePath = path.join(boardAssetsDir(), name);
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const mime = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
  }[ext];

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": mime ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
