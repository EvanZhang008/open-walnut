/**
 * The health store: ~/.open-walnut/health/health.sqlite (Mac only).
 *
 * Storage primitive only (schema, pragmas, meta). The primary is the ONLY writer:
 * a cloud replica relays every call and must never open this file, which
 * getHealthDb() enforces rather than trusting each caller to check.
 *
 * The directory is kept out of git-sync (CRITICAL_IGNORE_DIRS) and out of the S3
 * backup (EXCLUDED_DIRS): the raw samples and this store never leave this machine.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'

export function healthDir(): string {
  return path.join(WALNUT_HOME, 'health')
}

export function healthDbPath(): string {
  return path.join(healthDir(), 'health.sqlite')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  uuid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  value REAL,
  code INTEGER,
  source_bundle TEXT NOT NULL,
  source_name TEXT NOT NULL,
  device TEXT,
  tz TEXT NOT NULL,
  local_date TEXT NOT NULL,
  night_date TEXT NOT NULL,
  user_entered INTEGER NOT NULL DEFAULT 0,
  meta TEXT,
  gen INTEGER
);
CREATE INDEX IF NOT EXISTS samples_type_end ON samples(type, end_ms);
CREATE INDEX IF NOT EXISTS samples_type_night ON samples(type, night_date);
CREATE INDEX IF NOT EXISTS samples_type_date ON samples(type, local_date);
CREATE INDEX IF NOT EXISTS samples_date ON samples(local_date);
CREATE INDEX IF NOT EXISTS samples_gen ON samples(gen) WHERE gen IS NOT NULL;
-- health_status asks "is there any manual entry"; without this it read the whole table.
CREATE INDEX IF NOT EXISTS samples_manual ON samples(user_entered) WHERE user_entered = 1;

CREATE TABLE IF NOT EXISTS buckets (
  metric TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  interval_sec INTEGER NOT NULL,
  sum REAL, avg REAL, min REAL, max REAL, count INTEGER,
  tz TEXT NOT NULL,
  local_date TEXT NOT NULL,
  night_date TEXT NOT NULL,
  gen INTEGER,
  PRIMARY KEY (metric, start_ms, interval_sec)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS buckets_metric_date ON buckets(metric, local_date);
CREATE INDEX IF NOT EXISTS buckets_metric_night ON buckets(metric, night_date);
CREATE INDEX IF NOT EXISTS buckets_date ON buckets(local_date);
CREATE INDEX IF NOT EXISTS buckets_gen ON buckets(gen) WHERE gen IS NOT NULL;

CREATE TABLE IF NOT EXISTS sources (
  bundle TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_sample_ms INTEGER NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL,
  apple INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nights (date TEXT PRIMARY KEY, rev INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS days (date TEXT PRIMARY KEY, rev INTEGER NOT NULL, json TEXT NOT NULL);
-- Dates whose derived night/day is out of date. Written in the SAME transaction as
-- the samples that made them stale, so a restart between commit and recompute
-- cannot serve a stale night (materialize.ts).
CREATE TABLE IF NOT EXISTS dirty (kind TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (kind, date)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sleep_ready (date TEXT PRIMARY KEY, status TEXT NOT NULL, at_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

let db: DatabaseType | null = null

export class HealthStoreUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HealthStoreUnavailable'
  }
}

/** The shared handle, opened lazily. Throws on a replica: it keeps nothing. */
export function getHealthDb(): DatabaseType {
  if (CLOUD_MODE) throw new HealthStoreUnavailable('health data lives on the primary box only')
  if (db) return db
  fs.mkdirSync(healthDir(), { recursive: true, mode: 0o700 })
  const handle = new Database(healthDbPath())
  handle.pragma('journal_mode = WAL')
  handle.pragma('busy_timeout = 2000')
  handle.pragma('synchronous = NORMAL')
  // Deleted rows are overwritten, so "delete my health data" removes the bytes too.
  handle.pragma('secure_delete = ON')
  handle.exec(SCHEMA)
  try { fs.chmodSync(healthDbPath(), 0o600) } catch { /* best effort */ }
  db = handle
  if (!getMeta('storeId')) setMeta('storeId', newStoreId())
  return handle
}

export function closeHealthDb(): void {
  if (!db) return
  try { db.close() } catch { /* already closed */ }
  db = null
}

/** Remove the database file and its WAL side files. The next getHealthDb() starts empty. */
export function destroyHealthDbFiles(): void {
  closeHealthDb()
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(healthDbPath() + suffix, { force: true }) } catch { /* gone */ }
  }
}

export function newStoreId(): string {
  return `hs-${crypto.randomUUID()}`
}

export function getMeta(key: string): string | undefined {
  const row = getHealthDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setMeta(key: string, value: string): void {
  getHealthDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function deleteMeta(key: string): void {
  getHealthDb().prepare('DELETE FROM meta WHERE key = ?').run(key)
}

export function getMetaJson<T>(key: string): T | undefined {
  const raw = getMeta(key)
  if (raw === undefined) return undefined
  try { return JSON.parse(raw) as T } catch { return undefined }
}

export function setMetaJson(key: string, value: unknown): void {
  setMeta(key, JSON.stringify(value))
}

/**
 * Materialization revision. Bumped whenever every derived night/day becomes stale at
 * once (a new source order, a category delete), so reads recompute lazily instead of
 * one request rebuilding a year of nights.
 */
export function materializedRev(): number {
  return Number(getMeta('matRev') ?? '1') || 1
}

export function bumpMaterializedRev(): number {
  const next = materializedRev() + 1
  setMeta('matRev', String(next))
  return next
}
