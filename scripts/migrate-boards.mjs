#!/usr/bin/env node
// ============================================================================
// 数据迁移：pi-web.db 的 board_nodes/board_edges/board_view → sync.db 的 tldraw 文档
//   - 每看板一个 SQLiteSyncStorage（sync.db，tablePrefix=board_<id>_）
//   - 迁移前请停止 sync-server（避免双进程写同一 sync.db 锁冲突）
// 执行：node scripts/migrate-boards.mjs
// 幂等：全量重写该看板文档 lane（先清空该 board 的 records 再写入）
// ============================================================================
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { homedir } from "node:os";
import { join, normalize } from "node:path";

const { DatabaseSync } = require("node:sqlite");
const core = require("@tldraw/sync-core");
const tlschema = require("@tldraw/tlschema");
const T = require("@tldraw/validate").T;
const utils = require("@tldraw/utils");

// ---- agent dir（与 lib/sqlite-db.ts 同语义）----
function getAgentDir() {
  const envDir = process.env.PI_CODING_AGENT_DIR;
  if (envDir) {
    const expanded = envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
    return normalize(expanded);
  }
  return join(homedir(), ".pi", "agent");
}
const PI_WEB_DB = join(getAgentDir(), "pi-web.db");
const SYNC_DB = join(getAgentDir(), "sync.db");

const schema = tlschema.createTLSchema({
  shapes: {
    ...tlschema.defaultShapeSchemas,
    // 与 scripts/sync-server.mjs 保持一致（自定义 shape 必须两端同 schema，否则校验不匹配）
    "session-card": {
      props: {
        sessionId: T.string, title: T.string, projectName: T.string,
        messageCount: T.number, lastReply: T.string, phase: T.string,
        runningMs: T.number, endedAt: T.number, lastActivityAt: T.number,
        stale: T.boolean, expanded: T.boolean, cwd: T.string, taskId: T.string,
        w: T.number, h: T.number, expandedW: T.number, expandedH: T.number,
        collapsedW: T.number, collapsedH: T.number,
      },
    },
    "sticky-note": {
      props: { text: T.string, w: T.number, h: T.number, badge: T.string.optional(), createdAt: T.number.optional() },
    },
    "task-card": {
      props: {
        cardId: T.string, number: T.number, name: T.string,
        readyStatus: T.string, execStatus: T.string, priority: T.number,
        due: T.number.optional(), expanded: T.boolean,
        w: T.number, h: T.number, expandedW: T.number, expandedH: T.number,
        collapsedW: T.number, collapsedH: T.number,
      },
    },
  },
  bindings: { ...tlschema.defaultBindingSchemas },
  assets: { ...tlschema.defaultAssetSchemas },
});

const SYSTEM_RUNNING = "__running__";
let indexCounter = 0;
let indexState = null;
// 合法 IndexKey（fractional-indexing）："a"+数字 在 36+ 时非法（如 a10），必须用 getIndexAbove
const nextIndex = () => { indexState = utils.getIndexAbove(indexState); return indexState; };

function safePrefix(boardId) {
  return `board_${boardId.replace(/[^a-zA-Z0-9_]/g, "_")}_`;
}

// 读 pi-web.db（只读）的所有非系统看板
function listBoards(db) {
  return db
    .prepare("SELECT id, name, task_id AS taskId FROM boards WHERE id != ? ORDER BY sort_order, created")
    .all(SYSTEM_RUNNING);
}

