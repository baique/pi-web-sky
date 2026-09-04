import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { open } from "node:fs/promises";
import { resolveSessionPath } from "./session-reader";

// ============================================================================
// 审核/阻塞判定（S3）
// 用 SessionManager.inMemory()（等价 --no-session）临时会话做一次结构化 AI 判定，
// 不落盘、不污染执行会话文件；执行会话上下文干净，重试不带审核噪音。
// ============================================================================

/** review 卡审核判定 */
export type AuditVerdict = "done" | "failed" | "waiting_reply" | "other";
/** running 卡阻塞判定 */
export type BlockKind =
  | "sync_server"
  | "infinite_loop"
  | "rate_limit"
  | "error"
  | "asking"
  | "normal";

export interface AuditInput {
  cwd: string;
  cardNumber: number;
  cardName: string;
  taskDescription: string;
  /** 执行会话最后几条 AI 消息文本（供 AI 判定） */
  recentMessages: string;
}

export interface AuditVerdictResult {
  verdict: AuditVerdict;
  reason: string;
}

export interface BlockCheckResult {
  kind: BlockKind;
  detail: string;
}

/** 从模型回复里抽取首个 JSON 对象块（容忍思考前缀/前后文）。 */
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const AUDIT_TIMEOUT_MS = 90_000;

// ============================================================================
// 会话快照（程序检测 + 喂给 AI 的最近消息）
// ============================================================================

export interface SessionAuditSnapshot {
  /** 程序判定：最后消息有失败迹象（模型报错/工具 isError/exit!=0） */
  failure: boolean;
  /** 最后几条 AI 消息文本（喂给 AI 判定） */
  recentText: string;
  /** 最后一条消息时间（ms epoch）；0=未知（阻塞检测用） */
  lastActivityMs: number;
  /** 最后一条是否为命令发起（bash toolCall 未见返回）——阻塞巡检硬条件 */
  lastIsCommand: boolean;
  /** 最后一条命令发起时间（ms epoch）；0=非命令发起（阻塞巡检判定用） */
  lastCommandAtMs: number;
}

/** 命令类工具：命令发起后未见 toolResult = 命令仍在执行（阻塞巡检只关心这类）。 */
const COMMAND_TOOLS = new Set(["bash"]);

/**
 * 尾部反读会话文件最后几条消息。绝不解析整个文件（大会话几百 KB~MB 级
 * 全量解析会同步阻塞事件循环——这是当初停用审核/巡检的直接原因）。
 * 起始读最后 128KB，不足 4 条 message 时翻倍扩大，上限 1MB（防御巨单行）。
 */
async function readSessionTail(sessionId: string): Promise<SessionMessageEntry[] | null> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return null;
  let tailBytes = 128 * 1024;
  while (tailBytes <= 1024 * 1024) {
    const fh = await open(filePath, "r");
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - tailBytes);
      const buf = Buffer.alloc(size - start);
      if (buf.length > 0) await fh.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // 首行可能是从中间切断的半行，丢弃（仅当不是从文件头开始读时）
      const rows = start > 0 ? lines.slice(1) : lines;
      const entries: SessionMessageEntry[] = [];
      for (let i = rows.length - 1; i >= 0 && entries.length < 8; i--) {
        const line = rows[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as SessionMessageEntry;
          if (obj?.type === "message") entries.unshift(obj);
        } catch {
          // 坏行跳过（尾部读取容忍脏数据）
        }
      }
      if (entries.length >= 4 || tailBytes >= 1024 * 1024 || size <= tailBytes) return entries;
    } finally {
      await fh.close();
    }
    tailBytes *= 2;
  }
  return null;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } => Boolean(b) && typeof b === "object" && "text" in b)
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** 最后一条 assistant 消息里是否有命令发起（toolCall name ∈ COMMAND_TOOLS）。 */
function lastMessageIsCommand(m: SessionMessageEntry["message"]): boolean {
  if (m.role !== "assistant" || !Array.isArray(m.content)) return false;
  return m.content.some(
    (b): boolean =>
      Boolean(b) &&
      typeof b === "object" &&
      (b as { type?: string; name?: string }).type === "toolCall" &&
      COMMAND_TOOLS.has((b as { name: string }).name),
  );
}

