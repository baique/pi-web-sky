import path from "path";
import { getAgentDir } from "@/lib/sqlite-db";

/** 看板图片资产根目录：~/.pi/agent/board-assets/（与 pi-web.db 同级） */
export function boardAssetsDir(): string {
  return path.join(getAgentDir(), "board-assets");
}
