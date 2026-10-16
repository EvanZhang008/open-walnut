/**
 * The inbox copy kinds (docs/plan/walnut-replica-servers-impl.md, section 4 and
 * WP4): the Mac's Human Inbox on each host replica, in the same layout
 * (`human-inbox/index.json` plus `human-inbox/bodies/<file>`).
 *
 *   inbox         the index, one row per letter, in the index's order (ordered,
 *                 digest). A letter is never removed by a manifest that removes
 *                 most of them (the half rule from 50 letters).
 *   inbox-bodies  the body files, keyed by file name and sent by `{k, h}`: a
 *                 body whose hash the replica holds is never sent again. Only
 *                 for a host whose Settings row turned "letter bodies" on
 *                 (`hosts.<key>.server.copies.inbox_bodies`, default off: the
 *                 replica fetches a body from the Mac while it answers, and
 *                 answers `needs_leader {why:'kind_not_copied'}` while away).
 *                 A body over INBOX_BODY_COPY_MAX_BYTES is never copied.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { log } from '../../../logging/index.js'
// The store's own shapes: a letter id or body name the Mac's store accepts is one this copy accepts.
import { BODY_FILE_RE, LETTER_ID_RE } from '../../human-inbox/normalize.js'
import type { LetterRecord } from '../../human-inbox/types.js'
import { sha12 } from '../kind.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower, type RowSetState } from '../kind-follower.js'
import type { CopyKind } from './copy-kind.js'
import { copyRefusal, markCopyOff } from './gate.js'

export const INBOX_SCHEMA_VERSION = 1
export const INBOX_REMOVAL_FLOOR = 50
export const INBOX_BODY_COPY_MAX_BYTES = 4 * 1024 * 1024

const inboxDir = (): string => path.join(WALNUT_HOME, 'human-inbox')
const indexFile = (): string => path.join(inboxDir(), 'index.json')
const bodiesDir = (): string => path.join(inboxDir(), 'bodies')

/** A body file as a row: its name and its text. */
export interface LetterBodyRow { name: string; body: string }

const letterHashes = new WeakMap<object, string>()

export const INBOX_KIND: CopyKind<LetterRecord> = {
  kind: 'inbox',
  schemaVersion: INBOX_SCHEMA_VERSION,
  key: (l) => l.id,
  hash: (l) => {
    let h = letterHashes.get(l)
    if (h === undefined) { h = sha12(JSON.stringify(l)); letterHashes.set(l, h) }
    return h
  },
  ordered: true,
  digest: true,
  choice: 'inbox',
  rows: async () => (await import('../../human-inbox/store.js')).readLetterIndexForReplica(),
  watch: (soon) => watchLetters(soon),
}

function watchLetters(soon: () => void): () => void {
  let stop: (() => void) | null = null
  let stopped = false
  void import('../../human-inbox/store.js').then(({ onLetterStoreWritten }) => {
    if (!stopped) stop = onLetterStoreWritten(soon)
  })
  return () => { stopped = true; stop?.() }
}

/** What the Mac keeps per body between rounds: enough to know it did not change, never its text. */
interface CachedBody { size: number; mtimeMs: number; hash: string }
const bodyCache = new Map<string, CachedBody>()
const bodyHashes = new WeakMap<object, string>()
/** A manifest row's file: the row holds no text, a put reads it (INBOX_BODIES_KIND.loadRow). */
const bodyFiles = new WeakMap<object, string>()

/**
 * Every body file the Mac has, as manifest rows: the name and (in bodyHashes)
 * the hash, no text. A file is read only to hash it when its size or mtime
 * changed, and again when a put sends it. A row without text is never a valid
 * put (the follower answers 400 bad_rows), so a path that forgot loadRow
 * cannot write an empty body.
 */
export async function leaderBodies(dir = bodiesDir()): Promise<LetterBodyRow[]> {
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => BODY_FILE_RE.test(n)).sort()
  const out: LetterBodyRow[] = []
  const seen = new Set(names)
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const st = await fsp.stat(file)
      if (!st.isFile() || st.size > INBOX_BODY_COPY_MAX_BYTES) continue
      let c = bodyCache.get(name)
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        c = { size: st.size, mtimeMs: st.mtimeMs, hash: sha12(await fsp.readFile(file, 'utf8')) }
        bodyCache.set(name, c)
      }
      const row = { name } as LetterBodyRow
      bodyHashes.set(row, c.hash)
      bodyFiles.set(row, file)
      out.push(row)
    } catch { /* went away: the next round */ }
  }
  for (const k of [...bodyCache.keys()]) if (!seen.has(k)) bodyCache.delete(k)
  return out
}

/** The body a put sends: read now. Gone or over the cap since the manifest: skipped (the next round asks again). */
async function loadBody(b: LetterBodyRow): Promise<LetterBodyRow | undefined> {
  const file = bodyFiles.get(b)
  if (!file) return typeof b.body === 'string' ? b : undefined
  try {
    const body = await fsp.readFile(file, 'utf8')
    return Buffer.byteLength(body) > INBOX_BODY_COPY_MAX_BYTES ? undefined : { name: b.name, body }
  } catch { return undefined }
}

export const INBOX_BODIES_KIND: CopyKind<LetterBodyRow> = {
  kind: 'inbox-bodies',
  schemaVersion: INBOX_SCHEMA_VERSION,
  key: (b) => b.name,
  // By the body's own hash: {k: file name, h: hash of its text}.
  hash: (b) => bodyHashes.get(b) ?? sha12(b.body),
  loadRow: loadBody,
  ordered: false,
  digest: false,
  choice: 'inbox_bodies',
  rows: () => leaderBodies(),
  watch: (soon) => watchLetters(soon),
}

