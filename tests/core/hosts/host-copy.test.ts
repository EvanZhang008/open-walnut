/**
 * host_copy's gate and job (src/core/hosts/host-copy.ts, host-copy-paths.ts) against
 * in-process hosts: each host is a temp "home" whose daemon answers fs.readRange and
 * fs.rm like the twins and runs the REAL fs.writePart core
 * (tests/helpers/fake-copy-host.ts), and the relay is the real relayFile. Stubbed: who
 * the caller is, the grant gate (exec-grants and its letters, the caller's deadline and
 * the revoke route are the E2E's, tests/e2e/host-copy-e2e.test.ts), and the hosts in
 * Settings. Also the CLI's caller-chosen copy_id (src/providers/host-exec-run-id.ts).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { fakeCopyHost, type FakeCopyHost } from '../../helpers/fake-copy-host.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-copy-unit'))

const gate = vi.hoisted(() => ({
  caller: { sid: 's1', taskId: 'task-1', taskTitle: 'Build the app', host: 'devbox' } as { sid: string; taskId: string; taskTitle: string; host: string },
  /** The host the session record names, as written (undefined: none). */
  rawHost: 'devbox' as string | undefined,
  budget: Number.POSITIVE_INFINITY,
  refuse: new Map<string, { code: string; letterId?: string }>(),
  asked: [] as Array<{ host: string; preview: string | null }>,
}))

vi.mock('../../../src/core/hosts/host-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/hosts/host-exec.js')>()
  return {
    ...real,
    callerOf: async (sid: string | undefined) => {
      if (!sid) throw new real.HostExecError('host_exec runs for a task\'s session', 403, 'session_only')
      return { ...gate.caller }
    },
    grantFor: async (_c: unknown, host: string, preview: string | null) => {
      gate.asked.push({ host, preview })
      const r = gate.refuse.get(host)
      if (r) throw new real.HostExecError(`no grant for ${host}`, 403, r.code, r.letterId ? { letterId: r.letterId } : {})
      return `g-${host}`
    },
    hostName: async (h: string) => h,
    budgetLeft: () => gate.budget,
  }
})

vi.mock('../../../src/core/sessions/session-send-core.js', () => ({
  resolveCaller: async () => ({ kind: 'session', record: { host: gate.rawHost, taskId: gate.caller.taskId } }),
}))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: { macbox: { hostname: 'macbox.example' }, linuxbox: { hostname: 'linuxbox.example' }, devbox: { hostname: 'devbox.example' } } }),
}))

/** What each host's daemon last reported (its profile) and its last preflight: which hosts are Macs. */
const systems = vi.hoisted(() => ({ profiles: new Map<string, { platform?: string; home?: string }>(), preflight: new Map<string, { platform?: string }>() }))
vi.mock('../../../src/core/hosts/host-profile.js', () => ({
  readHostProfile: async (host: string) => {
    const p = systems.profiles.get(host)
    return { host, probed: p ? { os: { platform: p.platform }, home: p.home } : undefined }
  },
}))
vi.mock('../../../src/core/hosts/host-readiness-store.js', () => ({ store: systems.preflight }))

const revoked = vi.hoisted(() => new Set<string>())
vi.mock('../../../src/core/hosts/exec-grants.js', () => ({
  findGrant: (taskId: string, host: string) => (revoked.has(host) ? undefined : { id: `g-${host}`, taskId, host }),
  noteRun: async () => {},
}))

import { __setTransferConnectionResolverForTesting } from '../../../src/core/transfer/daemon-transfer-client.js'
import {
  MAX_COPY_BYTES, copyBetweenHosts, copyFailure, copyResult, resetHostCopyForTest, setHostCopyTuningForTest,
} from '../../../src/core/hosts/host-copy.js'
import { MAC_PROTECTED_IN_HOME, macPlace, planTarget, protectedPath, type Probe } from '../../../src/core/hosts/host-copy-paths.js'
import { awayLines, callerRunId, lostRunLines, refusedRunId } from '../../../src/providers/host-exec-run-id.js'
import { parseOpArgs } from '../../../src/ops/executor.js'
import type { WalnutOp } from '../../../src/ops/registry.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-copy-')))
afterAll(() => { if (root.includes('walnut-host-copy-')) fs.rmSync(root, { recursive: true, force: true }) })

let hosts: Record<string, FakeCopyHost | null> = {}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const SID = 's1'

beforeEach(() => {
  const n = Math.random().toString(36).slice(2, 8)
  hosts = {
    devbox: fakeCopyHost(path.join(root, n, 'devbox')),
    macbox: fakeCopyHost(path.join(root, n, 'macbox')),
    linuxbox: fakeCopyHost(path.join(root, n, 'linuxbox')),
    __local__: fakeCopyHost(path.join(root, n, 'mac')),
  }
  __setTransferConnectionResolverForTesting(async (h) => (hosts[h] ? [hosts[h]!.conn] : []))
  gate.caller = { sid: SID, taskId: 'task-1', taskTitle: 'Build the app', host: 'devbox' }
  gate.rawHost = 'devbox'
  gate.budget = Number.POSITIVE_INFINITY
  gate.refuse.clear()
  gate.asked.length = 0
  revoked.clear()
  systems.profiles.clear()
  systems.preflight.clear()
})

