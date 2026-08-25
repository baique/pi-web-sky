import { randomUUID, randomBytes } from "crypto";
import type { IPty } from "@lydell/node-pty";

type IPtyModule = typeof import("@lydell/node-pty");

// ============================================================================
// Terminal session registry — server-side keepalive terminals.
// Sessions outlive browser refreshes: pty output is kept in a ring buffer and
// replayed by byte offset when a client re-attaches (SSE ?since=<offset>).
// Registry lives on globalThis so Next.js hot-reload doesn't kill running
// shells (same pattern as the agent session registry in rpc-manager.ts).
// ============================================================================

const RING_BUFFER_BYTES = 256 * 1024;
export const MAX_TERMINALS = 12;

export interface TerminalSessionMeta {
  id: string;
  /** 展示用名称：默认 `<cwd basename>-<4位随机nanoid>`，创建时生成、持久稳定，用于区分同项目多终端。 */
  name: string;
  cwd: string;
  projectRoot: string | null;
  projectLabel: string;
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
}

/** URL 安全字母表上的 4 位随机串（近似 nanoid 的短 id）。 */
const ID4_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function randomId4(): string {
  const bytes = randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += ID4_ALPHABET[bytes[i] % ID4_ALPHABET.length];
  return out;
}

interface TerminalSession extends TerminalSessionMeta {
  pty: IPty | null; // null once exited
  buffer: string; // ring buffer of recent output
  /** Monotonic offset = total bytes ever written minus buffer.length. */
  baseOffset: number;
  listeners: Set<(chunk: string) => void>;
}

type Registry = {
  sessions: Map<string, TerminalSession>;
};

function registry(): Registry {
  const g = globalThis as typeof globalThis & { __piTerminals?: Registry };
  if (!g.__piTerminals) g.__piTerminals = { sessions: new Map() };
  return g.__piTerminals;
}

/**
 * Drop the excess prefix of a ring buffer, cutting just after the last
 * newline at/at-before the overflow point. Replays start from the buffer
 * head, so a byte-granular cut can land inside a multi-byte char or an ANSI
 * escape sequence — xterm does NOT tolerate that (garbage chars at the top
 * of the terminal after a re-attach). Falls back to the plain cut when the
 * overflow lands in a newline-free run (no way to align; rare and benign).
 * Returns [kept, droppedBytes].
 */
export function trimRingBuffer(buffer: string, maxBytes: number): [string, number] {
  if (buffer.length <= maxBytes) return [buffer, 0];
  let drop = buffer.length - maxBytes;
  const nl = buffer.lastIndexOf("\n", drop);
  if (nl >= 0) drop = nl + 1;
  return [buffer.slice(drop), drop];
}

/** Append output to the ring buffer and fan out to live SSE listeners. */
function pushOutput(s: TerminalSession, data: string) {
  s.buffer += data;
  if (s.buffer.length > RING_BUFFER_BYTES) {
    const [kept, dropped] = trimRingBuffer(s.buffer, RING_BUFFER_BYTES);
    s.buffer = kept;
    s.baseOffset += dropped;
  }
  for (const fn of s.listeners) fn(data);
}

/**
 * Bytes buffered starting from `since`; null when the offset has fallen out
 * of the ring buffer (caller should fall back to fullBuffer()).
 */
export function outputSince(id: string, since: number): string | null {
  const s = registry().sessions.get(id);
  if (!s) return null;
  const bufStart = s.baseOffset;
  if (since < bufStart) return null;
  return s.buffer.slice(Math.max(0, since - bufStart));
}

/** Entire ring buffer with its absolute start offset. */
export function fullBuffer(id: string): { data: string; startOffset: number } | null {
  const s = registry().sessions.get(id);
  if (!s) return null;
  return { data: s.buffer, startOffset: s.baseOffset };
}

function toMeta(s: TerminalSession): TerminalSessionMeta {
  return {
    id: s.id, name: s.name, cwd: s.cwd, projectRoot: s.projectRoot, projectLabel: s.projectLabel,
    cols: s.cols, rows: s.rows, running: s.running, exitCode: s.exitCode,
    createdAt: s.createdAt,
  };
}