// --- Followers ---

function stateIo(name: string): { load(): Promise<RowSetState>; save(): Promise<void>; reset(): void } {
  const file = (): string => path.join(WALNUT_HOME, 'cache', 'replica', `${name}.json`)
  let state: RowSetState | null = null
  return {
    load: async () => {
      if (state) return state
      let s: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
      try {
        const raw = JSON.parse(await fsp.readFile(file(), 'utf8')) as Partial<RowSetState> & { v?: number }
        if (raw?.v === 1 && raw.hashes && typeof raw.hashes === 'object') {
          s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: Array.isArray(raw.order) ? raw.order.map(String) : [], hashes: raw.hashes }
        }
      } catch { /* none yet */ }
      state = s
      return s
    },
    save: async () => { if (state) await writeCopyFile(file(), { v: 1, ...state }) },
    reset: () => { state = null },
  }
}

async function readIndex(): Promise<LetterRecord[]> {
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile(), 'utf8')) as { letters?: unknown }
    return Array.isArray(raw?.letters) ? raw.letters.filter(isLetter) : []
  } catch { return [] }
}

function isLetter(v: unknown): v is LetterRecord {
  const l = v as Partial<LetterRecord> | null
  return !!l && typeof l === 'object' && typeof l.id === 'string' && LETTER_ID_RE.test(l.id)
}

function isBody(v: unknown): v is LetterBodyRow {
  const b = v as Partial<LetterBodyRow> | null
  return !!b && typeof b === 'object' && typeof b.name === 'string' && BODY_FILE_RE.test(b.name) && typeof b.body === 'string'
}

const refuse = copyRefusal

let indexIo = stateIo('inbox')
let bodiesIo = stateIo('inbox-bodies')
let serial = serialChain()
let inboxF: RowSetFollower | null = null
let bodiesF: RowSetFollower | null = null

export function inboxFollower(): RowSetFollower {
  inboxF ??= createRowSetFollower<LetterRecord>({
    kind: 'inbox', schemaVersion: INBOX_SCHEMA_VERSION, label: 'inbox copy', log: log.notif,
    removalFloor: INBOX_REMOVAL_FLOOR, ordered: true, digest: true,
    serial: (fn) => serial(fn), refuse, load: () => indexIo.load(), save: () => indexIo.save(), isRow: isLetter, key: (l) => l.id,
    localKeys: async () => (await readIndex()).map((l) => l.id),
    apply: async ({ rows, removeIds, order }) => {
      const byId = new Map((await readIndex()).map((l) => [l.id, l]))
      const ids = [...byId.keys()]
      for (const id of removeIds ?? []) byId.delete(id)
      for (const l of rows ?? []) {
        if (!byId.has(l.id)) ids.push(l.id)
        byId.set(l.id, l)
      }
      const listed: string[] = []
      const placed = new Set<string>()
      for (const id of [...(order ?? ids), ...byId.keys()]) {
        if (!byId.has(id) || placed.has(id)) continue
        placed.add(id)
        listed.push(id)
      }
      // No `lastUpdated`: that is the Mac's own clock (human-inbox/replica-state.ts drops an
      // overlay once the index's lastUpdated passes its ack), and this side never read it.
      // The copy's write time goes by its own name.
      await writeCopyFile(indexFile(), { version: 1, copiedAt: new Date().toISOString(), letters: listed.map((id) => byId.get(id)!) })
      return { skipped: [] }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('inbox'),
    changed: () => {},
    purge: async () => {
      const removed = (await readIndex()).length
      await fsp.rm(indexFile(), { force: true })
      await markCopyOff('inbox')
      indexIo.reset()
      return { removed }
    },
  })
  return inboxF
}

export function inboxBodiesFollower(): RowSetFollower {
  bodiesF ??= createRowSetFollower<LetterBodyRow>({
    kind: 'inbox-bodies', schemaVersion: INBOX_SCHEMA_VERSION, label: 'inbox bodies copy', log: log.notif,
    removalFloor: INBOX_REMOVAL_FLOOR, ordered: false,
    serial: (fn) => serial(fn), refuse, load: () => bodiesIo.load(), save: () => bodiesIo.save(), isRow: isBody, key: (b) => b.name,
    hash: (b) => sha12(b.body),
    localKeys: async () => (await fsp.readdir(bodiesDir()).catch(() => [] as string[])).filter((n) => BODY_FILE_RE.test(n)),
    apply: async ({ rows, removeIds }) => {
      for (const name of removeIds ?? []) if (BODY_FILE_RE.test(name)) await fsp.rm(path.join(bodiesDir(), name), { force: true })
      const skipped: string[] = []
      for (const b of rows ?? []) {
        if (Buffer.byteLength(b.body) > INBOX_BODY_COPY_MAX_BYTES) { skipped.push(b.name); continue }
        await fsp.mkdir(bodiesDir(), { recursive: true, mode: 0o700 })
        await fsp.writeFile(path.join(bodiesDir(), b.name), b.body, { mode: 0o600 })
      }
      return { skipped }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('inbox-bodies'),
    changed: () => {},
    purge: async () => {
      const names = (await fsp.readdir(bodiesDir()).catch(() => [] as string[])).filter((n) => BODY_FILE_RE.test(n))
      for (const name of names) await fsp.rm(path.join(bodiesDir(), name), { force: true })
      await markCopyOff('inbox-bodies')
      bodiesIo.reset()
      return { removed: names.length }
    },
  })
  return bodiesF
}

/** Tests only. */
export function _resetInboxCopyForTesting(): void {
  indexIo = stateIo('inbox')
  bodiesIo = stateIo('inbox-bodies')
  serial = serialChain()
  inboxF = null
  bodiesF = null
  bodyCache.clear()
}
