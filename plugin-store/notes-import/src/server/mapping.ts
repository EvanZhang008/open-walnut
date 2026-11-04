/**
 * What the importer remembers per target folder and source item, in the plugin's own SQLite:
 * the item's `editedAt` when it was last written (equal = nothing to fetch) and the hash of the
 * bytes written (different = the person edited the note since, so it is left alone). Items an
 * organize run merged into another note are remembered too, so a re-import does not bring them
 * back as notes of their own.
 */
import type { PluginDatabase } from '@open-walnut/plugin-api/server'

export interface MappingRow {
  path: string
  edited: string
  hash: string
  /**
   * Sub-pages its last render found (ones the source lists only inside it), so a run that skips
   * it as unchanged still brings in any of them a stopped run never wrote.
   */
  children?: string[]
}

const joinIds = (ids?: string[]) => (ids ?? []).join(',')
const splitIds = (text: string | null | undefined) => (text ? text.split(',').filter(Boolean) : [])

export class Mapping {
  private ready: Promise<void> | null = null

  constructor(private readonly db: PluginDatabase) {}

  private init(): Promise<void> {
    // A failed migration is tried again on the next call, not kept as a failure until a restart.
    this.ready ??= this.db.migrate([
      {
        version: 1,
        sql: `CREATE TABLE IF NOT EXISTS items (
          folder TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL,
          path TEXT NOT NULL, edited TEXT NOT NULL, hash TEXT NOT NULL,
          PRIMARY KEY (folder, source, item_id));
        CREATE TABLE IF NOT EXISTS merged (
          folder TEXT NOT NULL, source TEXT NOT NULL, item_id TEXT NOT NULL, into_path TEXT NOT NULL,
          PRIMARY KEY (folder, source, item_id));`,
      },
      { version: 2, sql: `ALTER TABLE items ADD COLUMN children TEXT NOT NULL DEFAULT ''` },
      {
        version: 3,
        sql: `CREATE TABLE IF NOT EXISTS files (
          folder TEXT NOT NULL, source TEXT NOT NULL, file_key TEXT NOT NULL, path TEXT NOT NULL,
          PRIMARY KEY (folder, source, file_key));`,
      },
    ]).then(() => undefined, (error) => { this.ready = null; throw error })
    return this.ready
  }

  async all(folder: string, source: string): Promise<Map<string, MappingRow>> {
    await this.init()
    const rows = await this.db.all<{ item_id: string; path: string; edited: string; hash: string; children: string }>(
      'SELECT item_id, path, edited, hash, children FROM items WHERE folder = ? AND source = ?', [folder, source])
    return new Map(rows.map((row) => [row.item_id, { path: row.path, edited: row.edited, hash: row.hash, children: splitIds(row.children) }]))
  }

  /** Where each downloaded file went, by its key in the source, so a re-import finds it under its own name. */
  async files(folder: string, source: string): Promise<Map<string, string>> {
    await this.init()
    const rows = await this.db.all<{ file_key: string; path: string }>('SELECT file_key, path FROM files WHERE folder = ? AND source = ?', [folder, source])
    return new Map(rows.map((row) => [row.file_key, row.path]))
  }

  async putFile(folder: string, source: string, key: string, path: string): Promise<void> {
    await this.init()
    await this.db.run(
      'INSERT INTO files (folder, source, file_key, path) VALUES (?, ?, ?, ?) ON CONFLICT (folder, source, file_key) DO UPDATE SET path = excluded.path',
      [folder, source, key, path])
  }

  async put(folder: string, source: string, itemId: string, row: MappingRow): Promise<void> {
    await this.init()
    await this.db.run(
      'INSERT INTO items (folder, source, item_id, path, edited, hash, children) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (folder, source, item_id) DO UPDATE SET path = excluded.path, edited = excluded.edited, hash = excluded.hash, children = excluded.children',
      [folder, source, itemId, row.path, row.edited, row.hash, joinIds(row.children)])
  }

  async movePath(folder: string, from: string, to: string): Promise<void> {
    await this.init()
    await this.db.run('UPDATE items SET path = ? WHERE folder = ? AND path = ?', [to, folder, from])
  }

  /** A note moved: every folder's record of it follows (an organized folder need not be the import's). */
  async movePathAnywhere(from: string, to: string): Promise<void> {
    await this.init()
    await this.db.run('UPDATE items SET path = ? WHERE path = ?', [to, from])
  }

  /** The record of the note at `path`, whichever import folder holds it. */
  async recordAt(source: string, path: string): Promise<{ folder: string; itemId: string; row: MappingRow } | null> {
    await this.init()
    const rows = await this.db.all<{ folder: string; item_id: string; path: string; edited: string; hash: string; children: string }>(
      'SELECT folder, item_id, path, edited, hash, children FROM items WHERE source = ? AND path = ? LIMIT 1', [source, path])
    const row = rows[0]
    return row ? { folder: row.folder, itemId: row.item_id, row: { path: row.path, edited: row.edited, hash: row.hash, children: splitIds(row.children) } } : null
  }

  /** Whether any import folder records this item. */
  async knows(source: string, itemId: string): Promise<boolean> {
    await this.init()
    const rows = await this.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE source = ? AND item_id = ?', [source, itemId])
    return (rows[0]?.n ?? 0) > 0
  }

  async updateHash(folder: string, path: string, hash: string): Promise<void> {
    await this.init()
    await this.db.run('UPDATE items SET hash = ? WHERE folder = ? AND path = ?', [hash, folder, path])
  }

  async merged(folder: string, source: string): Promise<Set<string>> {
    await this.init()
    const rows = await this.db.all<{ item_id: string }>('SELECT item_id FROM merged WHERE folder = ? AND source = ?', [folder, source])
    return new Set(rows.map((row) => row.item_id))
  }

  /** Each merged item and the note it went into. */
  async mergedInto(folder: string, source: string): Promise<Map<string, string>> {
    await this.init()
    const rows = await this.db.all<{ item_id: string; into_path: string }>('SELECT item_id, into_path FROM merged WHERE folder = ? AND source = ?', [folder, source])
    return new Map(rows.map((row) => [row.item_id, row.into_path]))
  }

  async markMerged(folder: string, source: string, itemId: string, into: string): Promise<void> {
    await this.init()
    await this.db.run(
      'INSERT INTO merged (folder, source, item_id, into_path) VALUES (?, ?, ?, ?) ON CONFLICT (folder, source, item_id) DO UPDATE SET into_path = excluded.into_path',
      [folder, source, itemId, into])
  }

  async unmarkMerged(folder: string, source: string, itemId: string): Promise<void> {
    await this.init()
    await this.db.run('DELETE FROM merged WHERE folder = ? AND source = ? AND item_id = ?', [folder, source, itemId])
  }

  /** A fresh start in an emptied folder brings merged items in again too. */
  async clearMerged(folder: string, source: string): Promise<void> {
    await this.init()
    await this.db.run('DELETE FROM merged WHERE folder = ? AND source = ?', [folder, source])
  }

  /** Paths another import folder records for this source: notes that are that folder's, not this one's. */
  async pathsOfOtherFolders(folder: string, source: string): Promise<Set<string>> {
    await this.init()
    const rows = await this.db.all<{ path: string }>('SELECT path FROM items WHERE folder <> ? AND source = ?', [folder, source])
    return new Set(rows.map((row) => row.path))
  }
}
