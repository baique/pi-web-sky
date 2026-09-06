import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  loadChatSessionsPage,
  loadProjectSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { listAllTaskSessionIds } from "@/lib/task-store";

export const dynamic = "force-dynamic";

// GET /api/sessions[?force=1][&offset=0&limit=20]  （旧调用方，分页保留过渡）
// GET /api/sessions?project=<key>                 （列表重构 v2：单项目无分页）
// GET /api/sessions                              （无参全量：看板标题映射/会话恢复兼容）
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

    const force = search.get("force") === "1";
    const rawOffset = Number(search.get("offset"));
    const rawLimit = Number(search.get("limit"));
    // 必须显式带 offset+limit 才走分页（force=1 / 不带参数 → 全量路径）
    const paginated = search.has("offset") && search.has("limit") && Number.isFinite(rawOffset) && Number.isFinite(rawLimit);

    if (paginated) {
      const { pinned, sessions, total, sessionIds } = await loadChatSessionsPage({
        offset: rawOffset,
        limit: rawLimit,
      });
      // 运行时会话（新建未落盘/活跃中）并入聊天区：磁盘扫描看不到它们，
      // 但侧栏要能立即渲染。任务归属的运行时会话在此一并过滤（不进聊天区）。
      // 单独返回 runtime 字段：分页 offset/total 只按磁盘会话计，运行时会话
      // 是每页附带的附加展示，混进 sessions 会把前端 offset 游标污染（滚动
      // 到尾部后 offset 永远 < total 但每次都是重复 runtime → 加载"失效"）。
      const runtime = await attachSessionProjectInfo(getRpcSessionInfos());
      const taskSessionIds = listAllTaskSessionIds();
      const pinnedIds = new Set(pinned.map((s) => s.id));
      const pageIds = new Set(sessions.map((s) => s.id));
      const extraRuntime = runtime.filter(
        (s) => !taskSessionIds.has(s.id) && !pinnedIds.has(s.id) && !pageIds.has(s.id),
      );
      // 置顶区独立全量返回，客户端滚动分页只作用于非置顶区。
      // sessionIds：全量聊天区会话 id（含置顶），供前端增量合并剔除已删/移出会话。
      return NextResponse.json(
        {
          pinned,
          sessions,
          runtime: extraRuntime,
          total,
          sessionIds,
          offset: rawOffset,
          limit: rawLimit,
          runningSessionIds: getRunningRpcSessionIds(),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const [persistedSessions, runtimeSessions] = await Promise.all([
      listAllSessions({ force }),
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
