import { DatabaseSync } from "node:sqlite";
import { homedir } from "os";
import { join, normalize } from "path";

/** Same semantics as the SDK's getAgentDir — keeps this module SDK-free so
 *  unit tests can load it without pulling in the whole coding-agent dist. */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export function getAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    const expanded = envDir.startsWith("~") ? join(homedir(), envDir.slice(1)) : envDir;
    return normalize(expanded);
  }
  return join(homedir(), ".pi", "agent");
}

declare global {
  var __piWebDb: DatabaseSync | undefined;
}

export const DB_FILE_NAME = "pi-web.db";

/** Absolute path of the single pi-web database (lives next to agent dir). */
export function dbPath(): string {
  return join(getAgentDir(), DB_FILE_NAME);
}

/** Inject a database for tests (e.g. `:memory:`). Overrides the singleton and
 *  ensures the schema is present so callers can use it immediately. */
export function setDbForTesting(db: DatabaseSync): void {
  initSchema(db);
  globalThis.__piWebDb = db;
}

/**
 * Open (once) and return the pi-web database, creating tables on first use.
 * Stored on globalThis so it survives Next.js hot-reload like the other
 * singletons in this codebase.
 */
export function getDb(): DatabaseSync {
  if (globalThis.__piWebDb) return globalThis.__piWebDb;
  const db = new DatabaseSync(dbPath());
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  initSchema(db);
  globalThis.__piWebDb = db;
  return db;
}

