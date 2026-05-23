import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.ts";

let _db: Database | null = null;

export function db(): Database {
  if (_db) return _db;
  fs.mkdirSync(config.runtime.dataDir, { recursive: true });
  const dbPath = path.join(config.runtime.dataDir, "harness.db");
  const d = new Database(dbPath);
  d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(d);
  _db = d;
  return d;
}

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      local_path TEXT NOT NULL,
      language TEXT,
      build_system TEXT,
      focus_areas TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      added_at TEXT NOT NULL,
      arch_doc_path TEXT
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      parent_id TEXT,
      target_id TEXT,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, kind);
    CREATE INDEX IF NOT EXISTS idx_tasks_target ON tasks(target_id);

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL,
      attack_class TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      trust_boundary TEXT,
      attacker_input TEXT,
      primary_location TEXT NOT NULL,
      related_locations TEXT NOT NULL DEFAULT '[]',
      poc TEXT,
      validated INTEGER NOT NULL DEFAULT 0,
      validator_rationale TEXT,
      reachable INTEGER,
      dedup_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reported_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_findings_dedup ON findings(target_id, dedup_hash);
    CREATE INDEX IF NOT EXISTS idx_findings_target ON findings(target_id);

    CREATE TABLE IF NOT EXISTS arch_docs (
      target_id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      built_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runlog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      stage TEXT,
      task_id TEXT,
      target_id TEXT,
      message TEXT NOT NULL,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runlog_ts ON runlog(ts);

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_emails (
      uid TEXT PRIMARY KEY,
      message_id TEXT,
      processed_at TEXT NOT NULL
    );
  `);
}

export function setKV(key: string, value: string) {
  db().run(
    `INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export function getKV(key: string): string | null {
  const row = db().query("SELECT value FROM kv WHERE key=?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}
