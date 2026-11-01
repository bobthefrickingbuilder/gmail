/**
 * DATABASE CONNECTION
 * Picks SQLite or Postgres from DATABASE_URL and runs migrations on start.
 *   sqlite:./data/assistant.sqlite     (default, home server)
 *   sqlite::memory:                    (tests)
 *   postgres://user:pass@host/db       (Vercel + Neon)
 */
import fs from "node:fs";
import path from "node:path";
import { Kysely, SqliteDialect, PostgresDialect } from "kysely";
import { Migrator } from "kysely/migration";
import Database from "better-sqlite3";
import pg from "pg";
import type { DB } from "./schema.js";
import { StaticMigrationProvider } from "./migrations.js";
import { env } from "../config.js";

export type Db = Kysely<DB>;
let instance: Db | null = null;

export function createDb(url: string): Db {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 5 }) }) });
  }
  const file = url.replace(/^sqlite:/, "");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
}

export async function migrate(db: Db) {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return results ?? [];
}

/** Shared connection for the running app. */
export async function getDb(): Promise<Db> {
  if (!instance) {
    instance = createDb(env().DATABASE_URL);
    await migrate(instance);
  }
  return instance;
}
/** Tests inject their own in-memory database. */
export function setDb(db: Db | null) { instance = db; }

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const j = (v: unknown) => JSON.stringify(v ?? null);
export function pj<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
