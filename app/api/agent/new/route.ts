import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { assignSessionToTask } from "@/lib/task-store";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// 与 SDK 的 assertValidSessionId 同规则：非空、仅字母数字 + `-_.`、首尾字母数字。
// SDK 未从主包导出该函数，这里本地校验以提前返回友好错误。
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // 客户端可指定会话 ID（新建会话发起时即可知，任务/看板绑定同步完成）。
    // 无 id 时走 tempKey 路径（向后兼容，由 pi 生成 ID）。
    const { provider, modelId, toolNames, thinkingLevel, taskId, id, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; taskId?: unknown; id?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);
    const desiredId = typeof id === "string" && id.trim() ? id.trim() : undefined;
    if (desiredId && !isValidSessionId(desiredId)) {
      throw new Error(`Invalid session id: ${desiredId}`);
    }

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    // 指定 id 时直接用 id 作锁 key（唯一）；否则用随机 tempKey。
    const tempKey = desiredId ?? `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    // 任务归属伴随创建一次完成：会话出生即挂在任务下，任何列表刷新都不会
    // 先显示“未归属/临时区”（此前是前端拿到 realId 后再两跳 PATCH 补写）。
    if (typeof taskId === "string" && taskId) {
      if (!assignSessionToTask(realSessionId, taskId)) {
        throw new Error(`Task not found: ${taskId}`);
      }
      // 任务看板若已存在 → 新会话入板（后端权威，窗口期不依赖前端）
      const { getBoard } = await import("@/lib/board-store");
      const board = getBoard(taskId);
      if (board) {
        const { reconcileBoard } = await import("@/lib/board-reconcile");
        void reconcileBoard(board.id).catch((e) =>
          console.warn(`[agent/new] reconcile ${board.id} 异常:`, e?.message ?? e),
        );
      }
    }

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
