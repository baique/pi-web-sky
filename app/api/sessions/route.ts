import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  loadAllSessionIndex,
  loadProjectSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { listAllTaskSessionIds } from "@/lib/task-store";

export const dynamic = "force-dynamic";

// GET /api/sessions?project=<key>  （列表重构 v2：单项目无分页）
// GET /api/sessions               （无参全量：看板标题映射/会话恢复兼容）
export async function GET(req: Request) {
  try {
    const search = new URL(req.url).searchParams;
    const projectKey = search.get("project");

    if (projectKey) {
      // 列表重构 v2 主路径：单项目会话，纯查 session_meta（loadProjectSessions），
      // union 同项目运行中/未落盘 runtime 会话，服务端一次排好序。
      const [persisted, runtime, runningIds] = await Promise.all([
        loadProjectSessions(projectKey),
        attachSessionProjectInfo(getRpcSessionInfos()),
        Promise.resolve(getRunningRpcSessionIds()),
      ]);
      const taskSessionIds = listAllTaskSessionIds();
      const persistedIds = new Set(persisted.map((s) => s.id));
      const extraRuntime = runtime.filter(
        (s) =>
          s.projectKey === projectKey
          && !taskSessionIds.has(s.id)
          && !persistedIds.has(s.id),
      );
      return NextResponse.json(
        {
          sessions: [...persisted, ...extraRuntime],
          runningSessionIds: runningIds,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [persistedSessions, runtimeSessions] = await Promise.all([
      loadAllSessionIndex(),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return NextResponse.json(
      { sessions, runningSessionIds: getRunningRpcSessionIds() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