afterEach(() => {
  __setTransferConnectionResolverForTesting(null)
  setHostCopyTuningForTest(null)
  resetHostCopyForTest()
})

function put(host: string, rel: string, data: Buffer | string): string {
  const p = path.join(hosts[host]!.home, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string; message: string; data: Record<string, unknown> }> {
  try {
    await p
  } catch (err) {
    const e = err as { status: number; code: string; message: string; data: Record<string, unknown> }
    return { status: e.status, code: e.code, message: e.message, data: e.data }
  }
  throw new Error('expected a refusal')
}

const writes = (host: string) => hosts[host]!.sent.filter((s) => s.cmd === 'fs.writePart')
const as = (taskId: string) => { gate.caller = { ...gate.caller, taskId } }

describe('planTarget', () => {
  const look = (at: Record<string, Probe>) => async (p: string): Promise<Probe> => at[p] ?? 'missing'
  it.each([
    ['/x/a.tgz', {}, { path: '/x/a.tgz', replaced: false }],
    ['/x/a.tgz', { '/x/a.tgz': 'file' }, { path: '/x/a.tgz', replaced: true }],
    ['/x/', {}, { path: '/x/src.tgz', replaced: false }],
    ['/x//', {}, { path: '/x/src.tgz', replaced: false }],
    ['/x/', { '/x': 'not_file' }, { path: '/x/src.tgz', replaced: false }],
    ['/x', { '/x': 'not_file', '/x/src.tgz': 'file' }, { path: '/x/src.tgz', replaced: true }],
    ['~', { '~': 'not_file' }, { path: '~/src.tgz', replaced: false }],
    ['/', { '/': 'not_file' }, { path: '/src.tgz', replaced: false }],
  ] as Array<[string, Record<string, Probe>, unknown]>)('%s with %j', async (to, at, want) => {
    expect(await planTarget('macbox', to, 'src.tgz', look(at))).toEqual(want)
  })

  it.each([
    ['/x/', { '/x': 'file' }, 'target_not_dir'],
    ['/x/a', { '/x/a': 'parent_not_dir' }, 'target_not_dir'],
    ['/x/', { '/x': 'not_file', '/x/src.tgz': 'not_file' }, 'target_is_directory'],
    ['/dev/fifo', { '/dev/fifo': 'not_file', '/dev/fifo/src.tgz': 'parent_not_dir' }, 'target_not_dir'],
    ['/x/a', { '/x/a': { error: 'EACCES: permission denied' } }, 'target_unknown'],
    ['/x', { '/x': 'not_file', '/x/src.tgz': { error: 'EIO' } }, 'target_unknown'],
  ] as Array<[string, Record<string, Probe>, string]>)('refuses %s with %j', async (to, at, code) => {
    expect(await refusal(planTarget('macbox', to, 'src.tgz', look(at)))).toMatchObject({ status: 409, code })
  })
})

describe('protectedPath', () => {
  it.each([
    ['~/.ssh/id_ed25519', 'credentials'], ['/home/me/.aws/credentials', 'credentials'], ['~/proj/secrets/token', 'credentials'],
    ['~/x/auth.json', 'credentials'], ['~/.open-walnut/config.yaml', 'Walnut\'s own data'], ['/tmp/open-walnut/sessions.json', 'Walnut\'s own data'],
    ['/tmp/open-walnut-streams/s.jsonl', 'Walnut\'s own data'], ['~/.cache/open-walnut/d.log', 'Walnut\'s own data'],
    ['~/.local/state/open-walnut/secrets/k', 'credentials'], ['~/.local/state/open-walnut/net/key', 'Walnut\'s own data'],
    ['~/.local/state/open-walnut/tasks', 'Walnut\'s own data'],
  ])('%s is %s', (p, why) => expect(protectedPath(p)).toBe(why))

  it.each(['~/.local/state/open-walnut/tasks/t-1/src.tgz', '~/projects/open-walnut/ios.tgz', '/tmp/x/my.ssh.notes', '~/build/out.tgz'])('%s is fine', (p) => {
    expect(protectedPath(p)).toBeNull()
  })
})

describe('host_copy', () => {
  it('copies the exact bytes to the other host, then replaces them on a second copy', async () => {
    const body = crypto.randomBytes(5 * 1024 * 1024 + 17)
    put('devbox', 'work/src.tgz', body)
    const r = await copyBetweenHosts({ from: '~/work/src.tgz', to_host: 'macbox', to: '~/build/' }, SID)
    expect(r).toMatchObject({
      running: false, from_host: 'devbox', to_host: 'macbox', from: '~/work/src.tgz', to: '~/build/src.tgz',
      bytes: body.length, sha256: sha(body), chunks: 3, retries: 0, replaced: false, copyId: expect.stringMatching(/^hc-/),
    })
    const landed = path.join(hosts.macbox!.home, 'build', 'src.tgz')
    expect(fs.readFileSync(landed).equals(body)).toBe(true)
    expect(fs.existsSync(`${landed}.walnut-part`)).toBe(false)
    // Only the host that is not the caller's own needed the grant.
    expect(gate.asked.map((a) => a.host)).toEqual(['macbox'])
    expect(gate.asked[0].preview).toBe('host_copy devbox:~/work/src.tgz -> macbox:~/build/')
    // The probes read one byte each, never a listing; the last part may take as long as hashing the whole file.
    expect(hosts.macbox!.sent.filter((s) => s.cmd === 'fs.readRange').map((s) => s.params.length)).toEqual([1])
    const parts = writes('macbox')
    expect(parts.map((s) => s.timeoutMs)).toEqual([60_000, 60_000, 60_000 + 1_000])

    const next = Buffer.from('second version')
    put('devbox', 'work/src.tgz', next)
    // `to` names the folder without a slash: the same name inside it.
    const again = await copyBetweenHosts({ from: '~/work/src.tgz', to_host: 'macbox', to: path.join(hosts.macbox!.home, 'build') }, SID)
    expect(again).toMatchObject({ to: landed, replaced: true, bytes: next.length })
    expect(fs.readFileSync(landed, 'utf8')).toBe('second version')
  })

  it('brings a file back to the caller\'s own host, names with spaces and accents, and an empty file', async () => {
    const name = 'résultats final.mp4'
    put('macbox', `out/${name}`, 'video bytes')
    const back = await copyBetweenHosts({ from_host: 'macbox', from: `~/out/${name}`, to: '~/task/' }, SID)
    expect(back).toMatchObject({ from_host: 'macbox', to_host: 'devbox', to: `~/task/${name}`, bytes: 11 })
    expect(fs.readFileSync(path.join(hosts.devbox!.home, 'task', name), 'utf8')).toBe('video bytes')
    put('macbox', 'out/empty.log', '')
    const empty = await copyBetweenHosts({ from_host: 'macbox', from: '~/out/empty.log', to: '~/task/empty.log' }, SID)
    expect(empty).toMatchObject({ bytes: 0, sha256: sha(Buffer.alloc(0)), replaced: false })
    expect(fs.readFileSync(path.join(hosts.devbox!.home, 'task', 'empty.log')).length).toBe(0)
  })

  it('a session record with no host has no grant-free side: the Mac side asks for its grant too', async () => {
    gate.rawHost = undefined
    gate.caller = { ...gate.caller, host: '__local__' }
    put('__local__', 'src.tgz', 'from the Mac')
    const r = await copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/' }, SID)
    expect(r).toMatchObject({ from_host: '__local__', to_host: 'macbox', bytes: 12 })
    expect(gate.asked.map((a) => a.host)).toEqual(['__local__', 'macbox'])
    gate.asked.length = 0
    gate.refuse.set('__local__', { code: 'exec_grant_denied' })
    expect(await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/' }, SID))).toMatchObject({ status: 403, code: 'exec_grant_denied' })
  })

  it('copies between two other hosts under both grants, and asks for both at once', async () => {
    put('macbox', 'a.bin', 'abc')
    gate.refuse.set('macbox', { code: 'exec_grant_required', letterId: 'l-1' })
    gate.refuse.set('linuxbox', { code: 'exec_grant_required', letterId: 'l-2' })
    const r = await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/a.bin', to_host: 'linuxbox', to: '~/b.bin' }, SID))
    expect(r).toMatchObject({ status: 403, code: 'exec_grant_required', data: { letterId: 'l-1', letterIds: ['l-1', 'l-2'] } })
    // Nothing was read or written on either host before the grants.
    expect([...hosts.macbox!.sent, ...hosts.linuxbox!.sent]).toEqual([])
    gate.refuse.clear()
    expect(await copyBetweenHosts({ from_host: 'macbox', from: '~/a.bin', to_host: 'linuxbox', to: '~/b.bin' }, SID)).toMatchObject({ bytes: 3 })
    expect(fs.readFileSync(path.join(hosts.linuxbox!.home, 'b.bin'), 'utf8')).toBe('abc')
  })

  it('a denied grant on one side refuses before the other side is asked', async () => {
    gate.refuse.set('macbox', { code: 'exec_grant_denied' })
    expect(await refusal(copyBetweenHosts({ from_host: 'macbox', from: '/a/b', to_host: 'linuxbox', to: '/b/c' }, SID))).toMatchObject({ status: 403, code: 'exec_grant_denied' })
    expect(gate.asked.map((a) => a.host)).toEqual(['macbox'])
  })

  it('refuses what it cannot copy, before any byte is written', async () => {
    expect(await refusal(copyBetweenHosts({ from: '~/x', to: '~/y' }, undefined))).toMatchObject({ status: 403, code: 'session_only', message: expect.stringContaining('host_copy') })
    expect(await refusal(copyBetweenHosts({ from: '~/x', to: '~/y' }, SID))).toMatchObject({ status: 400, code: 'same_host' })
    expect(await refusal(copyBetweenHosts({ from: '~/x', to_host: 'devbox', to: '~/y' }, SID))).toMatchObject({ status: 400, code: 'same_host' })
    expect(await refusal(copyBetweenHosts({ from: 'work/x', to_host: 'macbox', to: '~/y' }, SID))).toMatchObject({ status: 400, code: 'bad_request', message: expect.stringContaining('absolute') })
    expect(await refusal(copyBetweenHosts({ from: '~/x', to_host: 'macbox', to: '$WALNUT_TASK_DIR/' }, SID))).toMatchObject({ status: 400, code: 'bad_request' })
    expect(await refusal(copyBetweenHosts({ from: '~/x/../.ssh/id_rsa', to_host: 'macbox', to: '~/y' }, SID))).toMatchObject({ status: 400, code: 'bad_request', message: expect.stringContaining('..') })
    expect(await refusal(copyBetweenHosts({ from: '~/x', to_host: 'nosuch', to: '~/y' }, SID))).toMatchObject({ status: 404, code: 'unknown_host' })
    expect(await refusal(copyBetweenHosts({ from: '~/x', to_host: '@', to: '~/y' }, SID))).toMatchObject({ status: 400, code: 'bad_selector' })
    expect(await refusal(copyBetweenHosts({ from: '~/copy', to: '~/y', copy_id: 'nope' }, SID))).toMatchObject({ status: 400, code: 'bad_request' })
    // Credentials and Walnut's own data, on either side, before any grant is asked.
    expect(await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/.ssh/id_ed25519', to: '~/k' }, SID))).toMatchObject({ status: 403, code: 'protected_path' })
    expect(await refusal(copyBetweenHosts({ from: '~/grants.json', to_host: 'macbox', to: '~/.open-walnut/exec-grants.json' }, SID))).toMatchObject({ status: 403, code: 'protected_path' })
    expect(gate.asked).toEqual([])
    // The final path too: a file named open-walnut into ~/tmp/ lands in what reads as Walnut's runtime.
    put('devbox', 'x/open-walnut', 'notes')
    expect(await refusal(copyBetweenHosts({ from: '~/x/open-walnut', to_host: 'macbox', to: '~/tmp/' }, SID))).toMatchObject({ status: 403, code: 'protected_path', message: expect.stringContaining('macbox:~/tmp/open-walnut') })
    expect(await refusal(copyBetweenHosts({ from: '~/nothing-here', to_host: 'macbox', to: '~/y' }, SID))).toMatchObject({ status: 404, code: 'source_missing' })

    fs.mkdirSync(path.join(hosts.devbox!.home, 'proj', 'build out'), { recursive: true })
    const folder = await refusal(copyBetweenHosts({ from: '~/proj/build out/', to_host: 'macbox', to: '~/y/' }, SID))
    expect(folder).toMatchObject({ status: 400, code: 'is_directory' })
    expect(folder.message).toContain('tar -czf "$WALNUT_TASK_DIR/build out.tgz" -C ~/proj \'build out\'')
    expect(folder.message).toContain('your own Bash')

    // A folder of the file's name where it would land, and a file where `to/` names a folder.
    put('devbox', 'src.tgz', 'x')
    fs.mkdirSync(path.join(hosts.macbox!.home, 'in', 'src.tgz'), { recursive: true })
    expect(await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/' }, SID))).toMatchObject({ status: 409, code: 'target_is_directory' })
    put('macbox', 'plain', 'a file')
    expect(await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/plain/' }, SID))).toMatchObject({ status: 409, code: 'target_not_dir' })
    expect(await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/plain/under/x' }, SID))).toMatchObject({ status: 409, code: 'target_not_dir' })
    expect(writes('macbox')).toEqual([])
  })

  it('refuses a file over the cap from its size alone', async () => {
    const big = put('devbox', 'huge.bin', '')
    fs.truncateSync(big, MAX_COPY_BYTES + 1) // sparse: no disk used
    const r = await refusal(copyBetweenHosts({ from: '~/huge.bin', to_host: 'macbox', to: '~/huge.bin' }, SID))
    expect(r).toMatchObject({ status: 413, code: 'too_large', message: expect.stringContaining(`(${MAX_COPY_BYTES + 1} bytes); host_copy copies at most ${MAX_COPY_BYTES} bytes`) })
    expect(writes('macbox')).toEqual([])
    // Only the one-byte probe read the source.
    expect(hosts.devbox!.sent.filter((s) => s.cmd === 'fs.readRange').map((s) => s.params.length)).toEqual([1])
  })

  it('a checksum failure leaves no file and no partial file behind; a file that was there stays', async () => {
    put('devbox', 'src.tgz', crypto.randomBytes(3000))
    hosts.macbox!.knobs.corrupt = true
    const r = await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/src.tgz' }, SID))
    expect(r).toMatchObject({ status: 502, code: 'checksum_mismatch', data: { copyId: expect.stringMatching(/^hc-/) } })
    expect(r.message).toContain('Nothing was written at macbox:~/in/src.tgz')
    expect(r.data.partialLeft).toBeUndefined()
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'in', 'src.tgz'))).toBe(false)
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'in', 'src.tgz.walnut-part'))).toBe(false)

    put('macbox', 'in/src.tgz', 'old bytes')
    expect((await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/' }, SID))).code).toBe('checksum_mismatch')
    expect(fs.readFileSync(path.join(hosts.macbox!.home, 'in', 'src.tgz'), 'utf8')).toBe('old bytes')
  })

  it('names the partial file when the receiver cannot remove it', async () => {
    put('devbox', 'src.tgz', crypto.randomBytes(3000))
    hosts.macbox!.knobs.corrupt = true
    hosts.macbox!.knobs.caps = ['fs.readRange', 'fs-write-part-v1'] // an older daemon: no fs.rm
    const r = await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/src.tgz' }, SID))
    expect(r).toMatchObject({ code: 'checksum_mismatch', data: { partialLeft: '~/in/src.tgz.walnut-part' } })
    expect(r.message).toContain('The partial file ~/in/src.tgz.walnut-part may still be there; delete it with host_exec on macbox.')
  })

  it('a source that changes size while it is copied is reported, and nothing lands', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024 })
    const src = put('devbox', 'growing.log', crypto.randomBytes(4096))
    hosts.devbox!.knobs.afterRead = (p, start) => { if (p === src && start === 1024) fs.appendFileSync(src, 'more') }
    const r = await refusal(copyBetweenHosts({ from: '~/growing.log', to_host: 'macbox', to: '~/growing.log' }, SID))
    expect(r).toMatchObject({ status: 409, code: 'source_changed' })
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'growing.log'))).toBe(false)
  })

  it('an offline or older receiver is named, and nothing moves', async () => {
    put('devbox', 'src.tgz', 'x')
    hosts.macbox = null
    expect(await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'macbox', to: '~/in/' }, SID))).toMatchObject({ status: 503, code: 'host_offline', message: expect.stringContaining('not connected to macbox') })
    hosts.linuxbox!.knobs.caps = ['fs.readRange']
    const old = await refusal(copyBetweenHosts({ from: '~/src.tgz', to_host: 'linuxbox', to: '~/in/' }, SID))
    expect(old).toMatchObject({ status: 409, code: 'daemon_upgrade', message: expect.stringContaining('before it can receive files') })
    expect(old.data.partialLeft).toBeUndefined()
    expect(hosts.linuxbox!.sent.map((s) => s.cmd)).toEqual(['fs.readRange'])
  })

  it('a long copy answers running with its copyId; a second call joins it; host_copy_result waits for it', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024 })
    const body = crypto.randomBytes(20 * 1024)
    put('devbox', 'slow.bin', body)
    hosts.devbox!.knobs.readDelayMs = 60
    gate.budget = 1_300 // a relayed caller with 300 ms of hold left
    const first = await copyBetweenHosts({ from: '~/slow.bin', to_host: 'macbox', to: '~/slow.bin' }, SID)
    expect(first).toMatchObject({ running: true, copyId: expect.stringMatching(/^hc-/), from_host: 'devbox', to_host: 'macbox' })
    const joined = await copyBetweenHosts({ from: '~/slow.bin', to_host: 'macbox', to: '~/slow.bin' }, SID)
    expect(joined).toMatchObject({ copyId: first.copyId, sameCopy: true })
    // Another task never reads it.
    as('task-2')
    expect(await refusal(copyResult({ copy_id: first.copyId }, SID))).toMatchObject({ status: 404, code: 'unknown_copy' })
    as('task-1')
    gate.budget = Number.POSITIVE_INFINITY
    const t = Date.now()
    expect(await copyResult({ copy_id: first.copyId, wait_ms: 100 }, SID)).toMatchObject({ running: true })
    expect(Date.now() - t).toBeLessThan(600)
    const done = await copyResult({ copy_id: first.copyId, wait_ms: 30_000 }, SID)
    expect(done).toMatchObject({ running: false, copyId: first.copyId, bytes: body.length, sha256: sha(body) })
    // One relay: every chunk read once, after the one-byte probe.
    const reads = hosts.devbox!.sent.filter((s) => s.cmd === 'fs.readRange').map((s) => s.params.start)
    expect(reads).toEqual([0, ...Array.from({ length: 20 }, (_, i) => i * 1024)])
    expect(fs.readFileSync(path.join(hosts.macbox!.home, 'slow.bin')).equals(body)).toBe(true)
  })

  it('a caller-chosen copy_id: the same id again answers that copy, before and after it ended, and only for its task', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024 })
    put('devbox', 'a.bin', crypto.randomBytes(8 * 1024))
    hosts.devbox!.knobs.readDelayMs = 60
    gate.budget = 1_200
    const id = 'hc-0b1e5d2a-test-0001'
    const first = await copyBetweenHosts({ from: '~/a.bin', to_host: 'macbox', to: '~/a.bin', copy_id: id }, SID)
    expect(first).toMatchObject({ running: true, copyId: id })
    as('task-2')
    expect(await refusal(copyBetweenHosts({ from: '~/a.bin', to_host: 'macbox', to: '~/a.bin', copy_id: id }, SID))).toMatchObject({ status: 409, code: 'copy_id_taken' })
    as('task-1')
    gate.budget = Number.POSITIVE_INFINITY
    // A new id for the same copy while it runs joins it, and that id reads it too.
    const other = 'hc-0b1e5d2a-test-0002'
    expect(await copyBetweenHosts({ from: '~/a.bin', to_host: 'macbox', to: '~/a.bin', copy_id: other }, SID)).toMatchObject({ copyId: id, running: false, sameCopy: true })
    const reads = hosts.devbox!.sent.length
    // After it ended: the answer, never a second copy.
    expect(await copyBetweenHosts({ from: '~/a.bin', to_host: 'macbox', to: '~/a.bin', copy_id: id }, SID)).toMatchObject({ copyId: id, running: false, sameCopy: true })
    expect(await copyResult({ copy_id: other, wait_ms: 0 }, SID)).toMatchObject({ copyId: id, running: false })
    expect(hosts.devbox!.sent.length).toBe(reads)
  })

  it('one copy at a time onto one file: another source for the same target waits its turn', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024 })
    put('devbox', 'one.bin', crypto.randomBytes(8 * 1024))
    put('linuxbox', 'two.bin', 'second source')
    hosts.devbox!.knobs.readDelayMs = 60
    gate.budget = 1_200
    const a = await copyBetweenHosts({ from: '~/one.bin', to_host: 'macbox', to: '~/in/same.bin' }, SID)
    expect(a.running).toBe(true)
    // Another task, another source, the same file there (one spelled with a folder and a slash).
    as('task-2')
    const b = await refusal(copyBetweenHosts({ from_host: 'linuxbox', from: '~/two.bin', to_host: 'macbox', to: '~/in//same.bin' }, SID))
    expect(b).toMatchObject({ status: 409, code: 'target_busy' })
    expect(b.message).not.toContain(String(a.copyId))
    as('task-1')
    gate.budget = Number.POSITIVE_INFINITY
    expect(await copyResult({ copy_id: a.copyId, wait_ms: 30_000 }, SID)).toMatchObject({ running: false, bytes: 8 * 1024 })
    // The refused copy touched nothing of the first one's.
    expect(fs.readFileSync(path.join(hosts.macbox!.home, 'in', 'same.bin')).length).toBe(8 * 1024)
    as('task-2')
    expect(await copyBetweenHosts({ from_host: 'linuxbox', from: '~/two.bin', to_host: 'macbox', to: '~/in/same.bin' }, SID)).toMatchObject({ replaced: true, bytes: 13 })
  })

  it('caps a task at two copies at once, and this server at four', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024 })
    for (const n of ['a', 'b', 'c', 'd', 'e']) put('devbox', `${n}.bin`, crypto.randomBytes(8 * 1024))
    hosts.devbox!.knobs.readDelayMs = 100
    gate.budget = 1_100
    const a = await copyBetweenHosts({ from: '~/a.bin', to_host: 'macbox', to: '~/a.bin' }, SID)
    const b = await copyBetweenHosts({ from: '~/b.bin', to_host: 'macbox', to: '~/b.bin' }, SID)
    expect([a.running, b.running]).toEqual([true, true])
    expect(await refusal(copyBetweenHosts({ from: '~/c.bin', to_host: 'macbox', to: '~/c.bin' }, SID))).toMatchObject({ status: 429, code: 'busy', message: expect.stringContaining('This task') })
    as('task-2')
    await copyBetweenHosts({ from: '~/c.bin', to_host: 'macbox', to: '~/c.bin' }, SID)
    await copyBetweenHosts({ from: '~/d.bin', to_host: 'macbox', to: '~/d.bin' }, SID)
    as('task-3')
    expect(await refusal(copyBetweenHosts({ from: '~/e.bin', to_host: 'macbox', to: '~/e.bin' }, SID))).toMatchObject({ status: 429, code: 'busy', message: expect.stringContaining('Walnut already copies 4') })
    as('task-1')
    gate.budget = Number.POSITIVE_INFINITY
    await copyResult({ copy_id: a.copyId, wait_ms: 30_000 }, SID)
    as('task-3')
    expect(await copyBetweenHosts({ from: '~/e.bin', to_host: 'macbox', to: '~/e.bin' }, SID)).toMatchObject({ running: false })
  })

  it('a revoked grant stops the copy before its last part, and the revoked host is not touched again', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024, grantCheckMs: 60_000 }) // only the check before the last part
    put('devbox', 'r.bin', crypto.randomBytes(10 * 1024))
    hosts.devbox!.knobs.afterRead = (_p, start) => { if (start === 2048) revoked.add('macbox') }
    const r = await refusal(copyBetweenHosts({ from: '~/r.bin', to_host: 'macbox', to: '~/r.bin' }, SID))
    expect(r).toMatchObject({ status: 403, code: 'exec_grant_revoked', data: { partialLeft: '~/r.bin.walnut-part' } })
    // Nine parts went (the throttled check let them), the last never did.
    expect(writes('macbox').length).toBe(9)
    expect(writes('macbox').some((s) => s.params.final)).toBe(false)
    expect(hosts.macbox!.sent.some((s) => s.cmd === 'fs.rm')).toBe(false)
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'r.bin'))).toBe(false)
  })

  it('a revoked sender stops it at the next check, and the receiver\'s partial file goes', async () => {
    setHostCopyTuningForTest({ chunkBytes: 1024, grantCheckMs: 0 })
    put('macbox', 'r.bin', crypto.randomBytes(10 * 1024))
    hosts.macbox!.knobs.afterRead = (_p, start) => { if (start === 2048) revoked.add('macbox') }
    const r = await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/r.bin', to: '~/r.bin' }, SID))
    expect(r).toMatchObject({ status: 403, code: 'exec_grant_revoked' })
    expect(r.data.partialLeft).toBeUndefined()
    expect(writes('devbox').length).toBe(3)
    expect(fs.existsSync(path.join(hosts.devbox!.home, 'r.bin.walnut-part'))).toBe(false)
  })

  it('stops at its deadline', async () => {
    put('devbox', 'r.bin', crypto.randomBytes(10 * 1024))
    hosts.devbox!.knobs.readDelayMs = 100
    setHostCopyTuningForTest({ chunkBytes: 1024, deadlineMs: 250 })
    const late = await refusal(copyBetweenHosts({ from: '~/r.bin', to_host: 'macbox', to: '~/r.bin' }, SID))
    expect(late).toMatchObject({ status: 504, code: 'copy_deadline', message: expect.stringContaining('1-second deadline after') })
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'r.bin'))).toBe(false)
    expect(fs.existsSync(path.join(hosts.macbox!.home, 'r.bin.walnut-part'))).toBe(false)
  })

  it('tells a lost link from any other failure', async () => {
    const job = { fromHost: 'devbox', toHost: 'macbox', from: '~/a', to: '~/b', sent: 0, total: 10 }
    expect(await copyFailure(new Error('DaemonConnection not connected'), job)).toMatchObject({ status: 503, code: 'host_offline' })
    expect(await copyFailure(new Error('command timed out (the reply was lost)'), job)).toMatchObject({ status: 503, code: 'host_offline' })
    expect(await copyFailure(new Error('short read at 0: 1 of 2 bytes'), job)).toMatchObject({ status: 502, code: 'copy_failed' })
  })
})

