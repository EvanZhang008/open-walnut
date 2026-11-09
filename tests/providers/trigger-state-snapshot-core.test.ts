/**
 * triggers.state.snapshot rules (trigger-state-snapshot-core.ts): who may ask, when
 * the state is frozen, and that the snapshot is the exact file of the asking
 * Walnut, never a fresh, coerced or other-scope state, and never a write.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  TRIGGER_STATE_SNAPSHOT_DIGEST_ALG,
  canonicalTriggerStateJson,
  checkSnapshotLive,
  checkSnapshotRequest,
  readFileBounded,
  seenReliableUntil,
  takeTriggerStateSnapshot,
  type SnapshotLiveFacts,
  type SnapshotRequestFacts,
  type TriggerStateSnapshotDeps,
} from '../../src/providers/trigger-state-snapshot-core.js'
import { TRIGGER_STATE_TTL_MS } from '../../src/providers/trigger-check-core.js'

const HOME_A = '/data/walnut-a'
const HOME_B = '/data/walnut-b'
const TID = 'mail-watch-1'

const okRequest = (over: Partial<SnapshotRequestFacts> = {}): SnapshotRequestFacts => ({
  askedHome: HOME_A,
  triggerId: TID,
  socketTriggerScope: HOME_A,
  socketGatewayHome: undefined,
  configuredIds: ['other-trigger'],
  unnamedConfiguredIds: [],
  ...over,
})

const quiet: SnapshotLiveFacts = { armed: false, draining: false, heldUnnamed: false, checkRunning: false, hostDeliveryInFlight: false }

/** Seen entries a few hours old, so none has expired. */
const SEEN_AT = Date.now() - 3 * 60 * 60 * 1000

function validState(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    epoch: 'a1b2c3d4e5f6',
    seen: { 'msg-1': SEEN_AT, 'msg-2': SEEN_AT + 60_000 },
    state: { cursor: 'imap-uid-42' },
    budget: { used: 2, atMs: 1_700_000_000_000 },
    pendingFires: [],
    consecutiveErrors: 0,
    seq: 17,
    lastRunAtMs: 1_700_000_200_000,
    lastFireAtMs: 1_700_000_100_000,
    ...extra,
  }
}

let root: string
let nowMs: number

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-snapshot-'))
  nowMs = Date.now()
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Each Walnut's file sits in its own dir, as walnutScope.dirFor lays it out. */
function fileOf(home: string, id: string): string {
  return path.join(root, home === HOME_A ? 'a' : home === HOME_B ? 'b' : 'unnamed', `${id}.json`)
}

function writeState(home: string, body: string): string {
  const file = fileOf(home, TID)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
  return file
}

function deps(over: Partial<TriggerStateSnapshotDeps> = {}): TriggerStateSnapshotDeps {
  return {
    fs,
    nowMs,
    request: okRequest(),
    liveFacts: () => quiet,
    statePath: fileOf,
    sharedCopyMtimeMs: () => undefined,
    ...over,
  }
}

describe('checkSnapshotRequest: the asking socket must own the named scope', () => {
  it('refuses a command that names no Walnut', () => {
    expect(checkSnapshotRequest(okRequest({ askedHome: '' }))).toMatchObject({ supported: false, reason: 'home_required' })
  })

  it('refuses hostile trigger ids', () => {
    for (const bad of [undefined, 7, '', ' padded', 'a\u0000b', 'line\nbreak', 'x'.repeat(201)]) {
      expect(checkSnapshotRequest(okRequest({ triggerId: bad }))).toMatchObject({ supported: false, reason: 'trigger_id_invalid' })
    }
  })

  it('refuses a socket that pushed another Walnut\'s set, or none', () => {
    expect(checkSnapshotRequest(okRequest({ socketTriggerScope: HOME_B }))).toMatchObject({ reason: 'socket_not_owner' })
    expect(checkSnapshotRequest(okRequest({ socketTriggerScope: undefined }))).toMatchObject({ reason: 'socket_not_owner' })
    expect(checkSnapshotRequest(okRequest({ socketTriggerScope: '' }))).toMatchObject({ reason: 'socket_not_owner' })
  })

  it('refuses a socket bound to another Walnut for gateway calls', () => {
    expect(checkSnapshotRequest(okRequest({ socketGatewayHome: HOME_B }))).toMatchObject({ reason: 'socket_not_owner' })
    expect(checkSnapshotRequest(okRequest({ socketGatewayHome: HOME_A }))).toMatchObject({ ok: true, home: HOME_A })
  })

  it('refuses before the disabled set was pushed, and when the unnamed set carries the id', () => {
    expect(checkSnapshotRequest(okRequest({ configuredIds: undefined }))).toMatchObject({ reason: 'scope_unknown' })
    expect(checkSnapshotRequest(okRequest({ configuredIds: [TID] }))).toMatchObject({ reason: 'still_configured' })
    expect(checkSnapshotRequest(okRequest({ unnamedConfiguredIds: [TID] }))).toMatchObject({ reason: 'held_in_unnamed_scope' })
  })
})

