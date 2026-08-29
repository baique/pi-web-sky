import { closeSync, openSync, readSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { join as joinPath } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 轻量会话列表扫描：只读取每个 jsonl 的「头部」（session header + 首条用户
 * 消息简述）和「尾部」（自定义名 session_info，反向分块读），中间内容一律
 * 不读，最后活动时间直接用文件 mtime。列表展示只需要标题 + 时间 + 名字。
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

// 初始读块：前几条 entry（header + 首条用户消息）通常远小于此；
// 不足时再按需扩读，直到拿到首条消息或达到上限。
const HEAD_INITIAL_BYTES = 4 * 1024;
const HEAD_MAX_BYTES = 48 * 1024;
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

/**
 * 读取文件头部：拿 header + 首条用户消息。
 * 策略：先读小块（4KB），解析完整行；若首条消息已拿到则停；若块尾行
 * 不完整（可能被截断），或还没拿到首条消息，则扩大读取继续。
 * 首行必须是 session 头，否则视为非本应用会话文件。
 */
function scanHead(path: string, size: number): { header: HeaderEntry; firstMessage: string } | null {
  let readLen = Math.min(HEAD_INITIAL_BYTES, size);
  let text = "";
  const fd = openSync(path, "r");
  try {
    let header: HeaderEntry | null = null;
    let firstMessage = "";

    while (true) {
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, 0);
      const chunk = buf.toString("utf8");
      // 块尾可能是半行：丢到最后完整换行处，避免解析半行。
      const lastNl = chunk.lastIndexOf("\n");
      const end = lastNl === -1 ? chunk.length : lastNl + 1;
      text += chunk.slice(0, end);

      for (const line of text.split("\n")) {
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
          const msgText = extractTextContent(entry.message).trim();
          if (msgText) {
            firstMessage = msgText.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH);
            break;
          }
        }
      }

      if (!header) return null;
      if (firstMessage) break; // 已拿到首条消息，收工。

      // 还没拿到首条消息：已读满上限或已到文件尾则放弃；否则扩读。
      if (readLen >= HEAD_MAX_BYTES || readLen >= size) break;
      readLen = Math.min(readLen * 2, HEAD_MAX_BYTES, size);
      if (readLen <= 0) break;
    }
    return { header, firstMessage };
  } finally {
    closeSync(fd);
  }
}

// 从文件末尾向前翻的块大小与上限。反向分块：session_info 是 append 写入的，
// 改名后继续聊会被推到更靠前的位置；从尾部向前找最后一个 session_info
// 与 SDK getSessionName 语义一致，且大多数会话第一块就命中（改名后没怎么聊）。
const NAME_BLOCK_BYTES = 64 * 1024;
const NAME_MAX_BLOCKS = 256; // 约 16MB，超出视为无名字

/** 读取文件尾部，取最后一个 session_info 的自定义名（显式清空 → undefined）。 */
function scanNameFromTail(path: string, size: number): string | undefined {
  if (size <= 0) return undefined;
  const fd = openSync(path, "r");
  try {
    let offset = size;
    for (let block = 0; block < NAME_MAX_BLOCKS && offset > 0; block++) {
      const start = Math.max(0, offset - NAME_BLOCK_BYTES);
      const len = offset - start;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // 块首可能截断一行（前一行的后半），跳过第一行；块尾对齐 offset 完整。
      // 从后往前找本块内最后一个 session_info。
      for (let i = lines.length - 1; i >= 1; i--) {
        const entry = parseLine(lines[i]) as { type?: string; name?: unknown } | null;
        if (entry?.type === "session_info" && typeof entry.name === "string") {
          const name = entry.name.trim();
          return name || undefined; // 显式清空 → undefined
        }
      }
      offset = start;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function scanOneSessionFile(path: string): SessionScanResult | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;

  const scanned = scanHead(path, stat.size);
  if (!scanned) return null;
  const { header, firstMessage } = scanned;

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
 * 头部小块 + 尾部反向分块），`sessionsDir` 仅在测试时注入。
 */
export async function scanSessionFiles(sessionsDir?: string): Promise<SessionScanResult[]> {
  const root = sessionsDir ?? joinPath(getAgentDir(), "sessions");
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
