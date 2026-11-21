/**
 * Synthetic homes and standby targets for the standby copy's tests. Everything lives in a
 * fresh temp dir per test; no real home is ever read.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Database from '../../../src/lib/sqlite.js'
import { homePathClass } from '../../../src/core/home-manifest/index.js'
import { removeTree } from '../../../src/core/standby/target-files.js'

export interface Sandbox {
  root: string
  home: string
  target: string
  cleanup(): Promise<void>
}

export async function sandbox(name: string): Promise<Sandbox> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `standby-${name}-`))
  const home = path.join(root, 'home')
  const target = path.join(root, 'target')
  await fsp.mkdir(home, { recursive: true })
  return { root, home, target, cleanup: () => removeTree(root) }
}

export function write(home: string, rel: string, content: string | Buffer): void {
  const abs = path.join(home, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

/** A WAL database at `rel` with a table `t(id, body)` holding `rows` rows. */
export function makeDb(home: string, rel: string, rows: number): Database {
  const abs = path.join(home, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const db = new Database(abs)
  db.pragma('journal_mode = WAL')
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, body TEXT)')
  const ins = db.prepare('INSERT INTO t (body) VALUES (?)')
  for (let i = 0; i < rows; i++) ins.run(`row ${i} ${'x'.repeat(50)}`)
  return db
}

/** A home with one place of each class, a few databases and some Unicode names. */
export function seedHome(home: string): { dbs: Database[] } {
  write(home, 'config.yaml', 'theme: dark\n')
  write(home, 'memory/MEMORY.md', '# Memory\n')
  write(home, 'artifacts/notes/café 笔记.md', '# Unicode note ✓\n')
  write(home, 'artifacts/notes/deep/a/b/c.md', 'deep\n')
  write(home, 'conversations/main/history.jsonl', '{"a":1}\n')
  write(home, 'triggers/check.sh', '#!/bin/sh\necho ok\n')
  fs.chmodSync(path.join(home, 'triggers/check.sh'), 0o755)
  write(home, 'cache/applied-ops.json.unused', 'rebuildable fallback\n')
  write(home, 'cache/status-riding.json', '{"leader":"data"}\n')
  write(home, 'server.lock.json', '{"pid":1}\n')
  write(home, 'tmp/streams/s1.jsonl', 'machine\n')
  write(home, 'search.sqlite', 'not copied\n')
  write(home, 'tasks/tasks.json.lock/owner/x', '')
  write(home, 'user-own-folder/plan.md', 'unknown names are leader-data\n')
  write(home, 'big/blob.bin', crypto.randomBytes(3 * 1024 * 1024))
  return { dbs: [makeDb(home, 'tasks/tasks.sqlite', 200), makeDb(home, 'sessions.sqlite', 50), makeDb(home, 'cache/applied-ops.sqlite', 5)] }
}

export const sha = (p: string): string => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

/** Every file under `root`, relative. */
export function walk(root: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walk(root, child))
    else out.push(child)
  }
  return out.sort()
}

/** The leader-data plain files of a home (databases and their side files apart). */
export function leaderPlainFiles(home: string): string[] {
  return walk(home).filter((p) => homePathClass(p) === 'leader-data' && !/\.sqlite(-wal|-shm|-journal)?$/.test(p))
}

/** Open a database of the copy through a writable temp copy (the copy itself is read-only). */
export function openCopiedDb(file: string): { db: Database; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standby-db-'))
  const tmp = path.join(dir, 'db.sqlite')
  fs.copyFileSync(file, tmp)
  fs.chmodSync(tmp, 0o600)
  const db = new Database(tmp)
  return { db, done: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

export function chunkCount(target: string): number {
  const dir = path.join(target, 'chunks')
  if (!fs.existsSync(dir)) return 0
  return walk(dir).length
}