describe('checkSnapshotLive: nothing may move the state', () => {
  it.each([
    ['armed', 'armed'],
    ['draining', 'draining'],
    ['heldUnnamed', 'held_in_unnamed_scope'],
    ['checkRunning', 'check_running'],
    ['hostDeliveryInFlight', 'host_delivery_in_flight'],
  ] as const)('%s refuses', (fact, reason) => {
    expect(checkSnapshotLive({ ...quiet, [fact]: true })).toMatchObject({ supported: false, reason })
  })

  it('a quiet trigger passes', () => {
    expect(checkSnapshotLive(quiet)).toEqual({ ok: true })
  })
})

describe('takeTriggerStateSnapshot', () => {
  it('takes the exact file, digests it, and leaves it untouched', () => {
    const body = JSON.stringify(validState())
    const file = writeState(HOME_A, body)
    const before = fs.statSync(file)
    const reply = takeTriggerStateSnapshot(deps())
    expect(reply.supported).toBe(true)
    if (!reply.supported) return
    expect(reply).toMatchObject({ complete: true, frozen: true, triggerId: TID, digestAlg: TRIGGER_STATE_SNAPSHOT_DIGEST_ALG, seenCount: 2 })
    expect(reply.state).toEqual(validState())
    expect(reply.digest).toBe(createHash('sha256').update(canonicalTriggerStateJson(validState())).digest('hex'))
    expect(reply.fileSha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(reply.stateMtimeMs).toBe(before.mtimeMs)
    // The oldest seen entry expires first.
    expect(reply.seenReliableUntil).toBe(SEEN_AT + TRIGGER_STATE_TTL_MS)
    expect(reply.seenReliableUntil).toBeGreaterThan(nowMs)
    const after = fs.statSync(file)
    expect(fs.readFileSync(file, 'utf-8')).toBe(body)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(fs.readdirSync(path.dirname(file))).toEqual([`${TID}.json`])
  })

  it('keeps a seen id named "__proto__" as an own key through the snapshot and its digest', () => {
    const body = '{"version":1,"epoch":"e1","seen":{"__proto__":' + SEEN_AT + ',"constructor":' + SEEN_AT + '},"state":null,'
      + '"budget":{"used":0,"atMs":' + SEEN_AT + '},"pendingFires":[],"consecutiveErrors":0,"seq":3}'
    writeState(HOME_A, body)
    const reply = takeTriggerStateSnapshot(deps())
    expect(reply.supported).toBe(true)
    if (!reply.supported) return
    expect(Object.keys(reply.state.seen).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(reply.state.seen)).toBe(Object.prototype)
    expect(reply.seenCount).toBe(2)
    // Over the wire and back, the key is still there and the digest still matches.
    const wire = JSON.parse(JSON.stringify(reply)) as typeof reply
    expect(Object.keys(wire.state.seen).sort()).toEqual(['__proto__', 'constructor'])
    expect(createHash('sha256').update(canonicalTriggerStateJson(wire.state)).digest('hex')).toBe(reply.digest)
    expect(canonicalTriggerStateJson(wire.state.seen)).toContain('"__proto__":')
  })

  it('an already expired seen entry still snapshots, with seenReliableUntil in the past, and is not pruned', () => {
    const expiredAt = nowMs - TRIGGER_STATE_TTL_MS - 60_000
    const body = JSON.stringify(validState({ seen: { 'msg-old': expiredAt, 'msg-new': SEEN_AT } }))
    const file = writeState(HOME_A, body)
    const reply = takeTriggerStateSnapshot(deps())
    expect(reply.supported).toBe(true)
    if (!reply.supported) return
    expect(reply.state.seen).toEqual({ 'msg-old': expiredAt, 'msg-new': SEEN_AT })
    expect(reply.seenReliableUntil).toBe(expiredAt + TRIGGER_STATE_TTL_MS)
    expect(reply.seenReliableUntil).toBeLessThanOrEqual(nowMs)
    expect(fs.readFileSync(file, 'utf-8')).toBe(body)
  })

  it('seenReliableUntil is bounded by the file\'s prune and by now', () => {
    expect(seenReliableUntil({}, nowMs - 1_000, nowMs)).toBe(nowMs - 1_000 + TRIGGER_STATE_TTL_MS)
    expect(seenReliableUntil({}, nowMs + 1_000, nowMs)).toBe(nowMs + TRIGGER_STATE_TTL_MS)
    expect(seenReliableUntil({ a: nowMs - 5_000 }, nowMs, nowMs)).toBe(nowMs - 5_000 + TRIGGER_STATE_TTL_MS)
  })

  it('a missing file is unsupported, never a fresh state, and creates nothing', () => {
    const reply = takeTriggerStateSnapshot(deps())
    expect(reply).toMatchObject({ supported: false, reason: 'state_missing' })
    expect(fs.existsSync(path.join(root, 'a'))).toBe(false)
  })

  it('never falls back to another Walnut\'s file (hostile scope)', () => {
    writeState(HOME_B, JSON.stringify(validState()))
    const asked: string[] = []
    const reply = takeTriggerStateSnapshot(deps({ statePath: (h, id) => { asked.push(h); return fileOf(h, id) } }))
    expect(reply).toMatchObject({ supported: false, reason: 'state_missing' })
    expect(asked).toEqual([HOME_A])
    // A socket of the other Walnut asking for A's trigger never reaches a file.
    const paths: string[] = []
    const foreign = takeTriggerStateSnapshot(deps({
      request: okRequest({ socketTriggerScope: HOME_B }),
      statePath: (h, id) => { paths.push(h); return fileOf(h, id) },
    }))
    expect(foreign).toMatchObject({ supported: false, reason: 'socket_not_owner' })
    expect(paths).toEqual([])
  })

  it('an armed trigger, or a disarmed one whose check still runs, is refused before any read', () => {
    writeState(HOME_A, JSON.stringify(validState()))
    for (const facts of [{ ...quiet, armed: true }, { ...quiet, checkRunning: true }, { ...quiet, hostDeliveryInFlight: true }]) {
      let read = false
      const reply = takeTriggerStateSnapshot(deps({ liveFacts: () => facts, statePath: (h, id) => { read = true; return fileOf(h, id) } }))
      expect(reply.supported).toBe(false)
      expect(read).toBe(false)
    }
  })

  it('a file with a pending fire is refused', () => {
    writeState(HOME_A, JSON.stringify(validState({ pendingFires: [{ seq: 18, atMs: nowMs, items: [{ id: 'msg-3' }], durationMs: 5 }] })))
    expect(takeTriggerStateSnapshot(deps())).toMatchObject({ supported: false, reason: 'pending_fires' })
  })

  it('corrupt or unfamiliar files are refused, never coerced', () => {
    const cases: Array<[string, string]> = [
      ['not json', 'state_corrupt'],
      ['[1,2]', 'state_corrupt'],
      [JSON.stringify(validState({ version: 2 })), 'state_corrupt'],
      [JSON.stringify(validState({ epoch: '' })), 'state_corrupt'],
      [JSON.stringify(validState({ seen: { a: 'yesterday' } })), 'state_corrupt'],
      [JSON.stringify(validState({ seq: -1 })), 'state_corrupt'],
      [JSON.stringify(validState({ budget: undefined })), 'state_corrupt'],
      [JSON.stringify(validState({ sharedCopy: false })), 'state_corrupt'],
      [JSON.stringify(validState({ day: { key: '2026-11-07', fires: 1 } })), 'state_unknown_field'],
    ]
    for (const [body, reason] of cases) {
      writeState(HOME_A, body)
      expect(takeTriggerStateSnapshot(deps())).toMatchObject({ supported: false, reason })
    }
  })

  it('a stale file, a future mtime and a newer shared copy are unsupported', () => {
    const file = writeState(HOME_A, JSON.stringify(validState({ sharedCopy: true })))
    const old = (nowMs - TRIGGER_STATE_TTL_MS - 60_000) / 1000
    fs.utimesSync(file, old, old)
    expect(takeTriggerStateSnapshot(deps())).toMatchObject({ reason: 'state_stale' })
    const future = (nowMs + 60 * 60_000) / 1000
    fs.utimesSync(file, future, future)
    expect(takeTriggerStateSnapshot(deps())).toMatchObject({ reason: 'mtime_in_future' })
    const at = nowMs / 1000
    fs.utimesSync(file, at, at)
    const mtime = fs.statSync(file).mtimeMs
    expect(takeTriggerStateSnapshot(deps({ sharedCopyMtimeMs: () => mtime + 5_000 }))).toMatchObject({ reason: 'shared_copy_newer' })
    expect(takeTriggerStateSnapshot(deps({ sharedCopyMtimeMs: () => mtime }))).toMatchObject({ supported: true })
  })

  it('a symlinked state file is not followed', () => {
    const real = path.join(root, 'elsewhere.json')
    fs.writeFileSync(real, JSON.stringify(validState()))
    fs.mkdirSync(path.join(root, 'a'), { recursive: true })
    fs.symlinkSync(real, fileOf(HOME_A, TID))
    expect(takeTriggerStateSnapshot(deps())).toMatchObject({ supported: false, reason: 'state_not_regular_file' })
  })
})

describe('readFileBounded', () => {
  it('refuses a file past the bound and reads one within it', () => {
    const file = path.join(root, 'f.json')
    fs.writeFileSync(file, 'x'.repeat(64))
    expect(readFileBounded(fs, file, 63)).toMatchObject({ kind: 'too_large' })
    const ok = readFileBounded(fs, file, 64)
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.bytes.toString()).toBe('x'.repeat(64))
  })

  it('a directory is not a regular file', () => {
    expect(readFileBounded(fs, root, 1024)).toEqual({ kind: 'not_regular' })
  })
})

describe('canonicalTriggerStateJson', () => {
  it('is independent of key order and keeps array order', () => {
    expect(canonicalTriggerStateJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}')
    expect(canonicalTriggerStateJson({ a: { c: null, d: [3, 1] }, b: 1 })).toBe(canonicalTriggerStateJson({ b: 1, a: { d: [3, 1], c: null } }))
  })
})
