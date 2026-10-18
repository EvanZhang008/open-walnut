/**
 * Property runs of the Mac's notes drain (src/core/offline-merge/notes.ts): two hosts
 * and the companion each save one note while the Mac is away (one or two saves, the
 * second on top of the first, sometimes ending in a delete; or each creating the note
 * at a path the Mac does not have), the Mac maybe editing it too, and the records
 * drained in random interleavings (each source in its own order) with random redrains
 * of a source's last records (an ack lost in a crash).
 *
 *   - no line is lost: every line a source's last save added, and every line the Mac
 *     added, is in the note or in a conflict copy
 *   - the order does not matter: the note (its id line aside), or its absence, is the
 *     same in every interleaving
 *   - no two notes share an id
 *   - one side alone (one source, the Mac untouched) makes no copy and no letter
 *
 * Runs: WALNUT_SIM_RUNS (default 1,000; the large run is 20,000), seed WALNUT_SIM_SEED.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyNoteRecord, sha256, withoutIdLine, type NoteDrainDeps, type NoteRecordLike } from '../../../src/core/offline-merge/notes'
import { mergeVersions } from '../../../src/lib/three-way-merge'
import { withNoteId } from '../../../src/core/parse-frontmatter'
import type { ConflictEntry } from '../../../src/core/offline-merge/conflict-log'

const RUNS = Number(process.env.WALNUT_SIM_RUNS) || 1_000
const SEED = Number(process.env.WALNUT_SIM_SEED) || 0x0de11
const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const SOURCES = ['ha', 'hb', 'cc'] as const
const ORDERS = 3

/** The bodies the records name, by sha256 (the hosts' blob stores). */
const blobs = new Map<string, string>()

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HEAD = ['---', 'id: n-p', '---']
const join = (lines: string[]): string => lines.join('\n') + '\n'
const bodyOf = (text: string): string[] => text.split('\n').slice(HEAD.length, -1)

/** Random whole-line edits of `text`'s body by `tag` (replace, delete, insert), every new line unique. */
function edit(rnd: () => number, text: string, tag: string): string {
  const body = bodyOf(text)
  const n = 1 + Math.floor(rnd() * 3)
  for (let k = 0; k < n; k++) {
    const at = Math.floor(rnd() * (body.length + 1))
    const r = rnd()
    if (r < 0.45 && at < body.length) body[at] = `${tag}r${k} ${tag}z${k}`
    else if (r < 0.65 && at < body.length && body.length > 1) body.splice(at, 1)
    else body.splice(at, 0, `${tag}i${k}`)
  }
  return join([...HEAD, ...body])
}

interface Rec { src: string; rec: NoteRecordLike; at: number }
interface Scenario { macText: string | null; macAt: number; sources: Rec[][]; mustKeep: string[]; parties: number; deletes: number }

