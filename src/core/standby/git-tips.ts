/**
 * The check under change-rules.ts's git answers: every object a ref of the batch names is in the
 * batch, as a loose object or in one of its packs. The rules already keep each object git still
 * holds after the moment (git deletes an object file only once its content is in a pack, or once
 * it is unreachable and older than the prune age); this makes a batch that still missed one fail
 * its round instead of committing a repo whose branch names an object it lacks.
 *
 * A ref's content at the moment is the batch's copy of it: read here from disk while its bytes
 * still hash to the batch's (a ref that moved since is not checked). A pack is looked up in its
 * .idx (version 2: a fanout table, then the sorted object names). An object the home itself does
 * not hold either (a shallow or damaged repo) is the leader's state, not the batch's miss.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './chunks.js'
import { isNotCopiedPath } from './change-rules.js'
import type { BatchFile } from './types.js'

const REF_FILE = /^\.git\/(?:HEAD|packed-refs|refs\/.+)$/
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const IDX_FILE = /^\.git\/objects\/pack\/pack-[0-9a-f]+\.idx$/
const IDX_MAGIC = 0xff744f63
const MAX_REF_FILE = 16 * 1024 * 1024
const packOf = (idx: string): string => `${idx.slice(0, -'.idx'.length)}.pack`

/** The ref file's text when its bytes on disk are still the batch's, else null. */
async function refText(home: string, rel: string, f: BatchFile): Promise<string | null> {
  if (f.size > MAX_REF_FILE) return null
  const buf = await fs.readFile(path.join(home, rel)).catch(() => null)
  return buf && sha256(buf) === f.h ? buf.toString('utf8') : null
}

/** Whether pack index `abs` names object `id`: null when it cannot be read as a version 2 index. */
export async function idxHas(abs: string, id: string): Promise<boolean | null> {
  const fh = await fs.open(abs, 'r').catch(() => null)
  if (!fh) return null
  try {
    const head = Buffer.alloc(8 + 256 * 4)
    if ((await fh.read(head, 0, head.length, 0)).bytesRead !== head.length) return null
    if (head.readUInt32BE(0) !== IDX_MAGIC || head.readUInt32BE(4) !== 2) return null
    const want = Buffer.from(id, 'hex')
    const first = want[0]
    let lo = first === 0 ? 0 : head.readUInt32BE(8 + (first - 1) * 4)
    let hi = head.readUInt32BE(8 + first * 4)
    const name = Buffer.alloc(want.length)
    const base = head.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if ((await fh.read(name, 0, name.length, base + mid * name.length)).bytesRead !== name.length) return null
      const c = name.compare(want)
      if (c === 0) return true
      if (c < 0) lo = mid + 1
      else hi = mid
    }
    return false
  } finally {
    await fh.close()
  }
}

/**
 * Whether `id` is in the given loose names or packs. A pack index that cannot be read (gone
 * since, or not an index git could read either) holds nothing here: the home's own check then
 * decides whether anything is missing.
 */
async function holds(home: string, id: string, loose: (rel: string) => boolean | Promise<boolean>, idx: string[]): Promise<boolean> {
  if (await loose(`.git/objects/${id.slice(0, 2)}/${id.slice(2)}`)) return true
  for (const rel of idx) if (await idxHas(path.join(home, rel), id)) return true
  return false
}

/** Refs of the batch that name an object the batch lacks while the home holds it: `<ref> names <id>`. */
export async function missingRefTips(home: string, files: ReadonlyMap<string, BatchFile>): Promise<string[]> {
  const tips = new Map<string, string>()
  for (const [rel, f] of files) {
    if (!REF_FILE.test(rel) || isNotCopiedPath(rel)) continue
    const text = await refText(home, rel, f)
    if (text === null) continue
    for (const line of text.split('\n')) {
      const word = line.trim().replace(/^\^/, '').split(/\s+/)[0]
      if (OBJECT_ID.test(word)) tips.set(word, rel)
    }
  }
  if (!tips.size) return []
  // A pack holds an object only with its .pack beside its .idx.
  const batchIdx = [...files.keys()].filter((p) => IDX_FILE.test(p) && files.has(packOf(p)))
  let homeIdx: string[] | null = null
  const missing: string[] = []
  for (const [id, ref] of tips) {
    if (await holds(home, id, (rel) => files.has(rel), batchIdx)) continue
    if (!homeIdx) {
      const names = (await fs.readdir(path.join(home, '.git/objects/pack')).catch(() => [] as string[])).map((n) => `.git/objects/pack/${n}`)
      const all = new Set(names)
      homeIdx = names.filter((p) => IDX_FILE.test(p) && all.has(packOf(p)))
    }
    const onDisk = (rel: string) => fs.access(path.join(home, rel)).then(() => true, () => false)
    if (!(await holds(home, id, onDisk, homeIdx))) continue
    missing.push(`${ref} names ${id}`)
  }
  return missing
}

