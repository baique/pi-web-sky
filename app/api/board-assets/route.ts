import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { boardAssetsDir } from "@/lib/board-assets-dir";

export const dynamic = "force-dynamic";

/** 允许的图片扩展名（白名单，防任意文件上传） */
const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 单张 10MB 上限

// POST /api/board-assets — 上传图片，返回 { url }。multipart 字段：file
export async function POST(request: NextRequest) {
  let form: FormData;
  try {
    form = await parseFormDataWithinLimit(request, MAX_ASSET_BYTES + 1024 * 1024);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Image too large (max 10MB)" }, { status: 413 });
    }
    return NextResponse.json({ error: "invalid form data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing file field" }, { status: 400 });
  }
  if (file.size > MAX_ASSET_BYTES) {
    return NextResponse.json({ error: "Image too large (max 10MB)" }, { status: 413 });
  }

  const ext = path.extname(file.name || "").toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 400 });
  }

  const dir = boardAssetsDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(dir, filename), buffer);

  return NextResponse.json({ url: `/api/board-assets/${filename}` }, { status: 201 });
}
