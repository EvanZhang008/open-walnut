/**
 * Shared harness for the journal v2 tests (offline-journal-core.ts and the offline
 * host over it): real files in a temp dir, a fake clock, and a switch for the kinds
 * the leading Mac drains. Every dir it makes is removed by `cleanupJournalDirs()`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createOfflineJournal, JOURNAL_V2_DRAINS, type OfflineJournalDeps } from '../../src/providers/offline-journal-core.js'
import { createOfflineHost, type HostSlice, type OfflineHostDeps } from '../../src/providers/offline-host-core.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { createBoardOffline } from '../../src/providers/offline-board-core.js'

export const JHOME = '/fixture/marina-home'
export const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
export const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222'
export const TASK_A = 'mtaskaaa-0001'
export const TASK_B = 'mtaskbbb-0002'
export const DEVICE = { kind: 'device' as const, deviceId: 'dev-acme-phone', name: 'Acme phone' }

const made: string[] = []
let base: string | null = null

/**
 * A temp dir inside a private base dir of this run (0700, this user's): a test that passes
 * one as a legacy dir passes the migration's ownership check of the dir holding it, which
 * os.tmpdir() itself (root's /tmp on Linux, world writable) would not.
 */
export function journalTmpDir(prefix = 'journal-v2-'): string {
  if (!base || !fs.existsSync(base)) base = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-base-'))
  const d = fs.mkdtempSync(path.join(base, prefix))
  made.push(d)
  return d
}

export function cleanupJournalDirs(): void {
  for (const d of made.splice(0)) {
    try { fs.chmodSync(d, 0o700) } catch { /* gone */ }
    fs.rmSync(d, { recursive: true, force: true })
  }
  if (base) { fs.rmSync(base, { recursive: true, force: true }); base = null }
}

export const keyOf = (home: string) => createHash('sha1').update(home).digest('hex').slice(0, 16)
export const sha256 = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')

export interface Clock { now: number }

export function journalStore(dir: string, clock: Clock, over: Partial<OfflineJournalDeps> = {}) {
  return createOfflineJournal({
    fs, path, dir, now: () => clock.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf, sha256, log: () => {},
    ...over,
  })
}

export function jslice(overrides: Partial<HostSlice> = {}): HostSlice {
  return {
    v: 1, home: JHOME, hash: 'h1', asOf: Date.parse('2026-10-14T10:00:00Z'), host: 'devbox',
    sessions: [
      { sid: SID_A, taskId: TASK_A, title: 'Leader work' },
      { sid: SID_B, taskId: TASK_B, title: 'Worker: build the page' },
    ],
    tasks: [
      { id: TASK_A, title: 'Leader work', phase: 'IN_PROGRESS', project: 'Acme', updated_at: '2026-10-14T09:00:00Z', description: 'first line' },
      { id: TASK_B, title: 'Worker: build the page', phase: 'IN_PROGRESS', project: 'Acme', parent_task_id: TASK_A },
    ],
    requests: [],
    ...overrides,
  }
}

/** An offline host over a real journal store; `drains.kinds` is what the leading Mac drains. */
export function journalHost(dir: string, clock: Clock, opts: { drains?: string[] | null; journal?: Partial<OfflineJournalDeps>; boards?: boolean; deliver?: OfflineHostDeps['deliver'] } = {}) {
  const drains = { kinds: opts.drains === undefined ? JOURNAL_V2_DRAINS.slice() : opts.drains }
  const journal = journalStore(dir, clock, opts.journal)
  const deps: OfflineHostDeps = {
    fs, path, dir, now: () => clock.now,
    randomHex: (n) => randomBytes(n).toString('hex'),
    keyOf, kit: createEnvelopeKit(), log: () => {},
    isLive: () => true, turnActive: () => false, streamOffset: () => undefined,
    deliver: opts.deliver ?? (async () => ({ ok: true })),
    journal,
    drainsOf: () => drains.kinds,
    ...(opts.boards ? { boards: createBoardOffline() } : {}),
  }
  const host = createOfflineHost(deps)
  return { host, journal, drains, deps }
}

export function gatewayCall(host: ReturnType<typeof createOfflineHost>, sid: string, name: string, args: Record<string, unknown>) {
  return host.handle(JHOME, sid, 'tools.call', { name, args })
}

/** The ndjson file of a home, as lines. */
export function journalLines(dir: string, home = JHOME): string[] {
  try { return fs.readFileSync(path.join(dir, `journal-${keyOf(home)}.ndjson`), 'utf8').split('\n').filter(Boolean) } catch { return [] }
}
