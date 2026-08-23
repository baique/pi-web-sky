import { randomUUID } from "crypto";
import type { IPty } from "@lydell/node-pty";

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
  cwd: string;
  projectRoot: string | null;
  projectLabel: string;
  cols: number;
  rows: number;
  running: boolean;
  exitCode: number | null;
  createdAt: number;
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

/** Append output to the ring buffer and fan out to live SSE listeners. */
function pushOutput(s: TerminalSession, data: string) {
  s.buffer += data;
  if (s.buffer.length > RING_BUFFER_BYTES) {
    const drop = s.buffer.length - RING_BUFFER_BYTES;
    // ponytail: drop at an arbitrary char boundary — xterm tolerates it.
    s.buffer = s.buffer.slice(drop);
    s.baseOffset += drop;
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
    id: s.id, cwd: s.cwd, projectRoot: s.projectRoot, projectLabel: s.projectLabel,
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

  const { default: pty } = await import("@lydell/node-pty");
  const proc = pty.spawn(shell, args, {
    name: "xterm-256color",
    cwd: opts.cwd,
    cols,
    rows,
    env: process.env as Record<string, string>,
  });

  const id = randomUUID();
  const session: TerminalSession = {
    id,
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