/** Idempotent DDL — run on every open; `IF NOT EXISTS` keeps it cheap. */
export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      name        TEXT NOT NULL,
      created     INTEGER NOT NULL,
      updated     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_key);

    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      task_id    TEXT,
      updated    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_meta_task ON session_meta(task_id);

    CREATE TABLE IF NOT EXISTS search_state (
      session_id TEXT PRIMARY KEY,
      mtime      TEXT NOT NULL,
      title      TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5(
      session_id UNINDEXED,
      title,
      body,
      tokenize = 'trigram'
    );
  `);
  migrate(db);
}

/**
 * 版本化迁移：用 PRAGMA user_version 记录当前 schema 版本。
 * 老库打开时自动按序补齐缺失的迁移（每个迁移一个事务，成功后推进版本号），
 * 新库建表后从 v0 一路迁到 SCHEMA_VERSION。重复打开不再执行已完成的迁移。
 */
export const SCHEMA_VERSION = 7;

interface Migration {
  version: number;
  name: string;
  /** 单条语句串；每条独立执行，包在同一个事务里。 */
  statements: string[];
}

/** 迁移历史（按版本升序）。只允许追加，不允许修改/删除历史项。 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "pinned columns",
    statements: [
      "ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
      "ALTER TABLE session_meta ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
    ],
  },
  {
    version: 2,
    name: "tasks.sort_order",
    statements: [
      "ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    ],
  },
  {
    version: 3,
    name: "session boards",
    statements: [
      "CREATE TABLE IF NOT EXISTS boards (\n  id          TEXT PRIMARY KEY,\n  project_key TEXT NOT NULL,\n  name        TEXT NOT NULL,\n  is_system   INTEGER NOT NULL DEFAULT 0,\n  created     INTEGER NOT NULL,\n  updated     INTEGER NOT NULL\n);",
      "CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_key);",
      "CREATE TABLE IF NOT EXISTS board_nodes (\n  id         TEXT PRIMARY KEY,\n  board_id   TEXT NOT NULL,\n  kind       TEXT NOT NULL,\n  ref_id     TEXT,\n  x          REAL NOT NULL,\n  y          REAL NOT NULL,\n  w          REAL NOT NULL DEFAULT 0,\n  h          REAL NOT NULL DEFAULT 0,\n  expanded   INTEGER NOT NULL DEFAULT 0,\n  props      TEXT NOT NULL DEFAULT '{}',\n  created    INTEGER NOT NULL,\n  updated    INTEGER NOT NULL\n);",
      "CREATE INDEX IF NOT EXISTS idx_board_nodes_board ON board_nodes(board_id);",
      "CREATE TABLE IF NOT EXISTS board_edges (\n  id       TEXT PRIMARY KEY,\n  board_id TEXT NOT NULL,\n  from_id  TEXT NOT NULL,\n  to_id    TEXT NOT NULL,\n  label    TEXT,\n  color    TEXT,\n  dashed   INTEGER NOT NULL DEFAULT 0,\n  created  INTEGER NOT NULL,\n  updated  INTEGER NOT NULL\n);",
      "CREATE INDEX IF NOT EXISTS idx_board_edges_board ON board_edges(board_id);",
      "CREATE TABLE IF NOT EXISTS board_view (\n  board_id   TEXT PRIMARY KEY,\n  camera_x   REAL NOT NULL DEFAULT 0,\n  camera_y   REAL NOT NULL DEFAULT 0,\n  camera_z   REAL NOT NULL DEFAULT 1,\n  updated    INTEGER NOT NULL\n);",
    ],
  },
  {
    version: 4,
    name: "boards.sort_order",
    statements: [
      "ALTER TABLE boards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    ],
  },
  {
    version: 5,
    name: "boards.task_id",
    statements: [
      "ALTER TABLE boards ADD COLUMN task_id TEXT NULL;",
      "CREATE INDEX IF NOT EXISTS idx_boards_task ON boards(task_id);",
    ],
  },
  {
    version: 6,
    name: "boards.task_id unique (防并发重复创建任务看板)",
    statements: [
      // 任务看板 id = 任务 id，task_id 必须唯一。SQLite UNIQUE 索引允许多个 NULL，
      // 手动看板（task_id=NULL）不受影响。并发懒创建时由数据库层拒绝重复插入。
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_task_unique ON boards(task_id);",
    ],
  },
  {
    version: 7,
    name: "task cards",
    statements: [
      "CREATE TABLE IF NOT EXISTS task_cards (\n  id            TEXT PRIMARY KEY,\n  board_id      TEXT NOT NULL,\n  project_key   TEXT NOT NULL,\n  number        INTEGER NOT NULL,\n  name          TEXT NOT NULL,\n  description   TEXT NOT NULL DEFAULT '',\n  ready_status  TEXT NOT NULL DEFAULT 'draft',\n  exec_status   TEXT NOT NULL DEFAULT 'not_started',\n  priority      INTEGER NOT NULL DEFAULT 0,\n  due           INTEGER,\n  attachments   TEXT NOT NULL DEFAULT '[]',\n  cwd           TEXT,\n  use_worktree  INTEGER NOT NULL DEFAULT 0,\n  max_retries   INTEGER NOT NULL DEFAULT 3,\n  retry_count   INTEGER NOT NULL DEFAULT 0,\n  session_id    TEXT,\n  created       INTEGER NOT NULL,\n  updated       INTEGER NOT NULL\n);",
      "CREATE INDEX IF NOT EXISTS idx_task_cards_board ON task_cards(board_id);",
      "CREATE INDEX IF NOT EXISTS idx_task_cards_project ON task_cards(project_key);",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_cards_number ON task_cards(project_key, number);",
      "CREATE INDEX IF NOT EXISTS idx_task_cards_status ON task_cards(ready_status, exec_status);",
      "CREATE TABLE IF NOT EXISTS task_card_links (\n  id             TEXT PRIMARY KEY,\n  card_id        TEXT NOT NULL,\n  target_card_id TEXT NOT NULL,\n  kind           TEXT NOT NULL,\n  created        INTEGER NOT NULL,\n  UNIQUE(card_id, target_card_id, kind)\n);",
      "CREATE INDEX IF NOT EXISTS idx_task_links_card ON task_card_links(card_id);",
      "CREATE TABLE IF NOT EXISTS task_card_questions (\n  id         TEXT PRIMARY KEY,\n  card_id    TEXT NOT NULL,\n  session_id TEXT NOT NULL,\n  question   TEXT NOT NULL,\n  status     TEXT NOT NULL DEFAULT 'pending',\n  answer     TEXT,\n  created    INTEGER NOT NULL,\n  answered   INTEGER\n);",
      "CREATE INDEX IF NOT EXISTS idx_task_questions_status ON task_card_questions(status);",
    ],
  },
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    db.exec("BEGIN");
    try {
      for (const stmt of m.statements) {
        try {
          db.exec(stmt);
        } catch (error) {
          // 老库在无版本管理时代可能已手动加过列（幂等 ADD COLUMN 路径），
          // 列已存在时跳过该语句，不阻断整批迁移。
          const msg = error instanceof Error ? error.message : String(error);
          if (!/duplicate column name/i.test(msg)) throw error;
        }
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
      version = m.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}