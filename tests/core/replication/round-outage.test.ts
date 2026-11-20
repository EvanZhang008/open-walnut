/**
 * A replication round to a target that cannot be reached is a wait, not a fault
 * (src/core/replication/round-outage.ts). 2026-11-14: clouddev's stream lane was
 * down for five hours and "copies: round failed" logged up to 1,191 warns an hour,
 * one per kind per round. These tests pin the classifier to its producers and
 * guard the class: every leader round that reports a failure goes through
 * noteRoundFailure, so a new round driver cannot bring the spike back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log as walnutLog } from '../../../src/logging/index.js'
import { copyKindHeldBy, syncCopyKinds, type CopyKind } from '../../../src/core/replication/kinds/copy-kind.js'
import { _resetReplicaStatusForTesting } from '../../../src/core/replication/replica-status.js'
import {
  _resetRoundOutagesForTesting, answered, answeredBy, noteRefusalEnded, noteRoundFailure, OUTAGE_RENOTE_MS, noteRoundReached, targetRefused, targetUnreachable, UNREACHABLE_SIGNATURES,
} from '../../../src/core/replication/round-outage.js'

const ROOT = path.resolve(__dirname, '../../..')

function recorder() {
  const lines: Array<{ level: 'warn' | 'info'; message: string; data?: Record<string, unknown> }> = []
  return {
    lines,
    log: {
      warn: (message: string, data?: Record<string, unknown>) => { lines.push({ level: 'warn', message, data }) },
      info: (message: string, data?: Record<string, unknown>) => { lines.push({ level: 'info', message, data }) },
    },
  }
}

describe('targetUnreachable', () => {
  // Every string here is an error a round logged on 2026-11-13/14 while a host was away.
  it.each([
    'the stream lane to clouddev is not up; a background copy waits for it',
    'the host is not connected',
    'the lane was closed',
    'the stream lane to clouddev closed',
    'the stream lane to clouddev is not up',
    'the link to clouddev closed',
    'no server on this host follows that Walnut',
    'getaddrinfo ENOTFOUND wn.example.dev',
    'connect ECONNREFUSED 127.0.0.1:443',
    'ECONNREFUSED: Unable to connect. Is the computer able to access the url?', // bun's fetch
    'replica.sync: the upload channel to olddev is not up (its own SSH connection will not open: its SSH forward did not open) (waited 10s); nothing was sent, try again',
    'DaemonConnection not connected to olddev',
    'DaemonConnection not connected to home-pc: the link stopped answering',
    'replica.sync: the upload channel to olddev is not up (its own SSH connection will not open: its SSH forward did not open (code 255: user@dev-host: Permission denied (publickey).)) (waited 10s); nothing was sent, try again',
  ])('a target that is away: %s', (error) => {
    expect(targetUnreachable(error)).toBe(true)
  })

  // The target was reached (or may have been): these stay warns on every round.
  it.each([
    'The operation timed out.',
    'socket hang up',
    'no answer from the follower within 60s',
    'HTTP 500',
    'refused',
    'replica.drop refused',
    'the host is not connected to the network share', // not the producer's exact sentence
    // A follower's own reply naming its downstream failure: the follower answered.
    'search sync failed: connect ECONNREFUSED 127.0.0.1:5432',
    'upstream said: getaddrinfo ENOTFOUND db.internal',
    'daemon command lost: replica.sync: connection closed before box answered',
  ])('a fault, not an outage: %s', (error) => {
    expect(targetUnreachable(error)).toBe(false)
  })

  it('each signature is pinned to wording its producer still writes', () => {
    for (const s of UNREACHABLE_SIGNATURES) {
      if (!s.literal) continue
      const src = fs.readFileSync(path.join(ROOT, s.producer), 'utf8')
      expect(src, `${s.producer} no longer says ${s.literal}: update UNREACHABLE_SIGNATURES`).toContain(s.literal)
    }
    // The daemon's JS twin says the same as the bun binary.
    expect(fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf8')).toContain('no server on this host follows that Walnut')
  })
})

describe('noteRoundFailure / noteRoundReached', () => {
  beforeEach(() => _resetRoundOutagesForTesting())

  it('an outage is one info line however many rounds fail, and one more when the target answers', () => {
    const { lines, log } = recorder()
    const away = 'the stream lane to clouddev is not up; a background copy waits for it'
    for (let i = 0; i < 500; i++) {
      expect(noteRoundFailure(log, 'copies', 'host:clouddev', away, { kind: i % 2 ? 'routines' : 'sessions' }, { now: 1_000 + i })).toBe(true)
    }
    expect(lines).toEqual([{ level: 'info', message: 'copies: a target is not reachable, its rounds wait for it', data: { target: 'host:clouddev', kind: 'sessions', error: away } }])
    noteRoundReached(log, 'copies', 'host:clouddev', { now: 61_000 })
    expect(lines[1]).toEqual({ level: 'info', message: 'copies: a target is reachable again', data: { target: 'host:clouddev', waitedS: 60, rounds: 500, error: away } })
    // Reached again with no outage: nothing.
    noteRoundReached(log, 'copies', 'host:clouddev')
    expect(lines).toHaveLength(2)
    // A new outage is a new line.
    noteRoundFailure(log, 'copies', 'host:clouddev', 'the host is not connected')
    expect(lines).toHaveLength(3)
    expect(lines.every((l) => l.level === 'info')).toBe(true)
  })

  it('an outage that lasts says so again once an hour, still as info', () => {
    const { lines, log } = recorder()
    const away = 'the host is not connected'
    noteRoundFailure(log, 'copies', 'host:a', away, {}, { now: 0 })
    noteRoundFailure(log, 'copies', 'host:a', away, {}, { now: OUTAGE_RENOTE_MS - 1 })
    noteRoundFailure(log, 'copies', 'host:a', away, {}, { now: OUTAGE_RENOTE_MS })
    noteRoundFailure(log, 'copies', 'host:a', away, {}, { now: OUTAGE_RENOTE_MS + 5 })
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['info', 'copies: a target is not reachable, its rounds wait for it'],
      ['info', 'copies: a target is still not reachable, its rounds wait for it'],
    ])
    expect(lines[1]!.data).toMatchObject({ waitedS: OUTAGE_RENOTE_MS / 1000, rounds: 3 })
  })

  it('a gateway error is not the target answering', () => {
    expect(answered({ ok: true })).toBe(true)
    expect(answered({ ok: false, status: 500 })).toBe(true)
    expect(answered({ ok: false, status: 409 })).toBe(true)
    for (const status of [502, 503, 504]) expect(answered({ ok: false, status })).toBe(false)
    expect(answered({ ok: false })).toBe(false)
  })

  it('a fault is a warn every round, and does not hide behind an outage', () => {
    const { lines, log } = recorder()
    noteRoundFailure(log, 'copies', 'host:clouddev', 'the host is not connected')
    for (let i = 0; i < 3; i++) expect(noteRoundFailure(log, 'copies', 'host:clouddev', 'HTTP 500', { kind: 'boards' })).toBe(false)
    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(3)
    expect(lines[1]).toEqual({ level: 'warn', message: 'copies: round failed', data: { target: 'host:clouddev', kind: 'boards', error: 'HTTP 500' } })
  })

  it('scopes and targets keep their own outages', () => {
    const { lines, log } = recorder()
    const away = 'the host is not connected'
    noteRoundFailure(log, 'copies', 'host:a', away)
    noteRoundFailure(log, 'copies', 'host:b', away)
    noteRoundFailure(log, 'task replica', 'host:a', away)
    noteRoundReached(log, 'copies', 'host:a')
    noteRoundFailure(log, 'task replica', 'host:a', away)
    expect(lines.map((l) => `${l.message} ${l.data?.target}`)).toEqual([
      'copies: a target is not reachable, its rounds wait for it host:a',
      'copies: a target is not reachable, its rounds wait for it host:b',
      'task replica: a target is not reachable, its rounds wait for it host:a',
      'copies: a target is reachable again host:a',
    ])
  })

  it('answeredBy ends the outage on any answer of the target, never on a transport error', async () => {
    const { lines, log } = recorder()
    noteRoundFailure(log, 'copies', 'host:a', 'the host is not connected')
    let reply: { ok: boolean; status?: number } = { ok: false }
    const target = answeredBy(log, 'copies', { id: 'host:a', label: 'a', post: async () => reply as never })
    await target.post({ op: 'status' })
    expect(lines).toHaveLength(1)
    reply = { ok: false, status: 500 }
    await target.post({ op: 'status' })
    expect(lines.at(-1)?.message).toBe('copies: a target is reachable again')
    expect(target.label).toBe('a')
  })
  // 2026-11-20: the one tree moved every note, the companion's build could not take moves, and
  // every round to it wrote "host replica: round failed" (178 in one hour across the hosts).
  const REFUSAL = 'manifest_removes_most_rows: the manifest would remove 6673 of 6673 notes kept here'

  it('a refusal by the half rule is one info line per kind however many rounds, and the target counts as reached', () => {
    const { lines, log } = recorder()
    for (let i = 0; i < 200; i++) {
      expect(noteRoundFailure(log, 'host replica', 'companion', REFUSAL, { kind: 'notes' }, { now: 1_000 + i })).toBe(false)
    }
    expect(lines).toEqual([{
      level: 'info', message: 'host replica: a target refused a manifest that removes most of its copy, its rounds keep it until that changes',
      data: { target: 'companion', kind: 'notes', error: REFUSAL },
    }])
    // The host answering, or taking another kind, does not end it.
    noteRefusalEnded(log, 'host replica', 'companion', 'memory', { now: 2_000 })
    noteRoundReached(log, 'host replica', 'companion', { now: 2_000 })
    noteRoundFailure(log, 'host replica', 'companion', REFUSAL, { kind: 'notes' }, { now: 2_000 })
    expect(lines).toHaveLength(1)
    // Another kind on the same host is its own refusal.
    noteRoundFailure(log, 'host replica', 'companion', REFUSAL, { kind: 'skills' }, { now: 2_000 })
    expect(lines).toHaveLength(2)
    // The kind's round is taken: the refusal ends, and a later one is a new line.
    noteRefusalEnded(log, 'host replica', 'companion', 'notes', { now: 61_000 })
    expect(lines[2]).toEqual({ level: 'info', message: 'host replica: a target took a manifest it had refused', data: { target: 'companion', kind: 'notes', waitedS: 60, rounds: 201 } })
    noteRoundFailure(log, 'host replica', 'companion', REFUSAL, { kind: 'notes' }, { now: 62_000 })
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => l.level === 'info')).toBe(true)
  })

  it('a refusal that stands says so again once an hour, and never hides a fault on the same host', () => {
    const { lines, log } = recorder()
    noteRoundFailure(log, 'task replica', 'companion', 'manifest_removes_most_rows', { kind: 'tasks' }, { now: 0 })
    noteRoundFailure(log, 'task replica', 'companion', 'manifest_removes_most_rows', { kind: 'tasks' }, { now: OUTAGE_RENOTE_MS - 1 })
    noteRoundFailure(log, 'task replica', 'companion', 'manifest_removes_most_rows', { kind: 'tasks' }, { now: OUTAGE_RENOTE_MS })
    noteRoundFailure(log, 'task replica', 'companion', 'HTTP 500', { kind: 'tasks' })
    expect(lines.map((l) => [l.level, l.message])).toEqual([
      ['info', 'task replica: a target refused a manifest that removes most of its copy, its rounds keep it until that changes'],
      ['info', 'task replica: a target still refuses a manifest that removes most of its copy'],
      ['warn', 'task replica: round failed'],
    ])
  })

  it('each producer of the refusal words it as targetRefused reads it', () => {
    // The host daemon's cores prefix the code to their sentence; the generic follower answers the bare code.
    expect(targetRefused('manifest_removes_most_rows: the manifest would remove 3545 of 3545 files kept here')).toBe(true)
    expect(targetRefused('manifest_removes_most_rows')).toBe(true)
    expect(targetRefused('replica.sync: manifest_removes_most_rows: the manifest would remove 9 of 10 notes kept here')).toBe(true)
    // Only the refusal itself: a reply that merely mentions it later, or a confirm refused, is not.
    expect(targetRefused('HTTP 500')).toBe(false)
    expect(targetRefused('upstream said: manifest_removes_most_rows')).toBe(false)
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const rel of ['src/providers/host-replica-core.ts', 'src/providers/attachment-copy-core.ts']) {
      expect(read(rel), `${rel}: a refusal is \`refused('manifest_removes_most_rows', ...)\``).toContain("refused('manifest_removes_most_rows'")
      expect(read(rel), `${rel}: refused() prefixes the code to the message`).toMatch(/`\$\{code\}: \$\{message\}`|code \+ ': ' \+ message/)
    }
    expect(read('src/core/replication/kind-follower.ts')).toContain('error: REFUSAL_ERROR')
    expect(read('src/core/replication/kind.ts')).toContain("export const REFUSAL_ERROR = 'manifest_removes_most_rows'")
  })
})

describe('syncCopyKinds while a host is away (the 2026-11-14 spike)', () => {
  beforeEach(() => { _resetRoundOutagesForTesting(); _resetReplicaStatusForTesting() })
  afterEach(() => vi.restoreAllMocks())

  const kindOf = (name: string): CopyKind<{ id: string }> => ({
    kind: name, schemaVersion: 1, key: (r) => r.id, hash: (r) => r.id,
    rows: async () => [{ id: `${name}-1` }], ordered: false, digest: false, choice: 'sessions', watch: () => () => {},
  })

  it('one kind tries the host per round, the others wait untried, and the outage is two info lines in all', async () => {
    const warn = vi.spyOn(walnutLog.session, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(walnutLog.session, 'info').mockImplementation(() => {})
    let up = false
    const posts: string[] = []
    const target = {
      id: 'host:t', kind: 'host' as const, label: 't', program: () => 'replica', available: async () => true,
      post: async (payload: Record<string, unknown>) => {
        posts.push(String(payload.kind))
        return up ? { ok: true as const, reply: { ok: true, need: [] } }
          : { ok: false as const, outcome: 'failed' as const, error: 'the stream lane to t is not up; a background copy waits for it' }
      },
    }
    const kinds = [kindOf('sessions'), kindOf('routines'), kindOf('boards')]
    for (let round = 0; round < 20; round++) {
      const results = await syncCopyKinds(kinds, { targets: () => [target] })
      expect(results.map((r) => r.action)).toEqual(['failed', 'failed', 'failed'])
    }
    expect(posts).toHaveLength(20) // one step per round, not one per kind
    for (const k of kinds) expect(copyKindHeldBy('host:t', k.kind)).toBe(false)
    expect(warn.mock.calls.filter(([m]) => m === 'copies: round failed')).toEqual([])
    expect(info.mock.calls.filter(([m]) => m === 'copies: a target is not reachable, its rounds wait for it')).toHaveLength(1)

    up = true
    const results = await syncCopyKinds(kinds, { targets: () => [target] })
    expect(results.map((r) => r.action)).toEqual(['synced', 'synced', 'synced'])
    for (const k of kinds) expect(copyKindHeldBy('host:t', k.kind)).toBe(true)
    expect(info.mock.calls.filter(([m]) => m === 'copies: a target is reachable again')).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a kind the host turned off is purged once it is back, without a warn per round while it is away', async () => {
    const warn = vi.spyOn(walnutLog.session, 'warn').mockImplementation(() => {})
    vi.spyOn(walnutLog.session, 'info').mockImplementation(() => {})
    let up = false
    const ops: string[] = []
    const target = {
      id: 'host:t', kind: 'host' as const, label: 't', program: () => 'replica', available: async () => true,
      copies: async () => ({ sessions: false }),
      post: async (payload: Record<string, unknown>) => {
        ops.push(String(payload.op))
        return up ? { ok: true as const, reply: { ok: true, removed: 1 } }
          : { ok: false as const, outcome: 'failed' as const, error: 'the host is not connected' }
      },
    }
    const kinds = [kindOf('sessions'), kindOf('routines')]
    for (let round = 0; round < 5; round++) await syncCopyKinds(kinds, { targets: () => [target] })
    expect(ops).toEqual(['purge', 'purge', 'purge', 'purge', 'purge'])
    expect(warn).not.toHaveBeenCalled()
    up = true
    const results = await syncCopyKinds(kinds, { targets: () => [target] })
    expect(results.map((r) => r.removed)).toEqual([1, 1])
    // Purged: never sent again while the kind stays off.
    await syncCopyKinds(kinds, { targets: () => [target] })
    expect(ops.filter((o) => o === 'purge')).toHaveLength(7)
  })

  it('a kind the target already holds keeps its state when another kind finds the host away', async () => {
    vi.spyOn(walnutLog.session, 'warn').mockImplementation(() => {})
    vi.spyOn(walnutLog.session, 'info').mockImplementation(() => {})
    let up = true
    const target = {
      id: 'host:t', kind: 'host' as const, label: 't', program: () => 'replica', available: async () => true,
      post: async () => (up ? { ok: true as const, reply: { ok: true, need: [] } }
        : { ok: false as const, outcome: 'failed' as const, error: 'the host is not connected' }),
    }
    let rows = 1
    const changing: CopyKind<{ id: string }> = { ...kindOf('sessions'), rows: async () => [{ id: `s-${rows}` }] }
    const kinds = [changing, kindOf('routines')]
    await syncCopyKinds(kinds, { targets: () => [target] })
    up = false
    rows = 2 // sessions changed, routines did not
    const results = await syncCopyKinds(kinds, { targets: () => [target] })
    expect(results.map((r) => r.action)).toEqual(['failed', 'unchanged'])
    expect(copyKindHeldBy('host:t', 'routines')).toBe(true)
    expect(copyKindHeldBy('host:t', 'sessions')).toBe(false)
  })

  it('a fault on the host is still a warn for each kind', async () => {
    const warn = vi.spyOn(walnutLog.session, 'warn').mockImplementation(() => {})
    vi.spyOn(walnutLog.session, 'info').mockImplementation(() => {})
    const target = {
      id: 'host:t', kind: 'host' as const, label: 't', program: () => 'replica', available: async () => true,
      post: async () => ({ ok: false as const, outcome: 'failed' as const, status: 500 }),
    }
    await syncCopyKinds([kindOf('sessions'), kindOf('routines')], { targets: () => [target] })
    expect(warn.mock.calls.filter(([m]) => m === 'copies: round failed')).toHaveLength(2)
  })
})

/**
 * The class guard: a leader's replication round that logs its failure itself
 * writes a warn per round while a target is away. Every file under src/ that
 * drives a round (posts steps to a follower) must import round-outage, and no
 * file may log a "round failed" warn of its own, except the catch-alls that only
 * see a crash of the scheduler (a bug, never an outage).
 */
