/**
 * The replica browser fixture (tests/e2e/browser/replica-server.ts, WP7 S8)
 * stops its cluster on SIGTERM even when the signal lands while the cluster is
 * still starting: its handlers are installed before the start, wait for it, stop
 * every process of it and exit 0. (Installed after the start, an early SIGTERM
 * took the default action: the fixture died at once and the Mac, its daemon and
 * the host daemon it had spawned ran on.)
 *
 * The fixture runs with TMPDIR set to a dir made for this run, so every process
 * of its cluster names that dir on its command line: that is how this test sees
 * them, and the only processes it would ever clean up after a failure.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
// Short: the cluster's unix socket paths live under it (104 bytes on macOS).
const tmp = fs.mkdtempSync('/tmp/rfs-')
let fixture: ChildProcess | null = null

/** Processes whose command line names this run's dir (the fixture's cluster), with their start times. */
function ours(): Array<{ pid: number; command: string }> {
  let out = ''
  try { out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }) } catch { return [] }
  const real = fs.realpathSync(tmp)
  return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const sp = l.indexOf(' ')
    return { pid: Number(l.slice(0, sp)), command: l.slice(sp + 1) }
  }).filter((r) => r.pid > 1 && r.pid !== process.pid && (r.command.includes(`${tmp}/`) || r.command.includes(`${real}/`)))
}

async function freePair(): Promise<number> {
  const listen = (p: number) => new Promise<boolean>((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)))
  })
  for (let p = 3600 + Math.floor(Math.random() * 300); p < 4000; p += 2) {
    if (p === 3456 || p === 3457) continue
    if (await listen(p) && await listen(p + 1)) return p
  }
  throw new Error('no free port pair')
}

const waitFor = async (fn: () => boolean, ms: number, what: string) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

afterAll(async () => {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGKILL')
  // A failure left the cluster behind: only processes naming this run's own dir.
  const left = ours()
  for (const p of left) { try { process.kill(p.pid, 'SIGKILL') } catch { /* gone */ } }
  if (left.length) process.stderr.write(`replica-fixture-early-signal: cleaned up ${left.map((p) => `${p.pid} ${p.command.slice(0, 120)}`).join('; ')}\n`)
  fs.rmSync(tmp, { recursive: true, force: true })
}, 60_000)

describe('the replica browser fixture and an early SIGTERM', () => {
  it('a SIGTERM while the cluster starts waits for it, stops all of it, and exits 0', async () => {
    const port = await freePair()
    let stderr = ''
    // The env Playwright gives it: the runner's, without vitest's own markers.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST') && k !== 'NODE_ENV'))
    fixture = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/browser/replica-server.ts'], {
      cwd: ROOT, env: { ...env, PW_TEST_PORT: String(port), TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    fixture.stdout!.resume()
    fixture.stderr!.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => fixture!.once('exit', (code, signal) => resolve({ code, signal })))
    // The cluster has spawned its first processes (the Mac, the host daemon), and is not ready.
    await waitFor(() => ours().length > 0, 120_000, 'the cluster to spawn its first process')
    expect(stderr).not.toContain('REPLICA_FIXTURE_READY')
    fixture.kill('SIGTERM')
    const done = await exit
    expect(done, stderr.slice(-2000)).toEqual({ code: 0, signal: null })
    expect(stderr).toContain('REPLICA_FIXTURE_SHUTDOWN cluster stopped')
    // Nothing of the cluster outlives the fixture.
    await waitFor(() => ours().length === 0, 15_000, 'every process of the cluster to stop').catch(() => undefined)
    expect(ours()).toEqual([])
  }, 300_000)
})
