// ============================================================================
// 会话列表「已变更」信号
//
// 谁需要知道：列表不再有服务端缓存（每次读取 = 一次单表查询），但**前端**的列表
// 只在挂载/项目切换/本地动作（新建、删除、改名、拖拽）时重拉——服务端写进去的
// 新标题、首条消息、最后回复、外部（CLI）新建的会话，都要等下一次重拉才现身。
//
// 机制：任何影响列表读取的写路径都 mark 一次（自增计数器），`/api/agent/running`
// 的轮询把它带给前端（侧栏本来就每 2.5s 拉一次），前端见变化就重拉列表。
//
// **进程内计数器**（与库同进程的写入才可见）：同时跑多个 pi-web 实例、共用一个
// `pi-web.db` 时，A 进程的写不会推给 B 进程的侧栏——B 只能靠自己的 30s 扫描器按
// 文件 mtime 收敛。跨进程唯一可靠的事实源是库本身（真要做就是库里的代次行）。
//
// 单独成文件只为打断循环依赖：`session-reader` 已经 import 扫描器（ensureSessionIndexReady），
// 扫描器不能再反向 import `session-reader` 的 invalidateSessionListCache。globalThis
// 存活热重载（模块级变量不会）。
// ============================================================================

declare global {
  var __piSessionListGeneration: number | undefined;
}

/** 列表内容已变（标题/首条消息/最后回复/排序/新建/删除）。写路径调用，幂等无副作用。 */
export function markSessionListChanged(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
}

/** 当前代次：前端比对「我上次看到的」与「这次拿到的」，不等即重拉列表。 */
export function getSessionListGeneration(): number {
  return globalThis.__piSessionListGeneration ?? 0;
}