function scenario(rnd: () => number, run: number): Scenario {
  const base = join([...HEAD, ...Array.from({ length: 4 + Math.floor(rnd() * 8) }, (_, i) => `b${i} w${run % 7}`)])
  const times = new Set<number>()
  const time = (): number => {
    let t = 0
    do t = T0 + 1 + Math.floor(rnd() * 3_600_000); while (times.has(t))
    times.add(t)
    return t
  }
  const mustKeep: string[] = []
  const added = (from: string, to: string): string[] => { const had = new Set(from.split('\n')); return to.split('\n').filter((l) => l && !had.has(l)) }
  let seq = 0
  const mk = (src: string, mode: NoteRecordLike['mode'], b: string | null, ours: string | null, at: number): Rec => {
    seq++
    for (const t of [b, ours]) if (t !== null) blobs.set(sha256(t), t)
    return { src, at, rec: { seq, at, opId: `${src}-op${seq}`, path: 'p.md', noteId: mode === 'create' ? undefined : 'n-p', mode, baseHash: b === null ? null : sha256(b).slice(0, 12), baseBlob: b === null ? null : sha256(b), oursBlob: ours === null ? null : sha256(ours) } }
  }
  if (rnd() < 0.08) {
    // Every source creates the note at a path the Mac does not have.
    const sources = SOURCES.filter(() => rnd() < 0.7).map((src) => {
      const text = `${src} made line one\n${src} made line two\n`
      mustKeep.push(...text.split('\n').filter(Boolean))
      return [mk(src, 'create', null, text, time())]
    })
    return { macText: null, macAt: 0, sources, mustKeep, parties: sources.length, deletes: 0 }
  }
  const macEdits = rnd() < 0.6
  const macText = macEdits ? edit(rnd, base, 'm') : base
  if (macEdits) mustKeep.push(...added(base, macText))
  let parties = macEdits ? 1 : 0
  let deletes = 0
  const sources = SOURCES.map((src) => {
    const r = rnd()
    if (r < 0.1) return []
    if (r < 0.2) { deletes++; return [mk(src, 'delete', base, null, time())] }
    parties++
    const saves = 1 + Math.floor(rnd() * 2)
    const ts = Array.from({ length: saves }, time).sort((a, b) => a - b)
    const out: Rec[] = []
    let prev = base
    for (let k = 0; k < saves; k++) {
      const next = edit(rnd, prev, `${src}${k}`)
      out.push(mk(src, 'put', prev, next, ts[k]))
      prev = next
    }
    if (rnd() < 0.1) { deletes++; out.push(mk(src, 'delete', prev, null, time())) } else mustKeep.push(...added(base, prev))
    return out
  })
  return { macText, macAt: T0 + Math.floor(rnd() * 3_600_000), sources, mustKeep, parties, deletes }
}

interface Drained { note: string | null; files: Map<string, string>; letters: ConflictEntry[]; copies: number; trace: string[] }

