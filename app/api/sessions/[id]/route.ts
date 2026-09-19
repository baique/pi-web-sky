import { NextResponse } from "next/server";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  hasOlderHistory,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { setSessionPinned, setSessionTitle, taskNameForSession, reparentSessionChildren, unassignSession, listChildPaths } from "@/lib/task-store";
import { removeSessionFromBoards } from "@/lib/board-store";
import { removeSessionsFromYjsBoards } from "@/lib/board-reconcile";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, { deferThinking, deferToolResultImages, tail });
    const hasMore = hasOlderHistory(entries as never, leafId, tail);
    const totalActiveMs = computeSessionTotalActiveMs(entries);

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      transient: !filePath || !existsSync(filePath),
      // 实时任务归属（sessionInfo 面板打开时读取，避免列表快照过期）
      taskName: taskNameForSession(id) ?? undefined,
    }]))[0] : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      totalActiveMs,
      hasMore,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string } | { pinned: boolean }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({})) as { name?: string; pinned?: boolean };
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        return NextResponse.json({ error: "name must be a string" }, { status: 400 });
      }
      const sm = SessionManager.open(filePath);
      sm.appendSessionInfo(body.name.trim());
      // 列表索引同步：改名实时写 session_meta.title，不依赖扫描器/懒更新。
      // 库写失败：日志可见 + 缓存照样失效 + 请求报错（库是标题事实源，不允许
      // 「磁盘改了、库没改」还报成功）。
      try {
        await setSessionTitle(id, body.name.trim());
      } catch (error) {
        console.error("[pi-web] 会话标题写库失败:", error);
        throw error;
      } finally {
        invalidateSessionListCache();
      }
      return NextResponse.json({ ok: true });
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== "boolean") {
        return NextResponse.json({ error: "pinned must be a boolean" }, { status: 400 });
      }
      // 与改名同规则：写库失败可见 + 缓存照样失效 + 500。
      try {
        await setSessionPinned(id, body.pinned);
      } catch (error) {
        console.error("[pi-web] 会话置顶写库失败:", error);
        throw error;
      } finally {
        invalidateSessionListCache();
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "name or pinned is required" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    // 画布引用清理（断 exec 线/清任务卡/删节点，幂等）：无论文件状态都先执行——
    // 保证会话文件已丢失/未落盘时，看板卡片也能删除，不留孤儿。
    const boardClean = removeSessionFromBoards(id);

    const filePath = await resolveSessionPath(id);
    if (!filePath || !existsSync(filePath)) {
      // 会话文件未落盘（Pi 延迟首次 JSONL flush）或已丢失：仍停止运行实例并
      // 清理归属元数据（幂等删除）。否则“文件不存在”会让 session_meta
      // 残留成僵尸记录（任务会话列表/看板补卡还会引用它）。
      await getRpcSession(id)?.shutdown();
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      // 没有文件就无从得知祖父（拿不到 → NULL）：子行不能留下指向已删 id 的悬空 parent_id。
      reparentSessionChildren(id, null);
      unassignSession(id);
      await removeSessionsFromYjsBoards([id]);
      return NextResponse.json({ ok: true, updatedBoards: toUpdatedBoards(boardClean.boards) });
    }

    // Read only the bounded header before deleting. header 读取失败（并发删除/损坏）
    // 时跳过子树重挂，直接删除（子会话保留其父指针，不级联误改）。
    let parentSessionPath: string | undefined;
    try {
      parentSessionPath = readSessionHeader(filePath)?.parentSession;
    } catch {
      parentSessionPath = undefined;
    }

    // Re-attach all direct children to this session's parent (cascade re-parent).
    // 子行路径从**库**取（不 readdir）：会话文件可能在子目录里（`forks/`、`<session>/<run>/`），
    // 平铺 `readdirSync(dirname(父文件))` 只能看到同级文件，漏掉的子行磁盘 header 仍指向
    // 已删父→下一轮扫描按磁盘把库内 parent_id 改回 NULL（把库侧的祖父重挂白忙一场）。
    if (parentSessionPath !== undefined) {
      const targetPathKey = sessionPathKey(filePath);
      for (const childPath of listChildPaths(id)) {
        // 防御脏行（parent_id 自指）——不要把被删文件自己当子行写坏
        if (sessionPathKey(childPath) === targetPathKey) continue;
        rewriteSessionParent(childPath, targetPathKey, parentSessionPath);
      }
    }

    // 库内子行必须同请求改 parent_id：T5 之后「根」判定全来自 session_meta（库是
    // 父子链事实源），只改磁盘 header 的话子行仍指向已删 id，子会话会以根行呈现
    // 到扫描器收敛为止（≤30s）。祖父 id 由磁盘 header.parentSession 反查；
    // 反查不到（父行/文件已不在）就写 NULL（子会话变临时根，而不是悬空指针）。
    let grandparentId: string | null = null;
    if (parentSessionPath) {
      grandparentId = (await resolveSessionIdByPath(parentSessionPath)) ?? null;
    }
    reparentSessionChildren(id, grandparentId);

    await getRpcSession(id)?.shutdown();
    try {
      unlinkSync(filePath); // 文件已被并发删除时忽略（健壮删除）
    } catch { /* ignore */ }
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    unassignSession(id);
    // RF 画布（yjs）清理：普通看板无 reconcile 兜底，会话卡会永久残留（幽灵卡）——
    // 单删也走 removeSessionsFromYjsBoards（无 __yjsBoard 时为空操作）。
    await removeSessionsFromYjsBoards([id]);
    return NextResponse.json({ ok: true, updatedBoards: toUpdatedBoards(boardClean.boards) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

/** { boardId: updated } 映射（前端刷新乐观锁基线用） */
function toUpdatedBoards(boards: Array<{ boardId: string; updated: number }>): Record<string, number> {
  return Object.fromEntries(boards.map((b) => [b.boardId, b.updated]));
}

/** 把子会话文件 header 的 parentSession 从「被删会话」改写成祖父。
 *  只动确实指向被删会话的文件：读不到 / 损坏 / 文件不在盘上（Pi 延迟 flush）一律跳过，
 *  不阻塞删除；库侧由 reparentSessionChildren 保证两者同向。 */
function rewriteSessionParent(childPath: string, deletedPathKey: string, newParentPath: string): void {
  try {
    const content = readFileSync(childPath, "utf8");
    const lines = content.split("\n");
    const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
    if (header.type !== "session" || !header.parentSession) return;
    if (sessionPathKey(header.parentSession) !== deletedPathKey) return;
    header.parentSession = newParentPath;
    lines[0] = JSON.stringify(header);
    writeFileSync(childPath, lines.join("\n"));
  } catch { /* skip malformed / unreadable / missing */ }
}