export function listTerminals(): TerminalSessionMeta[] {
  return [...registry().sessions.values()].map(toMeta);
}

export function getTerminal(id: string): TerminalSessionMeta | undefined {
  const s = registry().sessions.get(id);
  return s ? toMeta(s) : undefined;
}

export function currentOffset(id: string): number {
  const s = registry().sessions.get(id);
  return s ? s.baseOffset + s.buffer.length : 0;
}

export async function createTerminal(opts: {
  cwd: string;
  projectRoot: string | null;
  projectLabel: string;
  cols?: number;
  rows?: number;
}): Promise<TerminalSessionMeta> {
  const sessions = registry().sessions;

  // Cap total sessions; reclaim exited ones first (oldest exit first).
  if (sessions.size >= MAX_TERMINALS) {
    const exited = [...sessions.values()]
      .filter((s) => !s.running)
      .sort((a, b) => a.createdAt - b.createdAt);
    const victim = exited[0];
    if (!victim) throw new Error(`Terminal limit reached (${MAX_TERMINALS})`);
    removeTerminal(victim.id);
  }

  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const shell = process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "bash";
  const args = process.platform === "win32" || process.env.SHELL?.endsWith("fish") ? [] : ["-l"];

  // Webpack bundles external packages as plain CJS require()s, so the ESM
  // interop `default` can be missing in the production build — fall back to
  // the module object itself (dev keeps `default`, node-pty exports both).
  const ptyMod = (await import("@lydell/node-pty")) as { default?: IPtyModule };
  const pty = (ptyMod.default ?? ptyMod) as IPtyModule;
  const proc = pty.spawn(shell, args, {
    name: "xterm-256color",
    cwd: opts.cwd,
    cols,
    rows,
    env: process.env as Record<string, string>,
  });

  const id = randomUUID();
  const base = opts.cwd.split(/[\\/]/).filter(Boolean).pop() || "term";
  const session: TerminalSession = {
    id,
    name: `${base}-${randomId4()}`,
    cwd: opts.cwd,
    projectRoot: opts.projectRoot,
    projectLabel: opts.projectLabel,
    cols,
    rows,
    running: true,
    exitCode: null,
    createdAt: Date.now(),
    pty: proc,
    buffer: "",
    baseOffset: 0,
    listeners: new Set(),
  };
  proc.onData((data) => pushOutput(session, data));
  proc.onExit(({ exitCode }) => {
    session.running = false;
    session.exitCode = exitCode;
    session.pty = null;
    pushOutput(session, `\r\n\x1b[2m[进程已退出，exit code ${exitCode}]\x1b[0m\r\n`);
  });
  sessions.set(id, session);
  return getTerminal(id)!;
}

export function writeTerminal(id: string, data: string): boolean {
  const s = registry().sessions.get(id);
  if (!s?.pty) return false;
  s.pty.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const s = registry().sessions.get(id);
  if (!s) return false;
  s.cols = cols;
  s.rows = rows;
  try {
    s.pty?.resize(cols, rows);
  } catch {
    // resize after exit races onExit; harmless.
  }
  return true;
}

/** Kill the process. Output stays inspectable until removeTerminal(). */
export function killTerminal(id: string): boolean {
  const s = registry().sessions.get(id);
  if (!s) return false;
  if (s.pty) {
    try {
      s.pty.kill();
    } catch {
      // already dead
    }
  }
  return true;
}

export function removeTerminal(id: string): boolean {
  const s = registry().sessions.get(id);
  if (!s) return false;
  killTerminal(id);
  for (const fn of s.listeners) fn(""); // release SSE streams
  s.listeners.clear();
  return registry().sessions.delete(id);
}

export function addListener(id: string, fn: (chunk: string) => void): boolean {
  const s = registry().sessions.get(id);
  if (!s) return false;
  s.listeners.add(fn);
  return true;
}

export function removeListener(id: string, fn: (chunk: string) => void): void {
  registry().sessions.get(id)?.listeners.delete(fn);
}
