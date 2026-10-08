/**
 * ssh-control-master: which socket a host's master lives on, and when a master
 * found there may be used.
 *
 * MACHINE SAFETY: no ssh at all. The runner is a stub that records its argv;
 * sockets are real unix sockets this test listens on and closes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  cancelRecordedForwards, controlSocketPath, forwardsFile, MASTER_PATIENT_VERIFY_TIMEOUT_MS, planControlMaster,
  probeControlMaster, recordForward, removeStaleMaster, startControlMaster, type SshRunner,
} from '../../src/providers/ssh-control-master.js'
import type { SshRun } from '../../src/providers/remote-sh.js'

const HOME = '/Users/someone/.open-walnut'
const T = { hostKey: 'devbox', target: 'tester@devbox.example.com:', home: HOME }
const ok: SshRun = { stdout: '', stderr: '', code: 0, timedOut: false }
const fail: SshRun = { stdout: '', stderr: 'Control socket connect: Connection refused', code: 255, timedOut: false }

const slow: SshRun = { stdout: '', stderr: '', code: null, timedOut: true }

function runner(answers: Array<SshRun | ((argv: string[]) => SshRun)>): { run: SshRunner; seen: string[][]; budgets: number[] } {
  const seen: string[][] = []
  const budgets: number[] = []
  const run: SshRunner = async (argv, opts) => {
    seen.push(argv)
    budgets.push(opts.timeoutMs)
    const next = answers.shift() ?? fail
    return typeof next === 'function' ? next(argv) : next
  }
  return { run, seen, budgets }
}

const dirs: string[] = []
const servers: net.Server[] = []
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wscm-'))
  dirs.push(d)
  return d
}
async function listen(sock: string): Promise<void> {
  const srv = net.createServer((s) => s.end())
  servers.push(srv)
  await new Promise<void>((r) => srv.listen(sock, () => r()))
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('controlSocketPath', () => {
  it('is the same in every process of one data dir and one target', () => {
    expect(controlSocketPath(T, '/tmp/x')).toBe(controlSocketPath({ ...T }, '/tmp/x'))
    expect(path.basename(controlSocketPath(T, '/tmp/x'))).toMatch(/^walnut-ssh-devbox-[0-9a-f]{12}$/)
  })

  it('differs for another data dir (a test server) and for another machine behind the same alias', () => {
    const base = controlSocketPath(T, '/tmp/x')
    expect(controlSocketPath({ ...T, home: '/var/folders/t/walnut-ephemeral-1' }, '/tmp/x')).not.toBe(base)
    expect(controlSocketPath({ ...T, target: 'tester@other.example.com:' }, '/tmp/x')).not.toBe(base)
    expect(controlSocketPath({ ...T, target: 'tester@devbox.example.com:2222' }, '/tmp/x')).not.toBe(base)
  })

  it('stays inside the unix socket limit for a long alias and a long tmp dir, and carries no ssh % tokens', () => {
    const dir = `/var/folders/ph/${'q'.repeat(30)}/T`
    const p = controlSocketPath({ ...T, hostKey: `very-long-alias-%h-%p-${'x'.repeat(80)}` }, dir)
    expect(p.length).toBeLessThanOrEqual(100)
    expect(p).not.toContain('%')
    expect(p.startsWith(`${dir}/walnut-ssh-very-long-alias-_h-_p-`)).toBe(true)
  })
})

describe('probeControlMaster', () => {
  it('absent when nothing is there, without running ssh', async () => {
    const { run, seen } = runner([])
    expect(await probeControlMaster(path.join(tmp(), 's'), [], 'h', { run })).toBe('absent')
    expect(seen).toEqual([])
  })

  it('foreign for a plain file, and for a socket another user made: never asked, never removed', async () => {
    const d = tmp()
    const file = path.join(d, 'f')
    fs.writeFileSync(file, '')
    const sock = path.join(d, 's')
    await listen(sock)
    const { run, seen } = runner([ok, ok])
    expect(await probeControlMaster(file, [], 'h', { run })).toBe('foreign')
    expect(await probeControlMaster(sock, [], 'h', { run, uid: (process.getuid?.() ?? 0) + 1 })).toBe('foreign')
    expect(seen).toEqual([])
    expect(fs.existsSync(file) && fs.existsSync(sock)).toBe(true)
  })

  it('live only when the master answers and a command through it comes back', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const { run, seen } = runner([ok, ok])
    expect(await probeControlMaster(sock, ['-p', '22'], 'u@h', { run })).toBe('live')
    expect(seen[0]).toEqual(['-p', '22', '-o', `ControlPath=${sock}`, '-O', 'check', 'u@h'])
    expect(seen[1]).toEqual(['-p', '22', '-o', `ControlPath=${sock}`, '-o', 'ControlMaster=no', 'u@h', 'true'])
  })

  it('stale when the master refuses, or its link refuses the command', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    expect(await probeControlMaster(sock, [], 'h', runner([fail]))).toBe('stale')
    expect(await probeControlMaster(sock, [], 'h', runner([ok, fail]))).toBe('stale')
  })

  it('unanswered, not stale, when the check or the command only ran out of time', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    expect(await probeControlMaster(sock, [], 'h', runner([slow]))).toBe('unanswered')
    expect(await probeControlMaster(sock, [], 'h', runner([ok, slow]))).toBe('unanswered')
  })
})

describe('planControlMaster: a master is ended only when it is dead, or when a new login replaces it', () => {
  const isExit = (argv: string[]) => argv.includes('-O') && argv[argv.indexOf('-O') + 1] === 'exit'
  const isFreshLogin = (argv: string[]) => argv.includes('ControlPath=none')

  it('reuses a live master', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const { run, seen } = runner([ok, ok])
    expect(await planControlMaster(sock, [], 'h', { run })).toEqual({ action: 'reuse', state: 'live' })
    expect(seen.some(isExit)).toBe(false)
  })

  it('starts one where none is, and ends a dead one first', async () => {
    expect(await planControlMaster(path.join(tmp(), 's'), [], 'h', runner([]))).toEqual({ action: 'start', state: 'absent' })
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const { run, seen } = runner([fail, ok])
    expect(await planControlMaster(sock, [], 'h', { run })).toEqual({ action: 'start', state: 'stale', replaced: 'stale' })
    expect(seen.some(isExit)).toBe(true)
    expect(fs.existsSync(sock)).toBe(false)
  })

  it('replaces a master that did not answer when a new login works (a dead link after sleep)', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const { run, seen } = runner([ok, slow, ok, ok])
    expect(await planControlMaster(sock, ['-o', 'BatchMode=yes'], 'u@h', { run })).toEqual({ action: 'start', state: 'unanswered', replaced: 'unanswered' })
    expect(seen[2]).toEqual(['-o', 'BatchMode=yes', '-o', 'ControlPath=none', '-o', 'ControlMaster=no', 'u@h', 'true'])
    expect(seen.some(isExit)).toBe(true)
  })

  it('keeps a master that only answered late when no new login works (the expired-credential case)', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const denied: SshRun = { ...fail, stderr: 'u@h: Permission denied (publickey).' }
    const { run, seen, budgets } = runner([ok, slow, denied, ok, ok])
    expect(await planControlMaster(sock, [], 'u@h', { run })).toEqual({ action: 'reuse', state: 'unanswered', patient: true })
    expect(seen.some(isFreshLogin)).toBe(true)
    expect(seen.some(isExit)).toBe(false)
    expect(budgets.at(-1)).toBe(MASTER_PATIENT_VERIFY_TIMEOUT_MS)
    expect(fs.existsSync(sock)).toBe(true)
  })

  it('keeps it and connects without it when it still does not answer, so the next connect can try again', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const { run, seen } = runner([ok, slow, fail, ok, slow])
    expect(await planControlMaster(sock, [], 'h', { run })).toEqual({ action: 'fallback', state: 'unanswered', reason: 'unanswered' })
    expect(seen.some(isExit)).toBe(false)
    expect(fs.existsSync(sock)).toBe(true)
  })

  it('ends it after all when the second look finds its link dead, and starts over when it is gone', async () => {
    const sock = path.join(tmp(), 's')
    await listen(sock)
    const dead = runner([ok, slow, fail, ok, fail, ok])
    expect(await planControlMaster(sock, [], 'h', { run: dead.run })).toEqual({ action: 'start', state: 'unanswered', replaced: 'stale' })
    expect(dead.seen.some(isExit)).toBe(true)

    const sock2 = path.join(tmp(), 's')
    await listen(sock2)
    const gone = runner([ok, slow, () => { fs.rmSync(sock2, { force: true }); return fail }])
    expect(await planControlMaster(sock2, [], 'h', { run: gone.run })).toEqual({ action: 'start', state: 'unanswered' })
    expect(gone.seen.some(isExit)).toBe(false)
  })
})

describe('starting, ending and forwards', () => {
  it('a start that cannot log in throws with ssh\'s own words, for the credential classifier', async () => {
    const sock = path.join(tmp(), 's')
    const { run, seen } = runner([{ ...fail, stderr: 'tester@devbox: Permission denied (publickey).' }])
    await expect(startControlMaster(sock, ['-o', 'BatchMode=yes'], 'tester@devbox', { run })).rejects.toThrow(/Permission denied \(publickey\)/)
    expect(seen[0]).toEqual(expect.arrayContaining(['-o', `ControlPath=${sock}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=300', '-fN', 'tester@devbox']))
  })

  it('a fresh master drops a forward list left by an older one', async () => {
    const sock = path.join(tmp(), 's')
    recordForward(sock, '1:127.0.0.1:2')
    await startControlMaster(sock, [], 'h', runner([ok]))
    expect(fs.existsSync(forwardsFile(sock))).toBe(false)
  })

  it('recorded forwards are cancelled once each, then forgotten', async () => {
    const sock = path.join(tmp(), 's')
    recordForward(sock, '51234:127.0.0.1:39829')
    recordForward(sock, '51235:127.0.0.1:8080')
    recordForward(sock, '51234:127.0.0.1:39829')
    const { run, seen } = runner([ok, ok])
    expect(await cancelRecordedForwards(sock, [], 'h', { run })).toEqual(['51234:127.0.0.1:39829', '51235:127.0.0.1:8080'])
    expect(seen.map((a) => a.slice(-4))).toEqual([['cancel', '-L', '51234:127.0.0.1:39829', 'h'], ['cancel', '-L', '51235:127.0.0.1:8080', 'h']])
    expect(fs.existsSync(forwardsFile(sock))).toBe(false)
    expect(await cancelRecordedForwards(sock, [], 'h', runner([]))).toEqual([])
  })

  it('a stale master is asked to exit, then its socket and forward list are removed', async () => {
    const d = tmp()
    const sock = path.join(d, 's')
    await listen(sock)
    recordForward(sock, '1:127.0.0.1:2')
    const { run, seen } = runner([fail])
    await removeStaleMaster(sock, [], 'h', { run })
    expect(seen[0].slice(-3)).toEqual(['-O', 'exit', 'h'])
    expect(fs.existsSync(sock)).toBe(false)
    expect(fs.existsSync(forwardsFile(sock))).toBe(false)
  })
})
