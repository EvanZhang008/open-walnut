/**
 * One CLI per session id on a host (src/providers/cli-owner-core.ts): the owner
 * record and the process-table check, against a real temp directory and a
 * scripted process table. No process is spawned or signalled.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCliOwner, type CliOwnerDeps, type CliOwnerHolder } from '../../src/providers/cli-owner-core.js'
import { heldByAnotherProcess, holderKindOf, holderPidOf } from '../../src/providers/delivery-failure.js'

interface Proc { startTime: string; args: string; home?: string | null; configDir?: string; pgid?: number }

let root = ''
let procs: Map<number, Proc>
let clock = 1_000_000
let psDown = false
let logs: Array<{ level: string; msg: string }>

const HOME = '/home/u'
const SID = 'aaaaaaaa-1111-4111-8111-111111111111'

function owner(instance: string, pid: number, extra: Partial<CliOwnerDeps> = {}) {
  let n = 0
  return createCliOwner({
    fs, path,
    dir: path.join(root, 'cli-owners'),
    configDir: path.join(HOME, '.claude'),
    platform: 'darwin',
    self: { pid, startTime: procs.get(pid)?.startTime ?? null, instance },
    now: () => clock,
    log: (level, msg) => { logs.push({ level, msg }) },
    isAlive: (p) => procs.has(p),
    startTimeOf: async (p) => procs.get(p)?.startTime ?? null,
    exec: async (file, args) => {
      if (psDown || file !== 'ps') return null
      if (args[0] === '-A') return [...procs].map(([p, x]) => `${String(p).padStart(6)} ${String(x.pgid ?? p).padStart(6)} ${x.args}`).join('\n') + '\n'
      const p = Number(args[args.length - 1])
      const x = procs.get(p)
      if (!x) return ''
      if (args[0] === '-ww') return x.args + '\n'
      if (x.home === null) return x.args + '\n'
      return `${x.args} PATH=/usr/bin HOME=${x.home ?? HOME}${x.configDir ? ` CLAUDE_CONFIG_DIR=${x.configDir}` : ''}\n`
    },
    nonce: () => `${instance}-${++n}-${Math.random().toString(16).slice(2)}`,
    ...extra,
  })
}

const cliArgs = (sid: string, more = '') => `claude -p --output-format stream-json --resume ${sid} --append-system-prompt You are HOME=/x${more}`

async function refusal(p: Promise<unknown>): Promise<CliOwnerHolder & { code: string }> {
  try { await p } catch (err) {
    const e = err as Error & { code?: string; holder?: CliOwnerHolder }
    expect(e.code).toBe('SESSION_LIVE')
    return { ...(e.holder as CliOwnerHolder), code: e.code! }
  }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-owner-')))
  procs = new Map([[100, { startTime: 'daemon-a', args: 'daemon --start' }], [200, { startTime: 'daemon-b', args: 'daemon --start' }]])
  clock = 1_000_000
  psDown = false
  logs = []
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe('transcriptIdOf', () => {
  it('names the transcript a resume or a named start writes, and none for a fork or an unnamed start', () => {
    const o = owner('a', 100)
    expect(o.transcriptIdOf(['claude', '-p', '--resume', SID])).toBe(SID)
    expect(o.transcriptIdOf(['claude', '--session-id', SID])).toBe(SID)
    expect(o.transcriptIdOf(['claude', '--resume', SID, '--fork-session'])).toBeNull()
    expect(o.transcriptIdOf(['claude', '-p'])).toBeNull()
    expect(o.transcriptIdOf(['claude', '--resume', '../etc'])).toBeNull()
  })
})

describe('claim', () => {
  it('a committed CLI refuses a second daemon, and names who holds it', async () => {
    const a = owner('a', 100)
    const b = owner('b', 200)
    const claim = await a.claim(SID, { home: '/walnut/prod' })
    procs.set(300, { startTime: 'cli-1', args: cliArgs(SID) })
    claim.commit(300, 'cli-1')
    const held = await refusal(b.claim(SID))
    expect(held).toMatchObject({ kind: 'live', pid: 300, instance: 'a', home: '/walnut/prod', self: false })
    // The same daemon is refused too: its registry is the place to route, not a respawn.
    expect(await refusal(a.claim(SID))).toMatchObject({ kind: 'live', pid: 300, self: true })
  })

  it('of two daemons claiming at once, exactly one wins (20 rounds)', async () => {
    for (let i = 0; i < 20; i++) {
      const sid = `bbbbbbbb-1111-4111-8111-${String(i).padStart(12, '0')}`
      const results = await Promise.allSettled([owner('a', 100).claim(sid), owner('b', 200).claim(sid)])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      expect(lost.reason.code).toBe('SESSION_LIVE')
      expect(lost.reason.holder.kind).toBe('starting')
    }
  })

  it('a CLI that exited, or a reused pid, leaves a stale record the next claim breaks', async () => {
    const a = owner('a', 100)
    const b = owner('b', 200)
    ;(await a.claim(SID)).commit(300, 'cli-1')
    procs.set(300, { startTime: 'cli-1', args: cliArgs(SID) })
    await refusal(b.claim(SID))
    procs.delete(300) // it ended on its own
    const again = await b.claim(SID)
    procs.set(301, { startTime: 'cli-2', args: cliArgs(SID) })
    again.commit(301, 'cli-2')
    procs.delete(301)
    procs.set(301, { startTime: 'someone-else', args: 'vim notes.txt' }) // the kernel reused the pid
    await expect(a.claim(SID)).resolves.toBeTruthy()
  })

  it('a record with no start time is told apart from a reused pid by what the pid runs', async () => {
    const a = owner('a', 100)
    ;(await a.claim(SID)).commit(300, null)
    procs.set(300, { startTime: 'x', args: cliArgs(SID) })
    await refusal(owner('b', 200).claim(SID))
    procs.set(300, { startTime: 'y', args: 'node build.js' })
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
  })

  it('a claim in flight refuses while its daemon lives and is young; a dead or expired one is broken', async () => {
    await owner('a', 100).claim(SID)
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ kind: 'starting', pid: 100 })
    clock += 121_000
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()

    const sid2 = 'cccccccc-1111-4111-8111-111111111111'
    await owner('a', 100).claim(sid2)
    procs.delete(100) // that daemon died mid-spawn
    await expect(owner('b', 200).claim(sid2)).resolves.toBeTruthy()
  })

  it('a released claim (spawn failed) frees the sid at once', async () => {
    const c = await owner('a', 100).claim(SID)
    c.release()
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
  })

  it('release never removes a record that is no longer its own', async () => {
    const c = await owner('a', 100).claim(SID)
    clock += 121_000
    const d = await owner('b', 200).claim(SID) // broke the expired one
    c.release()
    procs.set(301, { startTime: 'cli', args: cliArgs(SID) })
    d.commit(301, 'cli')
    expect(await refusal(owner('a', 100).claim(SID))).toMatchObject({ pid: 301, instance: 'b' })
  })

  it('this daemon replacing its own CLI takes the record over (exceptPid)', async () => {
    const a = owner('a', 100)
    ;(await a.claim(SID)).commit(300, 'cli-1')
    procs.set(300, { startTime: 'cli-1', args: cliArgs(SID) })
    await expect(a.claim(SID, { exceptPid: 300 })).resolves.toBeTruthy()
    // A restarted daemon replacing the CLI it adopted takes over a record an older
    // instance wrote (its registry is the proof it owns that pid).
    const sid2 = 'dddddddd-1111-4111-8111-111111111111'
    ;(await a.claim(sid2)).commit(302, 'cli-3')
    procs.set(302, { startTime: 'cli-3', args: cliArgs(sid2) })
    procs.set(500, { startTime: 'daemon-a2', args: 'daemon --start' })
    await expect(owner('a2', 500).claim(sid2, { exceptPid: 302 })).resolves.toBeTruthy()
    // Without that pid in hand it is refused like anyone else.
    const sid3 = 'dddddddd-2222-4222-8222-222222222222'
    ;(await a.claim(sid3)).commit(303, 'cli-4')
    procs.set(303, { startTime: 'cli-4', args: cliArgs(sid3) })
    await refusal(owner('a2', 500).claim(sid3))
  })

  it('records that cannot be written leave the process table to decide, and never block a start', async () => {
    const blocked = path.join(root, 'not-a-dir')
    fs.writeFileSync(blocked, 'x')
    const o = owner('a', 100, { dir: blocked })
    await expect(o.claim(SID)).resolves.toBeTruthy()
    expect(logs.some((l) => /records unavailable/.test(l.msg))).toBe(true)
    procs.set(300, { startTime: 's', args: cliArgs(SID) })
    expect(await refusal(o.claim(SID))).toMatchObject({ pid: 300, unrecorded: true })
  })

  it('a claim moved aside while it scanned is not taken as won: it claims afresh', async () => {
    let scans = 0
    const dir = path.join(root, 'cli-owners')
    const files = () => fs.readdirSync(dir).flatMap((sub) => fs.readdirSync(path.join(dir, sub)).map((f) => path.join(dir, sub, f)))
    const a = owner('a', 100, {
      exec: async (_file, args) => {
        // Someone breaks the first claim during its scan.
        if (args[0] === '-A' && ++scans === 1) for (const f of files()) fs.unlinkSync(f)
        return args[0] === '-A' ? '' : null
      },
    })
    const c = await a.claim(SID)
    expect(scans).toBe(2)
    c.commit(300, 'cli')
    procs.set(300, { startTime: 'cli', args: cliArgs(SID) })
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 300, instance: 'a' })
  })

  it('a torn record is waited for while young and broken once old', async () => {
    const dir = path.join(root, 'cli-owners')
    await owner('a', 100).claim('eeeeeeee-1111-4111-8111-111111111111') // creates the records dir
    const sub = fs.readdirSync(dir)[0]
    const file = path.join(dir, sub, SID + '.json')
    fs.writeFileSync(file, '')
    const fresh = Date.now()
    clock = fresh
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ kind: 'starting' })
    clock = fresh + 11_000
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
  })
})

describe('the process table check', () => {
  it('a live CLI no record names refuses (an older daemon\'s, a lost record, a hand-run resume)', async () => {
    procs.set(400, { startTime: 's', args: cliArgs(SID) })
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ kind: 'live', pid: 400, unrecorded: true })
    // The refused claim was given back.
    procs.delete(400)
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
  })

  it('a CLI of another transcript store, a fork, or the replaced pid does not count', async () => {
    procs.set(401, { startTime: 's', args: cliArgs(SID), home: '/tmp/test-home' })
    procs.set(402, { startTime: 's', args: cliArgs(SID), configDir: '/elsewhere/.claude' })
    procs.set(403, { startTime: 's', args: cliArgs(SID, ' --fork-session') })
    procs.set(404, { startTime: 's', args: `grep --resume ${SID}` })
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
    // A CLI run through node in print mode counts though nothing names it claude.
    const sidN = '12345678-1111-4111-8111-111111111111'
    procs.set(408, { startTime: 's', args: `node /opt/cli/cli.js -p --resume ${sidN}` })
    expect(await refusal(owner('b', 200).claim(sidN))).toMatchObject({ pid: 408 })
    const sid2 = 'ffffffff-1111-4111-8111-111111111111'
    procs.set(405, { startTime: 's', args: cliArgs(sid2) })
    await expect(owner('b', 200).claim(sid2, { exceptPid: 405 })).resolves.toBeTruthy()
  })

  it('a CLI is a process tree: its members count once, by group, and the replaced group is left out', async () => {
    // A launcher shim, its node and the binary, all naming the sid, in the shim's group.
    procs.set(600, { startTime: 's', args: cliArgs(SID) })
    procs.set(601, { startTime: 's', args: `/opt/claude-code/bin/claude -p --resume ${SID}`, pgid: 600 })
    procs.set(602, { startTime: 's', args: `/opt/claude-code/claude --settings {} -p --resume ${SID}`, pgid: 600 })
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 600, unrecorded: true })
    // The daemon replacing that CLI: the shim is the excepted pid, and its children go with it.
    await expect(owner('b', 200).claim(SID, { exceptPid: 600 })).resolves.toBeTruthy()
  })

  it('a symlinked config dir is the same store', async () => {
    const realDir = path.join(root, 'real-claude')
    fs.mkdirSync(realDir)
    fs.symlinkSync(realDir, path.join(root, 'link-claude'))
    procs.set(409, { startTime: 's', args: cliArgs(SID), configDir: path.join(root, 'link-claude') })
    expect(await refusal(owner('b', 200, { configDir: realDir }).claim(SID))).toMatchObject({ pid: 409 })
  })

  it('an env that cannot be read counts as this store', async () => {
    procs.set(406, { startTime: 's', args: cliArgs(SID), home: null })
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 406, unrecorded: true })
  })

  it('a process table that cannot be read leaves the record check alone, and says so', async () => {
    psDown = true
    await expect(owner('b', 200).claim(SID)).resolves.toBeTruthy()
    expect(logs.some((l) => l.level === 'warn' && /process table unreadable/.test(l.msg))).toBe(true)
  })

  it('reads the env on linux from /proc', async () => {
    const o = owner('b', 200, { platform: 'linux' })
    // /proc/<pid>/environ of a scripted pid does not exist: unreadable, so it counts.
    procs.set(407, { startTime: 's', args: cliArgs(SID) })
    expect(await refusal(o.claim(SID))).toMatchObject({ pid: 407 })
  })
})

describe('adopt and prune', () => {
  it('adopt records a proven CLI, keeps its own, and never overwrites another live holder', async () => {
    const a = owner('a', 100)
    procs.set(300, { startTime: 'cli-1', args: cliArgs(SID) })
    expect(await a.adopt(SID, 300, 'cli-1', '/walnut/prod')).toBe('written')
    expect(await a.adopt(SID, 300, 'cli-1')).toBe('kept')
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 300, home: '/walnut/prod' })
    procs.set(301, { startTime: 'cli-2', args: cliArgs(SID) })
    expect(await owner('b', 200).adopt(SID, 301, 'cli-2')).toBe('conflict')
    // A restarted daemon takes over the record of the CLI it adopted.
    procs.set(500, { startTime: 'daemon-a2', args: 'daemon --start' })
    expect(await owner('a2', 500).adopt(SID, 300, 'cli-1')).toBe('written')
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 300, instance: 'a2', home: '/walnut/prod' })
  })

  it('prune removes the records of CLIs that are gone and keeps live ones', async () => {
    const a = owner('a', 100)
    ;(await a.claim(SID)).commit(300, 'cli-1')
    procs.set(300, { startTime: 'cli-1', args: cliArgs(SID) })
    const sid2 = '99999999-1111-4111-8111-111111111111'
    ;(await a.claim(sid2)).commit(301, 'gone')
    expect(a.prune()).toBe(1)
    expect(await refusal(owner('b', 200).claim(SID))).toMatchObject({ pid: 300 })
  })
})

// The server reads this refusal's words (delivery-failure.ts): a change to them here
// must not quietly turn a held session back into a retry loop (2026-10-28).
describe('the refusal as the server reads it', () => {
  async function refusalText(p: Promise<unknown>): Promise<string> {
    try { await p } catch (err) { return (err as Error).message }
    throw new Error('expected a refusal')
  }

  it('a terminal\'s claude -r is held by another process, named a terminal, with its pid', async () => {
    procs.set(300, { startTime: 's', args: cliArgs(SID) })
    const text = await refusalText(owner('a', 100).claim(SID))
    expect(heldByAnotherProcess(text)).toBe(true)
    expect(holderKindOf(text)).toBe('terminal')
    expect(holderPidOf(text)).toBe(300)
  })

  it('another daemon\'s CLI is another Walnut; this daemon\'s own CLI is not held elsewhere', async () => {
    const a = owner('a', 100)
    ;(await a.claim(SID)).commit(303, 'cli-4')
    procs.set(303, { startTime: 'cli-4', args: cliArgs(SID) })
    const other = await refusalText(owner('b', 200).claim(SID))
    expect(heldByAnotherProcess(other)).toBe(true)
    expect(holderKindOf(other)).toBe('walnut')
    expect(heldByAnotherProcess(await refusalText(a.claim(SID)))).toBe(false)
  })
})
