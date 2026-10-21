/**
 * The `boards` copy kind (docs/plan/walnut-replica-servers-impl.md, section 4
 * and WP4): every task Board (`boards/<taskId>.json`: the html and its side
 * state) on each host replica, in the same layout there. One row per board,
 * the whole document; a board larger than BOARD_COPY_MAX_BYTES is not copied
 * (the store caps its html at 1 MB, board-store.ts; the cap leaves room for the
 * threads and marks beside it) and is read from the Mac while it answers.
 *
 * The leader reads a board file again only when its size or mtime moved, so a
 * round over unchanged boards hashes nothing. Unordered, half rule from 20.
 *
 * A board file the leader lists but cannot read (a permission or open-file
 * error, a file that does not parse as a board) is not a deleted board: the
 * round names it in `keep` (kind.ts), so the host keeps its copy, and reads it
 * again next round. Only a file gone since the listing (ENOENT) is removed.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import type { BoardFile } from '../../boards/board-store.js'
import { sha12 } from '../kind.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower, type RowSetState } from '../kind-follower.js'
import type { CopyKind } from './copy-kind.js'
import { copyPath, copyRefusal, markCopyOff } from './gate.js'

export const BOARDS_SCHEMA_VERSION = 1
export const BOARDS_REMOVAL_FLOOR = 20
export const BOARD_COPY_MAX_BYTES = 2 * 1024 * 1024
/** A task id is a file name (board-store.ts TASK_ID_RE). */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const boardsDir = (): string => path.join(WALNUT_HOME, 'boards')
/** Where the follower keeps the copy: the live dir on a host replica, the copy store on the companion. */
const copyDir = (): string => copyPath(boardsDir())

interface Cached { size: number; mtimeMs: number; row: BoardFile; hash: string }
const cache = new Map<string, Cached>()
const hashOf = new WeakMap<object, string>()
const warnedTooBig = new Set<string>()
/** The boards a leaderBoards answer listed but could not read, by that answer. */
const unreadableOf = new WeakMap<object, string[]>()
const warnedUnreadable = new Set<string>()

/** Every board the Mac has, read again only when its file changed. */
export async function leaderBoards(dir = boardsDir()): Promise<BoardFile[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const out: BoardFile[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!TASK_ID_RE.test(id)) continue
    seen.add(id)
    const file = path.join(dir, name)
    try {
      const st = await fsp.stat(file)
      if (!st.isFile()) continue
      if (st.size > BOARD_COPY_MAX_BYTES) {
        if (!warnedTooBig.has(id)) log.session.warn('boards copy: a board is too large to copy, it is read from the Mac', { taskId: id, bytes: st.size })
        warnedTooBig.add(id)
        continue
      }
      let c = cache.get(id)
      if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
        const row = JSON.parse(await fsp.readFile(file, 'utf8')) as BoardFile
        if (!isRow(row) || row.task_id !== id) { unreadable.push(id); continue }
        c = { size: st.size, mtimeMs: st.mtimeMs, row, hash: sha12(JSON.stringify(row)) }
        cache.set(id, c)
        hashOf.set(row, c.hash)
      }
      out.push(c.row)
    } catch (err) {
      // Gone since the listing: the Mac deleted it, so the copy goes too. Anything else is kept.
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') unreadable.push(id)
    }
  }
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
  if (unreadable.length > 0) unreadableOf.set(out, unreadable)
  // Said once per board until it reads again (a round runs on every board write).
  const fresh = unreadable.filter((id) => !warnedUnreadable.has(id))
  warnedUnreadable.clear()
  for (const id of unreadable) warnedUnreadable.add(id)
  if (fresh.length > 0) log.session.warn('boards copy: a board could not be read, the host keeps its copy of it', { taskIds: fresh })
  return out
}

function isRow(v: unknown): v is BoardFile {
  const b = v as Partial<BoardFile> | null
  return !!b && typeof b === 'object' && !Array.isArray(b) && typeof b.task_id === 'string' && TASK_ID_RE.test(b.task_id)
    && typeof b.html === 'string' && typeof b.version === 'number'
}

