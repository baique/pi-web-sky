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
  /** 最后一条 assistant 回复文本（截断），无则为空串 */
  lastReply: string;
  parentSessionPath?: string;
}

// 初始读块：前几条 entry（header + 首条用户消息）通常远小于此；
// 不足时再按需扩读，直到拿到首条消息或达到上限。
const HEAD_INITIAL_BYTES = 4 * 1024;
const HEAD_MAX_BYTES = 48 * 1024;
// 列表里的首条消息只做简述展示（sidebar 也只截取前 50 字符）。
// 导出给事件链路（rpc-manager 回填 first_message）复用同一上限。
export const FIRST_MESSAGE_PREVIEW_LENGTH = 300;

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
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    // stat 通过但 open 失败（EACCES / 被并发换成目录等）→ 当作「读不出来」。
    // 调用方（scanOneSessionHead / scanOneSessionFile）把 null 往下传，不向上抛：
    // 详情读取路径是 /api/sessions/summary 的「库内无行」回退，一个打不开的文件
    // 不该让整个接口 500。
    return null;
  }
  try {
    let readLen = Math.min(HEAD_INITIAL_BYTES, size);
    let text = "";
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
  } catch (error) {
    // readSync 中途失败（EIO / 文件被重写 / 块大小异常）同样降级为「读不出来」。
    console.warn(`[pi-web] 会话头部读取失败 path=${path}:`, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 已关闭/句柄失效：不影响返回值
    }
  }
}

// 从文件末尾向前翻的块大小与上限。反向分块：session_info 是 append 写入的，
// 改名后继续聊会被推到更靠前的位置；从尾部向前找最后一个 session_info
// 与 SDK getSessionName 语义一致，且大多数会话第一块就命中（改名后没怎么聊）。
const NAME_BLOCK_BYTES = 64 * 1024;
const NAME_MAX_BLOCKS = 256; // 约 16MB，超出视为无名字

/** 轻量头部扫描：只读 header + 首条用户消息，不读尾部（索引扫描器建行用，
 *  区别于 scanOneSessionFile——后者还会反向读尾部拿自定义名/lastReply）。 */
export function scanOneSessionHead(path: string): { path: string; id: string; cwd: string; created: Date; firstMessage: string; parentSessionPath: string | undefined } | null {
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
    created,
    firstMessage: firstMessage || "",
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
  };
}

/** 读取文件尾部：最后一个 session_info 的自定义名 + 最后一条 assistant 回复。
 *  同一趟反向分块里同时取两样：名字（显式清空 → undefined）、
 *  lastReply（最后一个 text 块，完整不截断）。返回 { name, lastReply }；
 *  open/read 任何异常 → **null**（读不出来），与「读了但没有回复」的
 *  `{ name: undefined, lastReply: "" }` 区分——调用方据此决定要不要回填。
 *  本函数永不抛错：scanOneSessionFile 是详情读取路径，一个打不开的文件不该让整个接口 500。 */
function scanTail(
  path: string,
  size: number,
): { name: string | undefined; lastReply: string } | null {
  const empty: { name: string | undefined; lastReply: string } = { name: undefined, lastReply: "" };
  if (size <= 0) return empty;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
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
      // 从后往前找本块内最后一个 session_info 与最后一条 assistant 回复。
      for (let i = lines.length - 1; i >= 1; i--) {
        if (empty.name !== undefined && empty.lastReply) continue;
        const entry = parseLine(lines[i]) as
          | { type?: string; name?: unknown; message?: { role?: unknown; content?: unknown } }
          | null;
        if (!entry) continue;
        if (empty.name === undefined && entry.type === "session_info" && typeof entry.name === "string") {
          const name = entry.name.trim();
          if (name) empty.name = name; // 显式清空 → undefined
        } else if (!empty.lastReply && entry.type === "message" && entry.message?.role === "assistant") {
          const reply = extractTextContent(entry.message).trim();
          // 不截断：收合卡完整展示最后一条消息（跨 64KB 块的超大回复仍可能缺块首，极端场景）
          if (reply) empty.lastReply = reply;
        }
        if (empty.name !== undefined && empty.lastReply) break; // 两个都拿到，收工
      }
      offset = start;
    }
    return empty;
  } catch (error) {
    console.warn(`[pi-web] 会话尾部读取失败 path=${path}:`, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 已关闭/句柄失效：不影响返回值
    }
  }
}

/** 单文件尾部轻量读：自定义名 + 最后一条 assistant 回复（反向分块，命中即停）。
 *  这个函数**永不抛错**：文件不存在 / 不可读（EACCES）/ 打开后又读失败（EIO、文件被重写）
 *  / 是目录 / 为空 → null。调用方区分「读不出来」（null，保持未回填、下轮再试）与
 *  「读了但没有回复」（lastReply 为空串）。
 *  为什么必须吞掉 open/read 的错：扫描器的 last_reply 回填逐行调用它，一个 EACCES
 *  逃出去就会中止整轮扫描；查询无 ORDER BY，同一行每轮都被重新命中 → 它后面的行
 *  永远得不到回填（冷启动时还会把异常抛到 ensureSessionIndexReady → /api/sessions 500）。
 *  这是全库唯一的尾部反向分块实现——不要再写第二份。 */
