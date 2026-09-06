import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { boardAssetsDir } from "@/lib/board-assets-dir";

export const dynamic = "force-dynamic";

// GET /api/board-assets/[...path] — 读取上传的图片（只读服务，不列目录）。
// DELETE /api/board-assets/[...path] — 删除已上传的图片（回收磁盘文件，供删 ImageNode 时调用）。
// 安全：文件名由服务端 UUID 生成（route.ts），这里只放行「纯文件名」形式，
// 拒绝任何目录穿越 / 子路径 / 非图片扩展名。
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

type Params = { params: Promise<{ path: string[] }> };

/** 解析并校验单个文件名段（拒绝目录穿越/子路径/非图片扩展名）；不合法返回 null。 */
function resolveAssetName(segments: string[] | undefined): string | null {
  // 只允许单个文件名段（UUID.ext），拒绝目录结构
  if (!segments || segments.length !== 1 || !segments[0]) return null;
  const name = segments[0];
  if (name.includes("/") || name.includes("\\") || name.includes("..") || name === ".") return null;
  if (!ALLOWED_EXT.has(path.extname(name).toLowerCase())) return null;
  return name;
}

export async function GET(_request: NextRequest, { params }: Params) {
  const name = resolveAssetName((await params).path);
  if (!name) {
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
  }[path.extname(name).toLowerCase()];

  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": mime ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

// DELETE /api/board-assets/[...path] — 按文件名删除已上传图片（与 GET 同校验）。
// 文件不存在幂等 404；前端删 ImageNode 时的接线（无其他节点引用才删）后续批次做。
export async function DELETE(_request: NextRequest, { params }: Params) {
  const name = resolveAssetName((await params).path);
  if (!name) {
    return new NextResponse("Not found", { status: 404 });
  }

  const filePath = path.join(boardAssetsDir(), name);
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new NextResponse("Not found", { status: 404 });
    }
    return NextResponse.json({ error: "delete failed" }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