// 构造 shape/binding records（映射逻辑对齐前端 hydrateShapes/serializeShapes）
// 注意：pi-web.db 读出的列名是 snake_case（from_id/to_id/ref_id/expanded...）
function buildRecords(nodes, edges) {
  const records = [
    { id: "document:document", typeName: "document", gridSize: 10, name: "", meta: {} },
    { id: "page:page", typeName: "page", name: "Page 1", index: "a0", meta: {} },
  ];
  // group 节点（type='group'）不是合法 shape record（tldraw 中 group 是独立类型），
  // 迁移时跳过：其子 shape 的 parentId 重新挂到 page:page。
  const groupIds = new Set(
    nodes.filter((n) => n.kind === "shape" && (JSON.parse(n.props ?? "{}").type === "group")).map((n) => n.id),
  );
  // 节点中心（arrow 端点用）
  const center = new Map();
  for (const n of nodes) {
    if (groupIds.has(n.id)) continue;
    center.set(n.id, { x: n.x + (n.w || 340) / 2, y: n.y + (n.h || 160) / 2 });
  }
  const base = (id, type, x, y, w, h, props, meta = {}) => ({
    id: `shape:${id}`, typeName: "shape", type, x, y, rotation: 0,
    index: nextIndex(), parentId: "page:page", isLocked: false, opacity: 1,
    props, meta,
  });
  for (const n of nodes) {
    const p = JSON.parse(n.props ?? "{}");
    if (n.kind === "session") {
      // session-card：摘要字段留默认（title 等由前端摘要轮询填充）
      records.push(base(n.id, "session-card", n.x, n.y, n.w || 340, n.h || 160, {
        sessionId: n.ref_id ?? "", title: "Untitled", projectName: "",
        messageCount: 0, lastReply: "", phase: "idle", runningMs: 0, endedAt: 0,
        lastActivityAt: 0, stale: n.ref_id ? false : true, expanded: Boolean(n.expanded),
        cwd: p.cwd ?? "", taskId: p.taskId ?? "",
        w: n.w || 340, h: n.h || 160,
        expandedW: p.expandedW ?? 0, expandedH: p.expandedH ?? 0,
        collapsedW: p.collapsedW ?? 0, collapsedH: p.collapsedH ?? 0,
      }));
    } else if (n.kind === "taskcard") {
      const sp = p.shapeProps ?? {};
      records.push(base(n.id, "task-card", n.x, n.y, n.w || 380, n.h || 270, {
        cardId: n.ref_id ?? "", number: sp.number ?? 0, name: sp.name ?? "新建任务",
        readyStatus: sp.readyStatus ?? "draft", execStatus: sp.execStatus ?? "not_started",
        priority: sp.priority ?? 0, due: sp.due, expanded: Boolean(n.expanded),
        w: n.w || 380, h: n.h || 270,
        expandedW: sp.expandedW ?? 0, expandedH: sp.expandedH ?? 0,
        collapsedW: sp.collapsedW ?? 0, collapsedH: sp.collapsedH ?? 0,
      }));
    } else if (n.kind === "shape") {
      if (groupIds.has(n.id)) continue; // group 跳过（非 shape record）
      const st = p.type ?? "geo";
      // 子 shape 若父是 group（已跳过）→ 重挂 page:page
      const parentIsGroup = p.parentId && groupIds.has(String(p.parentId));
      records.push({ ...base(n.id, st, n.x, n.y, 0, 0, p.shapeProps ?? {}), rotation: p.rotation ?? 0, parentId: "page:page" });
      void parentIsGroup;
    }
  }
  // 边 → arrow + binding
  for (const e of edges) {
    const from = center.get(e.from_id);
    const to = center.get(e.to_id);
    if (!from || !to) continue;
    const meta = e.label === "prerequisite" || e.label === "related"
      ? { taskLinkLabel: e.label }
      : e.label === "exec" ? { execLinkLabel: "exec" } : {};
    records.push({
      id: `shape:${e.id}`, typeName: "shape", type: "arrow", x: 0, y: 0, rotation: 0,
      index: nextIndex(), parentId: "page:page", isLocked: false, opacity: 1,
      props: {
        start: { x: from.x, y: from.y }, end: { x: to.x, y: to.y },
        color: e.color ?? "blue", fill: "none", dash: e.dashed ? "dashed" : "solid",
        arrowheadStart: "none", arrowheadEnd: "arrow", labelColor: "black",
        font: "sans", richText: { type: "doc", content: [] }, scale: 1, size: "m",
        bend: 0, kind: "elbow", labelPosition: 0.5, elbowMidPoint: 0.5,
      },
      meta,
    });
    records.push(
      { id: `binding:${e.id}:start`, typeName: "binding", type: "arrow", fromId: `shape:${e.id}`, toId: `shape:${e.from_id}`, meta: {}, props: { terminal: "start", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" } },
      { id: `binding:${e.id}:end`, typeName: "binding", type: "arrow", fromId: `shape:${e.id}`, toId: `shape:${e.to_id}`, meta: {}, props: { terminal: "end", isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 }, snap: "none" } },
    );
  }
  return records;
}

// 写 sync.db 的某看板文档：首次迁移直接写（sync.db 不存在/已手动删除）；
// 重迁移需先删除 sync.db（或清对应 board 表前缀），否则旧 records 残留。
function writeBoard(syncDb, boardId, records) {
  const storage = new core.SQLiteSyncStorage({
    sql: new core.NodeSqliteWrapper(syncDb, { tablePrefix: safePrefix(boardId) }),
  });
  storage.transaction((txn) => {
    for (const rec of records) txn.set(rec.id, rec);
  });
  return records.length;
}

// 主流程
const piDb = new DatabaseSync(PI_WEB_DB, { readOnly: true });
const syncDb = new DatabaseSync(SYNC_DB);
const boards = listBoards(piDb);
let total = 0;
for (const b of boards) {
  const nodes = piDb.prepare("SELECT * FROM board_nodes WHERE board_id = ? ORDER BY created").all(b.id);
  const edges = piDb.prepare("SELECT * FROM board_edges WHERE board_id = ? ORDER BY created").all(b.id);
  const records = buildRecords(nodes, edges);
  const arrowCount = records.filter((r) => r.typeName === "shape" && r.type === "arrow").length;
  const bindingCount = records.filter((r) => r.typeName === "binding").length;
  if (b.id === "3e1062a3-c26e-4124-a61e-b9a44609beba") {
    console.log(`[migrate:debug] board=${b.name} edges=${edges.length} records=${records.length} arrows=${arrowCount} bindings=${bindingCount}`);
    for (const e of edges) console.log(`[migrate:debug]   edge ${e.id.slice(0,8)} ${e.from_id.slice(0,8)} -> ${e.to_id.slice(0,8)} label=${e.label}`);
  }
  const n = writeBoard(syncDb, b.id, records);
  total += n;
  console.log(`[migrate] board ${b.id.slice(0, 8)} (${b.name}) → ${nodes.length} nodes + ${edges.length} edges = ${n} records`);
}
console.log(`[migrate] done: ${boards.length} boards, ${total} records`);
piDb.close();
syncDb.close();