/** 读执行会话文件（尾部反读）：程序判定失败 + 最近消息文本 + 最后活动时间。文件缺失返回 null。 */
export async function readSessionAuditSnapshot(sessionId: string): Promise<SessionAuditSnapshot | null> {
  try {
    const entries = await readSessionTail(sessionId);
    if (!entries) return null;
    const messages = entries.filter((e): e is SessionMessageEntry => e.type === "message");
    let failure = false;
    let lastActivityMs = 0;
    const recent: string[] = [];
    // 仅「最后一条」参与命令判定（阻塞巡检硬条件：最后一条必须是命令发起）；
    // 失败迹象/最近文本扫描最后 4 条（AI 判定需要稍多上下文）。
    const last = messages[messages.length - 1];
    const lastIsCommand = last ? lastMessageIsCommand(last.message) : false;
    const lastTs =
      last && typeof last.message.timestamp === "number"
        ? last.message.timestamp
        : last
          ? new Date(last.timestamp).getTime()
          : 0;
    const lastCommandAtMs = lastIsCommand && !Number.isNaN(lastTs) ? lastTs : 0;
    for (const e of messages.slice(-4)) {
      const m = e.message;
      const ts = typeof m.timestamp === "number" ? m.timestamp : new Date(e.timestamp).getTime();
      if (!Number.isNaN(ts)) lastActivityMs = Math.max(lastActivityMs, ts);
      if (m.role === "assistant") {
        if (m.errorMessage) failure = true;
        const text = textOfContent(m.content);
        if (text) recent.push(`AI: ${text.slice(0, 400)}`);
      } else if (m.role === "toolResult") {
        if (m.isError) failure = true;
        const details = m.details as { exitCode?: number } | undefined;
        if (details && typeof details.exitCode === "number" && details.exitCode !== 0) failure = true;
        const text = textOfContent(m.content);
        if (text) recent.push(`工具 ${m.toolName}: ${text.slice(0, 300)}`);
      } else if (m.role === "user") {
        const text = textOfContent(m.content);
        if (text) recent.push(`用户: ${text.slice(0, 300)}`);
      }
    }
    return { failure, recentText: recent.join("\n").slice(0, 4000), lastActivityMs, lastIsCommand, lastCommandAtMs };
  } catch (error) {
    console.error(
      `[task-scheduler] 读会话快照失败 ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** 用 inMemory 临时会话跑一次结构化判定。超时/失败返回 null。 */
async function runStructuredVerdict<T>(
  cwd: string,
  instruction: string,
  input: string,
): Promise<T | null> {
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | null = null;
  const timer = setTimeout(() => {
    // 超时兜底：dispose 会中断模型请求
    if (session && typeof (session as { dispose?: () => void }).dispose === "function") {
      try { (session as { dispose: () => void }).dispose(); } catch { /* 忽略 */ }
    }
  }, AUDIT_TIMEOUT_MS);

  try {
    initTheme();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: { extensionFactories: [] },
    });
    const manager = SessionManager.inMemory(cwd);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      noTools: "all",
    });
    session = created.session;
    await session.prompt(`${instruction}\n\n${input}`, {
      expandPromptTemplates: false,
      source: "rpc",
    });
    await session.waitForIdle();
    const text = session.getLastAssistantText() ?? "";
    const parsed = extractJson(text);
    return (parsed ?? null) as T | null;
  } catch (error) {
    console.error(
      "[audit-session] 判定失败:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timer);
    if (session) {
      try { session.dispose(); } catch { /* 忽略 */ }
    }
  }
}

const AUDIT_INSTRUCTION = `你是任务卡审核员。下面给出任务卡信息与执行会话最后几条消息，判断任务执行结果：
- done: 任务已正确完成
- failed: 执行失败 / 出错 / 未完成 / 模型报错
- waiting_reply: AI 正在向用户提问、等待用户输入
- other: 信息不足，无法判断

只输出一行 JSON（不要输出其他文字）：{"verdict":"done|failed|waiting_reply|other","reason":"简短原因"}`;

/** review 卡审核：返回 done/failed/waiting_reply/other；判定失败返回 null。 */
export async function runAuditVerdict(input: AuditInput): Promise<AuditVerdictResult | null> {
  const taskText = [
    `【任务卡 #${input.cardNumber}】${input.cardName}`,
    `任务描述：${input.taskDescription || "(空)"}`,
    ``,
    `执行会话最后几条消息：`,
    input.recentMessages || "(无消息)",
  ].join("\n");
  const result = await runStructuredVerdict<AuditVerdictResult>(input.cwd, AUDIT_INSTRUCTION, taskText);
  if (result && ["done", "failed", "waiting_reply", "other"].includes(result.verdict)) {
    return { verdict: result.verdict, reason: result.reason ?? "" };
  }
  return null;
}

const BLOCK_INSTRUCTION = `你是任务卡巡检员。任务卡执行会话已超过 5 分钟没有进展。根据任务与最后几条消息，判断阻塞类型：
- sync_server: 正在同步开启服务 / 输出流式日志（长任务，正常）
- infinite_loop: 死循环 / 重复执行同一操作
- rate_limit: 模型限流(429) / 节流退避
- error: 执行报错
- asking: AI 在提问等待用户输入
- normal: 正常运行中（长任务）

只输出一行 JSON（不要输出其他文字）：{"kind":"sync_server|infinite_loop|rate_limit|error|asking|normal","detail":"简短说明"}`;

/** running 卡阻塞判定：返回阻塞类型；判定失败返回 null。 */
export async function runBlockCheck(input: AuditInput): Promise<BlockCheckResult | null> {
  const taskText = [
    `【任务卡 #${input.cardNumber}】${input.cardName}`,
    `任务描述：${input.taskDescription || "(空)"}`,
    ``,
    `执行会话最后几条消息：`,
    input.recentMessages || "(无消息)",
  ].join("\n");
  const result = await runStructuredVerdict<BlockCheckResult>(input.cwd, BLOCK_INSTRUCTION, taskText);
  if (result && ["sync_server", "infinite_loop", "rate_limit", "error", "asking", "normal"].includes(result.kind)) {
    return { kind: result.kind, detail: result.detail ?? "" };
  }
  return null;
}
