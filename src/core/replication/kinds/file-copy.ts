/**
 * The follower store of a copy kind whose copy is ONE file under the replica's
 * cache (docs/plan/walnut-replica-servers-impl.md, section 4: prefs and config
 * live in `cache/replica/<kind>.json`). That file holds the copy state and the
 * rows together: `{v:1, asOf, at, hashes, rows:{key: row}}`, written at 0600
 * in a 0700 dir through a temp file and a rename (writeCopyFile). The host's
 * choice turning the kind off leaves `{v:1, off:true}` (gate.ts markCopyOff),
 * which reads as no copy.
 *
 * `admit` is the host's own check of a row before it is written (the config
 * copy runs the secret check again): a row it refuses is skipped, not stored,
 * and the leader sees it as not stored.
 */

import fsp from 'node:fs/promises'
import { log } from '../../../logging/index.js'
import { createRowSetFollower, serialChain, writeCopyFile, type RowSetFollower, type RowSetState } from '../kind-follower.js'
import { copyRefusal, copyStateFile, markCopyOff } from './gate.js'

interface FileShape<Row> extends RowSetState { v: 1; rows: Record<string, Row> }

export interface FileCopySpec<Row> {
  kind: string
  schemaVersion: number
  label: string
  removalFloor: number
  isRow(v: unknown): v is Row
  key(row: Row): string
  hash?(row: Row): string
  /** The host's check before it writes a row: false skips it. */
  admit?(row: Row): boolean
}

export interface FileCopy<Row> {
  follower(): RowSetFollower
  /** The copy's rows by key, or null when there is none (never copied, or turned off). */
  read(): Promise<Record<string, Row> | null>
  reset(): void
}

export function createFileCopy<Row>(spec: FileCopySpec<Row>): FileCopy<Row> {
  const file = () => copyStateFile(spec.kind)
  let mem: FileShape<Row> | null = null
  let serial = serialChain()
  let follower: RowSetFollower | null = null

  const readFile = async (): Promise<FileShape<Row> | null> => {
    try {
      const raw = JSON.parse(await fsp.readFile(file(), 'utf8')) as Partial<FileShape<Row>> & { off?: unknown }
      if (raw?.v !== 1 || raw.off === true || !raw.hashes || typeof raw.hashes !== 'object' || !raw.rows || typeof raw.rows !== 'object') return null
      const rows: Record<string, Row> = {}
      for (const [k, r] of Object.entries(raw.rows)) if (spec.isRow(r) && spec.key(r) === k) rows[k] = r
      return { v: 1, asOf: Number(raw.asOf) || 0, at: Number(raw.at) || 0, order: [], hashes: raw.hashes as Record<string, string>, rows }
    } catch { return null }
  }
  const loadMem = async (): Promise<FileShape<Row>> => {
    mem ??= (await readFile()) ?? { v: 1, asOf: 0, at: 0, order: [], hashes: {}, rows: {} }
    return mem
  }
  const persist = async (): Promise<void> => {
    if (mem) await writeCopyFile(file(), { v: 1, asOf: mem.asOf, at: mem.at, hashes: mem.hashes, rows: mem.rows })
  }

  const make = (): RowSetFollower => createRowSetFollower<Row>({
    kind: spec.kind,
    schemaVersion: spec.schemaVersion,
    label: spec.label,
    log: log.session,
    removalFloor: spec.removalFloor,
    ordered: false,
    serial: (fn) => serial(fn),
    refuse: copyRefusal,
    ...(spec.hash ? { hash: spec.hash } : {}),
    // The state IS the file's object: the follower updates asOf, at and hashes in place, save writes them.
    load: async (): Promise<RowSetState> => loadMem(),
    save: persist,
    isRow: spec.isRow,
    key: spec.key,
    localKeys: async () => Object.keys((await loadMem()).rows),
    apply: async ({ rows, removeIds }) => {
      const m = await loadMem()
      const skipped: string[] = []
      for (const k of removeIds ?? []) delete m.rows[k]
      for (const r of rows ?? []) {
        if (spec.admit && !spec.admit(r)) {
          skipped.push(spec.key(r))
          log.session.warn(`${spec.label}: refused a row`, { kind: spec.kind, key: spec.key(r) })
          continue
        }
        m.rows[spec.key(r)] = r
      }
      await persist()
      return { skipped }
    },
    held: async () => (await import('../../../replica/journal-overlay.js')).journalHeld(spec.kind),
    changed: () => {},
    purge: async () => {
      const removed = Object.keys((await readFile())?.rows ?? {}).length
      await markCopyOff(spec.kind)
      mem = null
      return { removed }
    },
  })

  return {
    follower: () => (follower ??= make()),
    read: async () => (await readFile())?.rows ?? null,
    reset: () => { mem = null; follower = null; serial = serialChain() },
  }
}
