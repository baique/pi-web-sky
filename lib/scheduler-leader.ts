// ============================================================================
// 单调度者（leader election）
//
// 多实例共库时，调度动作（派发 / 巡检 / 审核 / 续会话 / 定时 reconcile）只允许
// 一个实例执行，否则会出现窗口期竞争（双会话、重复审核、误翻状态）。
// 方案：sqlite 单行表 scheduler_leader 注册——谁先启动谁注册，谁注册谁是唯一
// 调度者；心跳续期；心跳过期（LEADER_STALE_MS）其他实例可接管。
//
// 原子性：所有注册/续期/接管都是单条条件 SQL（SQLite 单写者），多实例并发时
// 恰好一个成功，无应用层锁。
// ============================================================================
import { randomUUID } from "crypto";
import { getDb } from "./sqlite-db";

/** leader 心跳续期周期（与调度 tick 同频：每个 tick 先续期，续上才跑调度） */
export const LEADER_HEARTBEAT_MS = 10_000;
/** leader 心跳过期阈值：超时视为 leader 已死，其他实例可接管 */
export const LEADER_STALE_MS = 30_000;

declare global {
  /** 本进程实例 id（防热重载换 id；多实例各持不同 id） */
  var __piWebInstanceId: string | undefined;
}

/** 本进程实例 id：随机 UUID，globalThis 缓存（热重载不换），多实例各不同。 */
export function getInstanceId(): string {
  if (!globalThis.__piWebInstanceId) globalThis.__piWebInstanceId = randomUUID();
  return globalThis.__piWebInstanceId;
}

/** 无条件清空注册（测试用；生产路径不调用——leader 切换靠心跳过期接管）。 */
export function clearSchedulerLeaderForTesting(): void {
  getDb().prepare("DELETE FROM scheduler_leader").run();
}

function now(): number {
  return Date.now();
}

interface LeaderRow {
  id: number;
  instance_id: string;
  registered_at: number;
  heartbeat: number;
}

function readLeader(): LeaderRow | undefined {
  return getDb().prepare("SELECT id, instance_id, registered_at, heartbeat FROM scheduler_leader WHERE id = 1").get() as LeaderRow | undefined;
}

/**
 * 尝试成为/续期 leader（幂等，可每个调度 tick 调一次）。
 * - 表空 → INSERT 注册（原子，谁先插谁赢）
 * - 行是我 → 续期 heartbeat（原子条件 UPDATE）
 * - 行是别人且心跳新鲜 → 失败（他人活着，本实例不做调度）
 * - 行是别人且心跳过期 → 条件 UPDATE 接管（谁先抢谁赢）
 * 返回 true = 本实例当前是唯一调度者。
 */
export function tryBecomeLeader(instanceId: string): boolean {
  const db = getDb();
  const ts = now();

  const existing = readLeader();
  if (!existing) {
    const res = db
      .prepare("INSERT INTO scheduler_leader (id, instance_id, registered_at, heartbeat) VALUES (1, ?, ?, ?)")
      .run(instanceId, ts, ts);
    return Number(res.changes) > 0;
  }
  if (existing.instance_id === instanceId) {
    const res = db
      .prepare("UPDATE scheduler_leader SET heartbeat = ? WHERE id = 1 AND instance_id = ?")
      .run(ts, instanceId);
    return Number(res.changes) > 0;
  }
  // 别人持有：心跳过期才接管（条件 UPDATE 原子，多实例并发只有一个成功）
  if (now() - existing.heartbeat < LEADER_STALE_MS) return false;
  const res = db
    .prepare("UPDATE scheduler_leader SET instance_id = ?, registered_at = ?, heartbeat = ? WHERE id = 1 AND instance_id = ? AND heartbeat = ?")
    .run(instanceId, ts, ts, existing.instance_id, existing.heartbeat);
  return Number(res.changes) > 0;
}

/** 当前 leader 实例 id（无注册返回 null）。 */
export function getLeaderInstanceId(): string | null {
  const row = readLeader();
  if (!row) return null;
  // 心跳过期视同无 leader（让位给下一次 tryBecomeLeader 接管）
  if (now() - row.heartbeat >= LEADER_STALE_MS) return null;
  return row.instance_id;
}

/** 本实例是否为当前唯一调度者（注册存在 + 心跳新鲜 + 是我）。 */
export function isLeader(): boolean {
  const row = readLeader();
  if (!row) return false;
  return row.instance_id === getInstanceId() && now() - row.heartbeat < LEADER_STALE_MS;
}