describe('every replication round reports its failures through round-outage', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const files = walk(path.join(ROOT, 'src')).map((p) => ({ rel: path.relative(ROOT, p), src: fs.readFileSync(p, 'utf8') }))

  it('no own "round failed" warn outside the catch-alls', () => {
    const CATCH_ALLS = new Set([
      'copies: scheduler round failed',
      'DaemonConnection: host replica round failed',
    ])
    const found: string[] = []
    for (const f of files) {
      for (const m of f.src.matchAll(/\.warn\(\s*['`]([^'`]*(?:round failed|did not take the device list)[^'`]*)['`]/g)) {
        if (!CATCH_ALLS.has(m[1]!)) found.push(`${f.rel}: ${m[1]}`)
      }
    }
    expect(found, 'log a round failure with noteRoundFailure (src/core/replication/round-outage.ts)').toEqual([])
  })

  it('a round driver adds no warn of its own without saying it is not a failed step', () => {
    // Each warn a round driver writes today, none of them a step that failed on the way.
    // A new one that reports a failed step goes through noteRoundFailure instead.
    const ALLOWED = new Set([
      'host replica: the host refused a manifest that removes most of its copy',
      'host replica: the user confirmed a removal of most of a host copy',
      // The leader's own record of what each host took (a cache: the next round sends whole lists).
      'host replica: the manifests the hosts took could not be kept on disk',
      'device replica: the pairings could not be read, nothing sent this round',
      'copies: could not read the leader rows of a kind',
      'copies: the user confirmed a removal of most rows',
      'copies: scheduler round failed',
      'search replica: round crashed',
      'task replica: the user confirmed a removal of most rows',
      // The companion answered and refused the push (a 5xx): it was reached, so a fault.
      'cloud ingest: push refused',
    ])
    // The rounds, and the background push lanes to the companion (2026-11-17:
    // "cloud ingest: push failed" logged a warn per push while the Mac's DNS was down).
    const DRIVERS = ['src/core/host-replica.ts', 'src/core/replication/device-replica.ts', 'src/core/replication/kinds/copy-kind.ts',
      'src/core/replication/search-replica.ts', 'src/core/replication/task-replica.ts', 'src/core/cloud-ingest.ts']
    const extra: string[] = []
    for (const rel of DRIVERS) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      const calls = src.match(/\.warn\(/g)?.length ?? 0
      const literals = [...src.matchAll(/\.warn\(\s*'([^']*)'/g)].map((m) => m[1]!)
      if (literals.length !== calls) extra.push(`${rel}: a warn whose message is not a plain literal`)
      for (const m of literals) if (!ALLOWED.has(m)) extra.push(`${rel}: ${m}`)
    }
    expect(extra, 'a failed step is reported with noteRoundFailure (round-outage.ts); any other new warn is listed here').toEqual([])
  })

  it('every round that reports a failure by kind ends that kind\'s refusal when its round is taken', () => {
    // A refusal is kept per scope, target and kind until noteRefusalEnded names the kind; a
    // driver that reports refusals by kind but never says when a kind is taken would keep a
    // refusal for the life of the process and hide the next one (2026-11-20).
    const missing: string[] = []
    let failures = 0
    for (const f of files) {
      if (f.rel === 'src/core/replication/round-outage.ts') continue
      for (const m of f.src.matchAll(/noteRoundFailure\(\s*[\w.]+,\s*'([^']+)',[^\n]*\{\s*kind\b/g)) {
        failures++
        const scope = m[1]!
        const ends = new RegExp(`noteRefusalEnded\\(\\s*[\\w.]+,\\s*'${scope}',`)
        if (!ends.test(f.src)) missing.push(`${f.rel}: '${scope}'`)
      }
    }
    expect(failures).toBeGreaterThanOrEqual(4)
    expect(missing, 'call noteRefusalEnded(log, scope, target, kind) when the target holds that kind\'s manifest').toEqual([])
  })

  it('every round driver imports round-outage', () => {
    // A driver posts steps to a follower: a kind round, a delta, a put of its own, or the host replica's sends.
    // A background push lane posts to the companion's endpoint (cloud-ingest.ts resolveEndpoint).
    const DRIVES = /\brunKindRound\(|\brunCopyRound\(|\btarget\.post\(\{|\btarget\.send\('replica\.|\bawait resolveEndpoint\(\)/
    // The library the drivers call: it throws, and its callers report.
    const LIBRARY = new Set(['src/core/replication/kind-leader.ts', 'src/core/replication/kind-delta.ts'])
    const drivers = files.filter((f) => DRIVES.test(f.src) && !LIBRARY.has(f.rel)).map((f) => f.rel).sort()
    expect(drivers.length).toBeGreaterThanOrEqual(5)
    const missing = drivers.filter((rel) => !files.find((f) => f.rel === rel)!.src.includes('round-outage.js'))
    expect(missing, 'a replication round driver must report failures through round-outage').toEqual([])
  })
})
