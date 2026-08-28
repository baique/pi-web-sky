import { closeSync, openSync, readSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { join as joinPath } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 轻量会话列表扫描：只读取每个 jsonl 的「头部」（session header + 首条用户
 * 消息简述）和「尾部」（重命名后的 session_info），中间的消息内容一律不读，
 * 最后活动时间直接用文件 mtime。列表展示只需要标题 + 时间，读全量消息是
 * 纯浪费（大会话文件会把一次列表刷新拖到秒级以上）。
 */

interface HeaderEntry {
  type: "session";
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  parentSession?: unknown;
}

export interface SessionScanResult {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  firstMessage: string;
  parentSessionPath?: string;
}

// 头部 / 尾部各最多读这么多字节；超出部分（超长正文）不碰。
const HEAD_READ_BYTES = 48 * 1024;
const TAIL_READ_BYTES = 48 * 1024;
// 列表里的首条消息只做简述展示（sidebar 也只截取前 50 字符）。
const FIRST_MESSAGE_PREVIEW_LENGTH = 300;

function parseLine(line: string): unknown {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractTextContent(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

/** 读取文件尾部，取最后一个 session_info 的自定义名（显式清空 → undefined）。 */
function scanNameFromTail(path: string, size: number): string | undefined {
  if (size <= 0) return undefined;
  const start = Math.max(0, size - TAIL_READ_BYTES);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  // 第一段可能从一个完整行中间开始（首尾重叠时是完整行，多为空行，均安全跳过）。
  const lines = buf.toString("utf8").split("\n");
  let name: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const entry = parseLine(lines[i]) as { type?: string; name?: unknown } | null;
    if (entry?.type === "session_info" && typeof entry.name === "string") {
      name = entry.name.trim() || undefined;
    }
  }
  return name;
}

function scanOneSessionFile(path: string): SessionScanResult | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const headLen = Math.min(HEAD_READ_BYTES, stat.size);
  const headBuf = Buffer.alloc(headLen);
  const fd = openSync(path, "r");
  try {
    readSync(fd, headBuf, 0, headLen, 0);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  let header: HeaderEntry | null = null;
  let firstMessage = "";
  for (const line of headBuf.toString("utf8").split("\n")) {
    const entry = parseLine(line) as
      | HeaderEntry
      | { type?: unknown; message?: { role?: unknown; content?: unknown } }
      | null;
    if (!entry) continue;
    if (!header) {
      // 首条 entry 必须是 session 头，否则不是本应用的会话文件。
      if (entry.type !== "session") return null;
      header = entry as HeaderEntry;
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "user") {
      const text = extractTextContent(entry.message).trim();
      if (text) {
        firstMessage = text.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH);
        break;
      }
    }
  }
  if (!header) return null;

  const id = typeof header.id === "string" ? header.id : "";
  if (!id) return null;
  const created = new Date(typeof header.timestamp === "string" ? header.timestamp : "");
  if (Number.isNaN(created.getTime())) created.setTime(stat.mtime.getTime());

  return {
    path,
    id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name: scanNameFromTail(path, stat.size),
    created,
    modified: stat.mtime,
    firstMessage: firstMessage || "(no messages)",
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
  };
}

/**
 * 扫描 <agentDir>/sessions 下所有 jsonl。同步小 IO 串行即可（单文件只读
 * 首尾几十 KB），`sessionsDir` 仅在测试时注入。
 */
export async function scanSessionFiles(sessionsDir?: string): Promise<SessionScanResult[]> {  const root = sessionsDir ?? joinPath(getAgentDir(), "sessions");
  let projectDirs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    projectDirs = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => joinPath(root, entry.name));
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dir of projectDirs) {
    try {
      for (const name of await readdir(dir)) {
        if (name.endsWith(".jsonl")) files.push(joinPath(dir, name));
      }
    } catch {
      // 单目录不可读则跳过，不影响其它目录。
    }
  }

  const results: SessionScanResult[] = [];
  for (const file of files) {
    const scanned = scanOneSessionFile(file);
    if (scanned) results.push(scanned);
  }
  results.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return results;
}

// 以对象形式暴露扫描入口，测试可替换实现（ESM 的模块绑定本身只读）。
export const sessionScanner = { scan: scanSessionFiles };