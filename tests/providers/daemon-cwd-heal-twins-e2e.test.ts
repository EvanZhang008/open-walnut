/**
 * Both daemon twins, booted for real in a working directory deleted before they
 * start, run in one that exists (their daemon dir; healDaemonCwd moves them home
 * if that one is deleted later), so nothing they start inherits a deleted directory (2026-11-03: a server whose cwd was a
 * deleted build clone could not start the voice model's Python).
 *
 * MACHINE SAFETY: HOME and the daemon dir are temp dirs, PATH is the exec guard's
 * stand-ins then system dirs, random port, the daemon is SIGKILLed after each test (no session started).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { guardedPath } from '../setup/exec-guard-core.js'

let scriptPath = ''
let root = ''
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null

/** The working directory of a live process, as the OS reports it. */
function cwdOf(pid: number): string | null {
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`)
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null
  } catch { return null }
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cwd-heal-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('daemon twin: $name', (twin) => {
  it('started in a deleted directory, it serves from one that exists', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cwd-heal-')))
    const home = path.join(root, 'home')
    const doomed = path.join(root, 'build-clone')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(doomed, { recursive: true })
    const env: Record<string, string | undefined> = {
      ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], ['/usr/bin', '/bin'].join(path.delimiter)), HOME: home,
      WALNUT_DAEMON_DIR: path.join(root, 'daemon'), WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    }
    for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'WALNUT_STREAMS_DIR']) delete env[k]
    const [cmd, args] = twin.command()
    // The shell enters the directory, deletes it, and becomes the daemon (same pid).
    proc = spawn('/bin/sh', ['-c', 'cd "$1" && rmdir "$1" && shift && exec "$@"', 'start', doomed, cmd, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
      proc!.stdout?.on('data', (chunk) => {
        const m = chunk.toString().trim().match(/^\d+$/m)
        if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
      })
      proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
      onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
    })
    expect(fs.existsSync(doomed)).toBe(false)
    // It runs in a directory that exists (its daemon dir, where it moves at start;
    // healDaemonCwd covers that one being deleted later), never the deleted one.
    const cwd = cwdOf(proc.pid!)
    expect(cwd).toBeTruthy()
    expect(cwd).not.toBe(doomed)
    expect(fs.existsSync(cwd!)).toBe(true)
    expect([fs.realpathSync(home), fs.realpathSync(env.WALNUT_DAEMON_DIR!)]).toContain(fs.realpathSync(cwd!))
  }, 60_000)
})
