/**
 * Removing an ephemeral server's runtime dir ends the dtach masters of its
 * terminals (2026-09-29: three were found five days after their servers were
 * gone), and only those: each is the pid its record names, or its socket's
 * owner, proved by start time and argv. The old `pkill -f " -A <dir>/term/walnut-"`
 * also signalled any process that only named the dir.
 *
 * Real masters from Walnut's own dtach build, in a private short dir under /tmp
 * (a unix socket path stays under 104 bytes on macOS); every process here is
 * started by this file and ended through the code under test or its own handle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-eph-dtach'))

import { localDtachPath } from '../../src/web/terminal/dtach-provision.js'
import { dtachPidFileFor, dtachRecordScript, localShellRunner, stopDtachMaster } from '../../src/web/terminal/dtach-master.js'
import { removeEphemeralRuntimeDirs, endDtachMastersUnder } from '../../src/commands/ephemeral-registry.js'

let dtachBin = ''
let root = ''
const sockets: string[] = []

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null

function running(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (err, out) => resolve(!err && !!out.trim() && !out.trim().startsWith('Z'))))
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** A detached master on `sock`; with `record` its shell starts through the pid record (spawn.ts), else as an older Walnut's did. */
async function startMaster(sock: string, record: boolean): Promise<number | null> {
  fs.mkdirSync(path.dirname(sock), { recursive: true })
  const cmd = record ? ['/bin/sh', '-c', dtachRecordScript(dtachPidFileFor(sock)), '/bin/sh'] : ['/bin/sh', '-l']
  const launcher = spawn(dtachBin, ['-n', sock, '-z', ...cmd], { stdio: 'ignore' })
  sockets.push(sock)
  await new Promise((r) => launcher.once('exit', r))
  await until(`socket ${sock}`, () => fs.existsSync(sock))
  if (!record) return null
  await until('pid record', () => fs.existsSync(dtachPidFileFor(sock)))
  return Number(fs.readFileSync(dtachPidFileFor(sock), 'utf8').split('\n')[0])
}

/** Is a master still holding `sock`? Read through the guard's own probe (lsof owner, proved). */
async function heldBy(sock: string): Promise<number[]> {
  const { dtachProbeScript, parseDtachProbe, chooseDtachMaster } = await import('../../src/web/terminal/dtach-master.js')
  return chooseDtachMaster(parseDtachProbe((await localShellRunner(dtachProbeScript(sock))).stdout), sock).targets.map((t) => t.pid)
}

beforeAll(async () => {
  dtachBin = await localDtachPath()
  root = fs.mkdtempSync('/tmp/wdx-')
}, 120_000)

afterAll(async () => {
  for (const sock of sockets) if (fs.existsSync(sock)) await stopDtachMaster(localShellRunner, sock).catch(() => {})
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('an ephemeral runtime dir takes its terminal masters with it', () => {
  it('ends its recorded and its older masters, never a sibling dir\'s master or a process naming its sockets', async () => {
    const mine = path.join(root, 'open-walnut-eph-7-DtAch1')
    const sibling = path.join(root, 'open-walnut-eph-7-DtAch2')
    const prodLike = path.join(root, 'open-walnut')
    const recorded = await startMaster(path.join(mine, 'term', 'walnut-a.dsock'), true)
    await startMaster(path.join(mine, 'term', 'walnut-b.dsock'), false)
    const [older] = await heldBy(path.join(mine, 'term', 'walnut-b.dsock'))
    const siblingMaster = await startMaster(path.join(sibling, 'term', 'walnut-a.dsock'), true)
    const prodMaster = await startMaster(path.join(prodLike, 'term', 'walnut-a.dsock'), true)
    expect([recorded, older, siblingMaster, prodMaster].every((p) => typeof p === 'number' && p > 1)).toBe(true)
    // Each of these matched the old pattern ` -A <mine>/term/walnut-`.
    const lookalike = spawn('/bin/sh', ['-c', 'sleep 20; exit 0', 'sh', '-A', path.join(mine, 'term', 'walnut-a.dsock')], { stdio: 'ignore' })
    const lister = spawn('/bin/sh', ['-c', `ls ${path.join(mine, 'term')}/walnut-* >/dev/null; sleep 20; exit 0`], { stdio: 'ignore' })
    try {
      await sleep(200)
      await removeEphemeralRuntimeDirs(prodLike) // not a runtime dir shape: untouched
      await removeEphemeralRuntimeDirs(mine)
      await until('both masters to exit', async () => !(await running(recorded!)) && !(await running(older!)))
      expect(fs.existsSync(mine)).toBe(false)
      expect(fs.existsSync(prodLike)).toBe(true)
      await sleep(200)
      expect([alive(lookalike), alive(lister)]).toEqual([true, true])
      expect([await running(siblingMaster!), await running(prodMaster!)]).toEqual([true, true])
      // The sibling's own removal ends its master the same way.
      await endDtachMastersUnder(sibling)
      await until('the sibling master to exit', async () => !(await running(siblingMaster!)))
      expect(await running(prodMaster!)).toBe(true)
    } finally {
      for (const c of [lookalike, lister]) if (alive(c)) c.kill('SIGKILL')
    }
  }, 60_000)
})