describe('places macOS guards, on a Mac', () => {
  it.each([
    ['~/Downloads/app.zip', null, '~/Downloads'], ['~/Downloads', null, '~/Downloads'], ['~/Downloads/', null, '~/Downloads'],
    ['/Users/sam/Documents/a.key', null, '~/Documents'], ['/Users/sam/Library/Mail/V10/x.emlx', null, '~/Library/Mail'],
    ['/Users/sam/Library/Application Support/AddressBook/db', null, '~/Library/Application Support/AddressBook'],
    ['/Users/sam/Library/Group Containers/g/x', null, '~/Library/Group Containers'], ['~/Library/Containers/app/Data/x', null, '~/Library/Containers'],
    ['/Volumes/USB/clip.mov', null, '/Volumes'], ['~/x/Family.photoslibrary/database/Photos.sqlite', null, 'a Photos library'],
    ['/opt/me/Desktop/a.png', '/opt/me', '~/Desktop'], ['~/x/../Music/a.mp3', null, '~/Music'],
  ])('%s (home %s) is in %s', (p, home, place) => expect(macPlace(p, { home })).toBe(place))

  it.each([
    '~/build/out.tgz', '~', '~/Library/Caches/x.log', '~/Library/Application Support/Other/x', '/Users/sam/DownloadsOld/x',
    '/Users/sam/proj/Downloads/x', '/Volumes2/x', '/tmp/x', '/Users', '~/.local/state/open-walnut/tasks/t-1/src.tgz',
  ])('%s is not', (p) => expect(macPlace(p, { home: '/Users/sam' })).toBeNull())

  it('the list is host_exec\'s list (src/providers/host-exec-guards.ts)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/providers/host-exec-guards.ts'), 'utf8')
    const literal = /const PROTECTED_IN_HOME = \[([\s\S]*?)\]/.exec(src)?.[1] ?? ''
    const theirs = [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(theirs.length).toBeGreaterThan(5)
    expect([...MAC_PROTECTED_IN_HOME].sort()).toEqual([...theirs].sort())
  })

  it('refuses either side in such a place on a Mac before any grant or byte, and copies the same paths on Linux', async () => {
    systems.profiles.set('macbox', { platform: 'darwin', home: '/Users/sam' })
    systems.profiles.set('linuxbox', { platform: 'linux', home: '/home/sam' })
    put('devbox', 'out/app.zip', 'zip bytes')
    put('macbox', 'Downloads/app.zip', 'zip bytes')
    const read = await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/Downloads/app.zip', to: '~/in/' }, SID))
    expect(read).toMatchObject({ status: 409, code: 'may_prompt', data: { prompt: 'macbox:~/Downloads/app.zip' } })
    expect(read.message).toContain('host_copy would read macbox:~/Downloads/app.zip, in ~/Downloads, which macOS guards')
    expect(read.message).toContain('permission dialog on macbox\'s screen')
    expect(read.message).toContain('allow_prompts: true')
    const write = await refusal(copyBetweenHosts({ from: '~/out/app.zip', to_host: 'macbox', to: '/Volumes/USB/' }, SID))
    expect(write).toMatchObject({ status: 409, code: 'may_prompt', message: expect.stringContaining('would write macbox:/Volumes/USB/, in /Volumes') })
    // Another person's home on that Mac, by its path.
    expect((await refusal(copyBetweenHosts({ from: '~/out/app.zip', to_host: 'macbox', to: '/Users/kim/Desktop/' }, SID))).code).toBe('may_prompt')
    expect(hosts.macbox!.sent).toEqual([])
    expect(gate.asked).toEqual([])
    // The same place on a Linux host is an ordinary folder.
    expect(await copyBetweenHosts({ from: '~/out/app.zip', to_host: 'linuxbox', to: '~/Downloads/' }, SID)).toMatchObject({ to: '~/Downloads/app.zip', bytes: 9 })
  })

  it('a folder `to` whose file would land in such a place is refused before that place is read', async () => {
    systems.profiles.set('macbox', { platform: 'darwin', home: '/Users/sam' })
    put('devbox', 'x/Downloads', 'a file named Downloads')
    const r = await refusal(copyBetweenHosts({ from: '~/x/Downloads', to_host: 'macbox', to: '~/' }, SID))
    expect(r).toMatchObject({ status: 409, code: 'may_prompt', data: { prompt: 'macbox:~/Downloads' } })
    // Only the home itself was read.
    expect(hosts.macbox!.sent.map((s) => s.params.path)).toEqual(['~'])
    expect(writes('macbox')).toEqual([])
  })

  it('knows a Mac by its last preflight when its profile has no system, and this machine by its own', async () => {
    systems.preflight.set('linuxbox', { platform: 'darwin' })
    expect((await refusal(copyBetweenHosts({ from_host: 'linuxbox', from: '~/Movies/demo.mov', to: '~/in/' }, SID))).code).toBe('may_prompt')
    gate.rawHost = undefined
    gate.caller = { ...gate.caller, host: '__local__' }
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...real, value: 'darwin' })
    try {
      const own = await refusal(copyBetweenHosts({ from: '~/Desktop/shot.png', to_host: 'macbox', to: '~/in/' }, SID))
      expect(own).toMatchObject({ status: 409, code: 'may_prompt', data: { prompt: '__local__:~/Desktop/shot.png' } })
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
    expect(gate.asked).toEqual([])
  })

  it('with allow_prompts it copies there, and a read that gets no answer is the dialog, not a lost host', async () => {
    systems.profiles.set('macbox', { platform: 'darwin', home: hosts.macbox!.home })
    put('macbox', 'Downloads/app.zip', 'zip bytes')
    expect(await copyBetweenHosts({ from_host: 'macbox', from: '~/Downloads/app.zip', to: '~/in/', allow_prompts: true }, SID)).toMatchObject({ to: '~/in/app.zip', bytes: 9 })
    put('devbox', 'out/report.pdf', 'pdf bytes')
    // The final path counts too: a folder `to` on the Mac that holds the file in such a place.
    expect(await copyBetweenHosts({ from: '~/out/report.pdf', to_host: 'macbox', to: '~/Documents/', allow_prompts: true }, SID)).toMatchObject({ to: '~/Documents/report.pdf' })

    hosts.macbox!.knobs.hangs = (cmd, p) => cmd === 'fs.readRange' && p.includes('/Downloads/')
    const waited = await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/Downloads/app.zip', to: '~/in/again.zip', allow_prompts: true }, SID))
    expect(waited).toMatchObject({ status: 504, code: 'prompt_timeout', data: { prompt: 'macbox:~/Downloads/app.zip' } })
    expect(waited.message).toContain('macOS is most likely showing a permission dialog for it on macbox\'s screen')
    expect(waited.message).toContain('Nothing was written at devbox:~/in/again.zip')
    // A path in no guarded place that gets no answer is still the host away.
    hosts.macbox!.knobs.hangs = (cmd, p) => cmd === 'fs.readRange' && p.includes('/build/')
    put('macbox', 'build/out.tgz', 'tgz')
    expect(await refusal(copyBetweenHosts({ from_host: 'macbox', from: '~/build/out.tgz', to: '~/in/', allow_prompts: true }, SID))).toMatchObject({ status: 503, code: 'host_offline' })
    const job = { fromHost: 'macbox', toHost: 'devbox', from: '~/Downloads/a', to: '~/b', sent: 0, total: null, dialog: { host: 'macbox', path: '~/Downloads/a' } }
    expect(await copyFailure(new Error('daemon command timeout: fs.writePart (60000ms)'), job)).toMatchObject({ status: 504, code: 'prompt_timeout' })
    expect(await copyFailure(new Error('short read at 0'), job)).toMatchObject({ status: 502, code: 'copy_failed' })
  })
})

