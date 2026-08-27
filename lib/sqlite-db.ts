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
}