/** Drain the sources in one random interleaving into a fresh vault. */
async function drain(rnd: () => number, sc: Scenario): Promise<Drained> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp11-notes-prop-'))
  try {
    const root = path.join(tmp, 'notes')
    fs.mkdirSync(root, { recursive: true })
    if (sc.macText !== null) {
      fs.writeFileSync(path.join(root, 'p.md'), sc.macText)
      fs.utimesSync(path.join(root, 'p.md'), sc.macAt / 1000, sc.macAt / 1000)
    }
    const letters: ConflictEntry[] = []
    const hooks = { conflicts: (e: ConflictEntry[]) => { letters.push(...e) } }
    const depsOf = (src: string): NoteDrainDeps => ({
      root, cacheDir: path.join(tmp, 'cache'), hostLabel: src, hostKey: src,
      fetchBlob: async (sha) => Buffer.from(blobs.get(sha)!, 'utf8'),
      merge: async (b, v, o) => mergeVersions(b, v, o),
      pathOfId: () => undefined,
      lock: (_abs, fn) => fn(),
      written: () => undefined,
      remove: async (rel) => { fs.rmSync(path.join(root, rel)) },
      ensureId: (c, cur) => withNoteId(c, cur).content,
      stamp: (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ').replace(':', ''),
    })
    const next = sc.sources.map(() => 0)
    let copies = 0
    const trace: string[] = []
    const apply = async (r: Rec, tag = ''): Promise<void> => {
      const out = await applyNoteRecord(depsOf(r.src), hooks, r.rec, r.at)
      copies += out.copies.length
      trace.push(`${tag}${r.rec.opId}(${r.rec.mode}@${r.at - T0})=${out.action}${out.copies.length ? `+${out.copies.length}` : ''}`)
    }
    for (;;) {
      const live = sc.sources.map((_, i) => i).filter((i) => next[i] < sc.sources[i].length)
      if (live.length === 0) break
      const i = live[Math.floor(rnd() * live.length)]
      await apply(sc.sources[i][next[i]++])
      if (rnd() < 0.15) {
        // An ack lost in a crash: the source hands its unacked tail over again, in order.
        for (let j = Math.floor(rnd() * next[i]); j < next[i]; j++) await apply(sc.sources[i][j], 'again ')
      }
    }
    const files = new Map<string, string>()
    for (const name of fs.readdirSync(root)) if (name.endsWith('.md')) files.set(name, fs.readFileSync(path.join(root, name), 'utf8'))
    return { note: files.get('p.md') ?? null, files, letters, copies, trace }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

const idLine = (text: string): string | undefined => /\nid: *([^\n]+)/.exec(text)?.[1]?.trim()

/** `runs` seeded runs from `seed`, each drained in ORDERS interleavings; the tally of what they did. */
async function holds(seed: number, runs: number): Promise<Record<string, number>> {
    const tally = { runs: 0, merged: 0, conflicted: 0, deleted: 0, created: 0, redrains: 0, copies: 0, letters: 0 }
    for (let run = 0; run < runs; run++) {
      const rnd = mulberry32(seed + run)
      const where = `run ${run} seed ${seed} (replay: WALNUT_SIM_SEED=${seed + run} WALNUT_SIM_RUNS=1)`
      blobs.clear()
      const sc = scenario(rnd, run)
      const results: Drained[] = []
      for (let o = 0; o < ORDERS; o++) results.push(await drain(rnd, sc))
      for (const r of results) {
        const lines = new Set([...r.files.values()].flatMap((t) => t.split('\n')))
        for (const l of sc.mustKeep) expect(lines.has(l), `${where}: lost "${l}"`).toBe(true)
        const ids = [...r.files.values()].map(idLine)
        expect(ids.every(Boolean), `${where}: a note without an id`).toBe(true)
        expect(new Set(ids).size, `${where}: two notes share an id`).toBe(ids.length)
        if (sc.parties <= 1 && sc.deletes === 0) {
          expect(r.files.size, `${where}: a copy with one side alone`).toBe(r.note === null ? 0 : 1)
          expect(r.letters, where).toEqual([])
        }
      }
      const norm = (r: Drained): string | null => (r.note === null ? null : withoutIdLine(r.note))
      const traces = (): string => results.map((r, o) => `\n  order ${o}: ${r.trace.join(', ')}`).join('') + `\n  mac ${sc.macText === null ? 'none' : `@${sc.macAt - T0}`}`
      for (const r of results.slice(1)) expect(norm(r), `${where}: the note depends on the drain order${traces()}`).toBe(norm(results[0]))
      tally.runs++
      if (results[0].note === null) tally.deleted++
      else if (sc.macText === null) tally.created++
      else if (results.some((r) => r.copies > 0)) tally.conflicted++
      else tally.merged++
      tally.redrains += results.reduce((n, r) => n + r.trace.filter((t) => t.startsWith('again ')).length, 0)
      tally.copies += results.reduce((n, r) => n + r.copies, 0)
      tally.letters += results.reduce((n, r) => n + r.letters.length, 0)
    }
    return tally
}

describe('notes drain properties', () => {
  it(`holds over ${RUNS} seeded runs (seed ${SEED})`, async () => {
    const tally = await holds(SEED, RUNS)
    console.log(`[notes-property] ${RUNS} runs x ${ORDERS} orders, seed ${SEED}: ${JSON.stringify(tally)}`)
    expect(tally.runs).toBe(RUNS)
    // About 150 ms a run (3 drains into fresh vaults): the large run's 20,000 need about 50 min.
  }, Math.max(1_800_000, RUNS * 400))

  it('regression: another host\'s save with the same text as this host\'s earlier save is not its base (seed 1138913017)', async () => {
    // ha deletes a line, then edits on top of that; cc deletes the same line. Draining ha's
    // second save again (a lost ack) once took cc's version for ha's first save and dropped it.
    expect((await holds(1138913017, 1)).runs).toBe(1)
  }, 60_000)

  it('regression: a save that changed nothing does not bring back a note another side deleted (seed 787056)', async () => {
    expect((await holds(787056, 1)).runs).toBe(1)
  }, 60_000)

  it('regression: a save that changed nothing does not keep a note its last editor deleted (seed 1138917540)', async () => {
    expect((await holds(1138917540, 1)).runs).toBe(1)
  }, 60_000)
})