describe('the CLI picks the copy_id (host-exec-run-id.ts)', () => {
  it('picks hc-<uuid> for host_copy, keeps one the caller gave, and its lost and away lines name the copy', () => {
    const args: Record<string, unknown> = { from: '~/a', to_host: 'macbox', to: '~/b' }
    expect(callerRunId('host_copy', args, () => 'abcd-1234')).toBe('hc-abcd-1234')
    expect(args.copy_id).toBe('hc-abcd-1234')
    expect(callerRunId('host_copy', { copy_id: 'hc-mine-0001' })).toBe('hc-mine-0001')
    expect(callerRunId('host_copy_result', { copy_id: 'hc-x' })).toBeNull()
    expect(lostRunLines('host_copy', args, 'hc-abcd-1234')).toEqual([
      'walnut: host_copy may have started as copy hc-abcd-1234: do not start it again. Read it first:',
      `  walnut tools call host_copy_result '{"copy_id":"hc-abcd-1234","wait_ms":10000}'`,
      'walnut: (if that read says unknown_copy, the copy never reached the Walnut server: call host_copy again)',
    ])
    expect(awayLines('host_copy', args)).toEqual(['walnut: host_copy did not reach the Walnut server, so nothing was copied; call it again once the server answers.'])
    // A server whose host_copy has no copy_id yet refuses it before anything runs.
    const old = { name: 'host_copy', input: { from: z.string(), to: z.string(), to_host: z.string().optional() } } as unknown as WalnutOp
    const parsed = parseOpArgs(old, { from: '~/a', to: '~/b', copy_id: 'hc-1234' })
    expect(parsed.ok).toBe(false)
    expect(refusedRunId('host_copy', (parsed as { message: string }).message)).toBe(true)
  })
})