export function readSessionTail(path: string): { name?: string; lastReply: string } | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) return null;
    // scanTail 自身不再抛错：open/read 失败返回 null（与这里「读不出来」的语义直接对齐）。
    return scanTail(path, stat.size);
  } catch {
    return null;
  }
}

/** 单个会话文件详情（阶段二按需读取：只对当前页/置顶子集调用）。
 *  本函数永不抛错：stat / 头部 / 尾部任一读取失败都降级为 null 或空字段——
 *  调用方是 /api/sessions/summary 的「库内无行」回退，一个打不开的文件不该 500。 */
export function scanOneSessionFile(path: string): SessionScanResult | null {
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

  // 尾部读不出来（open/read 失败）→ 空结果：详情仍可展示（名字/最后回复为空），
  // 不像 readSessionTail 那样返回 null（那里要靠 null 区分「下轮再回填」）。
  const tail = scanTail(path, stat.size) ?? { name: undefined, lastReply: "" };

  return {
    path,
    id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    name: tail.name,
    created,
    modified: stat.mtime,
    firstMessage: firstMessage || "(no messages)",
    lastReply: tail.lastReply,
    parentSessionPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
  };
}

/* 全量详情扫描（scanSessionFiles / sessionScanner.scan）已删除：读取路径全部改查
 * session_meta，扫描器只需阶段一元数据（scanSessionFileMeta）+ 单文件详情
 * （scanOneSessionFile）。保留全量版本会让「列表=扫盘」的旧路径随时被重新接上。 */

/** 阶段一元数据：目录项 + stat 即可，不读内容。`id` 是「文件名提示」
 *  （可能为空串——如 `session.jsonl`，此时 id 由 header 决定）。 */
export interface SessionFileMeta {
  path: string;
  id: string;
  modified: Date;
}

/** 扫描深度上限（项目目录 = 1 层）：`<project>/<session>/<runId>/run-0/session.jsonl`
 *  只到第 4 层，6 层留余量；没有上限的话一个异常目录树能把每轮扫描拖成深递归。 */
const MAX_SCAN_DEPTH = 6;

/** 会话文件候选 id：`<...>_<id>.jsonl` 取末段（本应用的命名约定，见
 *  session-reader 的 findSessionPathByName）；`session.jsonl` 这类没有
 *  `<timestamp>_<id>` 形状的名字返回 ""——不猜 id，交给 header 决定。 */
function idHintFromName(name: string): string {
  const parts = name.slice(0, -".jsonl".length).split("_");
  if (parts.length < 2) return "";
  const last = parts[parts.length - 1];
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(last) && !/^[0-9]+$/.test(last) ? last : "";
}

/** 递归收集目录下的 jsonl（深度优先，串行）。
 *  隐藏目录跳过（.git 等不可能是会话目录）；符号链接目录不跟（防环）；
 *  单个目录不可读 → 跳过，不影响其它目录。 */
async function walkJsonl(dir: string, depth: number, out: SessionFileMeta[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_SCAN_DEPTH) await walkJsonl(full, depth + 1, out);
      continue;
    }
    if (!entry.name.endsWith(".jsonl")) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    out.push({ path: full, id: idHintFromName(entry.name), modified: stat.mtime });
  }
}

/** 阶段一元数据：只读目录项 + stat，不碰文件内容。
 *  会话文件命名 `<timestamp>_<id>.jsonl`，id 直接从文件名解析（与 header 一致，
 *  见 scanOneSessionFile 校验）；mtime 即最后活动时间（侧栏排序键）。
 *  两阶段设计：这里全量便宜拿到 id+mtime 后，扫描器按 path 匹配建行/收敛，
 *  读取路径（列表/任务区/看板摘要）则完全不再读文件。
 *
 *  递归扫描：外部 pi 系工具会在项目目录下造子目录布局
 *  （`<session>/forks/<ts>_<id>.jsonl`、`<session>/<runId>/run-0/session.jsonl`、
 *  `subagent-artifacts/*.jsonl`）。只做一层 readdir 会让这些会话永远不进库
 *  （列表里等于不存在）。这里向下递归到 MAX_SCAN_DEPTH，id 仍是「文件名提示」
 *  （可能为空串，由 header 决定，见 idHintFromName）。 */
export async function scanSessionFileMeta(sessionsDir?: string): Promise<SessionFileMeta[]> {
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

  const metas: SessionFileMeta[] = [];
  for (const dir of projectDirs) {
    // 项目目录自身算第 1 层：`<project>/<session>/<runId>/run-0/session.jsonl` 到第 4 层。
    await walkJsonl(dir, 1, metas);
  }
  metas.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return metas;
}
