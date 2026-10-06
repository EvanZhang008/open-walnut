/**
 * The places store: ~/.open-walnut/places/places.sqlite (Mac only).
 *
 * The iPhone records the places the user visits (iOS visit monitoring) only after
 * the user turns Places on, and keeps this Mac current with them. The primary is
 * the ONLY writer: a cloud replica relays every call and must never open this
 * file, which getPlacesDb() enforces rather than trusting each caller to check.
 *
 * The directory is kept out of git-sync (CRITICAL_IGNORE_DIRS) and out of the S3
 * backup (EXCLUDED_DIRS): the visits never leave this machine.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'

export function placesDir(): string {
  return path.join(WALNUT_HOME, 'places')
}

export function placesDbPath(): string {
  return path.join(placesDir(), 'places.sqlite')
}

// A visit arrives twice from iOS (on arrival, then on departure) under one id the
// phone keeps, so the row is upserted. arrival_ms is NULL when iOS did not see the
// arrival; departure_ms is NULL while the user is still there.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  arrival_ms INTEGER,
  departure_ms INTEGER,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  accuracy_m REAL,
  name TEXT,
  address TEXT,
  tz TEXT NOT NULL,
  received_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_arrival ON visits(arrival_ms);
CREATE INDEX IF NOT EXISTS visits_departure ON visits(departure_ms);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

let db: DatabaseType | null = null

export class PlacesStoreUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlacesStoreUnavailable'
  }
}

export function placesStoreExists(): boolean {
  return !CLOUD_MODE && fs.existsSync(placesDbPath())
}

/** The shared handle, opened lazily. Throws on a replica: it keeps nothing. */
export function getPlacesDb(): DatabaseType {
  if (CLOUD_MODE) throw new PlacesStoreUnavailable('places live on the primary box only')
  if (db) return db
  fs.mkdirSync(placesDir(), { recursive: true, mode: 0o700 })
  const handle = new Database(placesDbPath())
  handle.pragma('journal_mode = WAL')
  handle.pragma('busy_timeout = 2000')
  handle.pragma('synchronous = NORMAL')
  // Deleted rows are overwritten, so "delete places" removes the bytes too.
  handle.pragma('secure_delete = ON')
  handle.exec(SCHEMA)
  try { fs.chmodSync(placesDbPath(), 0o600) } catch { /* best effort */ }
  db = handle
  return handle
}

export function closePlacesDb(): void {
  if (!db) return
  try { db.close() } catch { /* already closed */ }
  db = null
}

/** Remove the database file and its WAL side files. The next getPlacesDb() starts empty. */
export function destroyPlacesDbFiles(): void {
  closePlacesDb()
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(placesDbPath() + suffix, { force: true }) } catch { /* gone */ }
  }
}

export function getMeta(key: string): string | undefined {
  const row = getPlacesDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setMeta(key: string, value: string): void {
  getPlacesDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
