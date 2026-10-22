/**
 * What a replica's copy of the memory and skills holds beyond the two docs and each
 * skill's own document (stage 4d of docs/plan/walnut-companion-unified-replica.md). Every
 * target gets it, a host's daemon as much as the cloud companion: the console's and the
 * phone's memory and skill pages read it there while the Mac is away.
 *
 *   memory  every `.md` under memory/ but the two docs (daily logs, projects, sessions,
 *           knowledge, topics, compaction snapshots, agents, working memory), as
 *           `f/<path under memory/>`, with each file's times; the repo memories
 *           (skills/repos/<name>/SKILL.md) as `r/<name>`; and `files.v1`, which tells the
 *           replica its copy carries these (an older Mac sends the two docs only)
 *   skills  each skill's reference files (`<dirName>/references/<file>`, text only)
 *
 * A reader of the copy tells these from the docs by key: a memory doc is `global` or
 * `user`, a skill is a key without a slash (host-replica-core.ts reads only those).
 * All of it is text, about 2.4 MB of memory for the measured data dir. A file over 1 MB
 * stays on the Mac (the replica answers needs-the-Mac for it). Bodies are read only for
 * the keys the replica asks for; a stat cache keeps an unchanged file from being read again.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { MEMORY_DIR, REPOS_MEMORY_DIR } from '../constants.js'

export const MEMORY_FILES_MARKER = 'files.v1'
const MAX_FILE_BYTES = 1024 * 1024
const MAX_REFERENCES = 200

export interface ExtraEntry { k: string; h: string; n: number; m?: Record<string, unknown> }
export interface Extras { entries: ExtraEntry[]; body: (k: string) => Promise<string | null> }

const sha12 = (body: string): string => crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
const statCache = new Map<string, { mtimeMs: number; size: number; h: string }>()

/** The entry of one text file, its hash from the stat cache when the file did not change. */
async function fileEntry(k: string, abs: string, st: fs.Stats, m?: Record<string, unknown>): Promise<ExtraEntry | null> {
  if (st.size > MAX_FILE_BYTES) return null
  let row = statCache.get(abs)
  if (!row || row.mtimeMs !== st.mtimeMs || row.size !== st.size) {
    let body: string
    try { body = await fsp.readFile(abs, 'utf8') } catch { return null }
    row = { mtimeMs: st.mtimeMs, size: st.size, h: sha12(body) }
    statCache.set(abs, row)
  }
  return { k, h: row.h, n: row.size, ...(m ? { m } : {}) }
}

async function memoryExtras(): Promise<Extras> {
  const files = new Map<string, string>()
  const entries: ExtraEntry[] = [{ k: MEMORY_FILES_MARKER, h: sha12('{"v":1}'), n: 7 }]
  const walk = async (dir: string, relDir: string): Promise<void> => {
    let names: fs.Dirent[]
    try { names = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (d.name.startsWith('.')) continue
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      const abs = path.join(dir, d.name)
      if (d.isDirectory()) { await walk(abs, rel); continue }
      // The two docs are the copy's own `global` and `user` entries.
      if (!d.isFile() || !d.name.endsWith('.md') || rel === 'MEMORY.md' || rel === 'USER.md') continue
      let st: fs.Stats
      try { st = await fsp.stat(abs) } catch { continue }
      const e = await fileEntry(`f/${rel}`, abs, st, { updatedAt: st.mtime.toISOString(), createdAt: st.birthtime.toISOString() })
      if (e) { entries.push(e); files.set(e.k, abs) }
    }
  }
  await walk(MEMORY_DIR, '')
  let repos: fs.Dirent[] = []
  try { repos = await fsp.readdir(REPOS_MEMORY_DIR, { withFileTypes: true }) } catch { /* none yet */ }
  for (const d of repos) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const abs = path.join(REPOS_MEMORY_DIR, d.name, 'SKILL.md')
    let st: fs.Stats
    try { st = await fsp.stat(abs) } catch { continue }
    const e = await fileEntry(`r/${d.name}`, abs, st, { updatedAt: st.mtime.toISOString() })
    if (e) { entries.push(e); files.set(e.k, abs) }
  }
  return {
    entries,
    body: async (k) => {
      if (k === MEMORY_FILES_MARKER) return '{"v":1}'
      const abs = files.get(k)
      if (!abs) return null
      try { return await fsp.readFile(abs, 'utf8') } catch { return null }
    },
  }
}

async function skillExtras(skills: Array<{ dirName: string; location?: string }>): Promise<Extras> {
  const files = new Map<string, string>()
  const entries: ExtraEntry[] = []
  for (const s of skills) {
    if (!s.location || !/^[A-Za-z0-9._-]+$/.test(s.dirName)) continue
    const refs = path.join(path.dirname(s.location), 'references')
    let names: fs.Dirent[]
    try { names = await fsp.readdir(refs, { withFileTypes: true }) } catch { continue }
    let n = 0
    for (const d of names) {
      if (!d.isFile() || d.name.startsWith('.') || n >= MAX_REFERENCES) continue
      const abs = path.join(refs, d.name)
      let st: fs.Stats
      try { st = await fsp.stat(abs) } catch { continue }
      const e = await fileEntry(`${s.dirName}/references/${d.name}`, abs, st, { size: st.size })
      if (e) { entries.push(e); files.set(e.k, abs); n++ }
    }
  }
  return {
    entries,
    body: async (k) => {
      const abs = files.get(k)
      if (!abs) return null
      try { return await fsp.readFile(abs, 'utf8') } catch { return null }
    },
  }
}

/** The extra entries of `kind`. `skills` is the list the round already read (with each skill's location). */
export async function replicaExtras(kind: 'memory' | 'skills', skills: Array<{ dirName: string; location?: string }> = []): Promise<Extras> {
  return kind === 'memory' ? memoryExtras() : skillExtras(skills)
}

/** Tests only. */
export function _resetHostReplicaExtrasForTesting(): void {
  statCache.clear()
}
