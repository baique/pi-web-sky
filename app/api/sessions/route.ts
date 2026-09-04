import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  loadChatSessionsPage,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { listAllTaskSessionIds } from "@/lib/task-store";

export const dynamic = "force-dynamic";

// GET /api/sessions[?force=1][&offset=0&limit=20]
//   offset/limit 同时存在 → 聊天区两阶段分页（置顶全量 + 非置顶当前页 + total）
//   不带分页参数 → 全量列表（看板标题映射 / 会话恢复等消费方兼容）
export async function GET(req: Request) {
  try {
    const search = new URL(req.url).searchParams;
    const force = search.get("force") === "1";
    const rawOffset = Number(search.get("offset"));
    const rawLimit = Number(search.get("limit"));
    // 必须显式带 offset+limit 才走分页（force=1 / 不带参数 → 全量路径）
    const paginated = search.has("offset") && search.has("limit") && Number.isFinite(rawOffset) && Number.isFinite(rawLimit);

    if (paginated) {
      const { pinned, sessions, total } = await loadChatSessionsPage({
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
      return NextResponse.json(
        {
          pinned,
          sessions,
          runtime: extraRuntime,
          total,
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