export const BOARDS_KIND: CopyKind<BoardFile> = {
  kind: 'boards',
  schemaVersion: BOARDS_SCHEMA_VERSION,
  key: (b) => b.task_id,
  hash: (b) => hashOf.get(b) ?? sha12(JSON.stringify(b)),
  ordered: false,
  digest: false,
  choice: 'boards',
  rows: () => leaderBoards(),
  keep: (rows) => unreadableOf.get(rows) ?? [],
  watch: (soon) => {
    const name = `boards-copy-${Math.random().toString(36).slice(2, 10)}`
    let stopped = false
    void import('../../event-bus.js').then(({ bus, EventNames }) => {
      if (stopped) return
      bus.subscribe(name, () => soon(), { global: true, interest: [EventNames.BOARD_CHANGED] })
    })
    return () => {
      stopped = true
      void import('../../event-bus.js').then(({ bus }) => bus.unsubscribe(name)).catch(() => {})
    }
  },
}

// --- Follower ---

const STATE_FILE = () => path.join(WALNUT_HOME, 'cache', 'replica', 'boards.json')
let state: RowSetState | null = null
let serial = serialChain()

async function load(): Promise<RowSetState> {
  if (state) return state
  let s: RowSetState = { asOf: 0, at: 0, order: [], hashes: {} }
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8')) as Partial<RowSetState> & { v?: number }
    if (raw?.v === 1 && raw.hashes && typeof raw.hashes === 'object') s = { asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: [], hashes: raw.hashes }
  } catch { /* none yet */ }
  state = s
  return s
}

async function save(): Promise<void> {
  if (state) await writeCopyFile(STATE_FILE(), { v: 1, asOf: state.asOf, at: state.at, hashes: state.hashes })
}

async function localIds(): Promise<string[]> {
  const names = await fsp.readdir(copyDir()).catch(() => [] as string[])
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)).filter((id) => TASK_ID_RE.test(id))
}

/**
 * No bus event: BOARD_CHANGED reaches the board's delivery and reminder code,
 * which must never act on a copy, and while the Mac answers the replica's
 * Board tab reads the Mac's own board (the forward).
 */
function changed(): void {}

let follower: RowSetFollower | null = null

export function boardsFollower(): RowSetFollower {
  follower ??= createRowSetFollower<BoardFile>({
    kind: 'boards',
    schemaVersion: BOARDS_SCHEMA_VERSION,
    label: 'boards copy',
    log: log.session,
    removalFloor: BOARDS_REMOVAL_FLOOR,
    ordered: false,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    load,
    save,
    isRow,
    key: (b) => b.task_id,
    localKeys: localIds,
    apply: async ({ rows, removeIds }) => {
      const skipped: string[] = []
      for (const id of removeIds ?? []) {
        if (TASK_ID_RE.test(id)) await fsp.rm(path.join(copyDir(), `${id}.json`), { force: true })
      }
      for (const b of rows ?? []) {
        // Same cap as the leader's: a board this large is never stored here.
        if (Buffer.byteLength(JSON.stringify(b)) > BOARD_COPY_MAX_BYTES) { skipped.push(b.task_id); continue }
        await writeCopyFile(path.join(copyDir(), `${b.task_id}.json`), b)
      }
      return { skipped }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld('boards'),
    changed,
    purge: async () => {
      const ids = await localIds()
      for (const id of ids) await fsp.rm(path.join(copyDir(), `${id}.json`), { force: true })
      await markCopyOff('boards')
      state = null
      return { removed: ids.length }
    },
  })
  return follower
}

/** Tests only. */
export function _resetBoardsCopyForTesting(): void {
  state = null
  follower = null
  serial = serialChain()
  cache.clear()
  warnedTooBig.clear()
  warnedUnreadable.clear()
}
