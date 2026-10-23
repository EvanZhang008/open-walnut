/**
 * What a deploy may delete or stop, run against real processes: the
 * last-known-good build, the stages kept for a live process, the build clones an
 * interrupted deploy left, and the servers a rehearsal's stray sweep reaps
 * (scripts/dev-prod.sh). Each case starts a stand-in process whose command line
 * names the directory, the way a server, its daemon or a session's MCP child does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const SCRIPT = path.join(import.meta.dirname, '..', '..', 'scripts', 'dev-prod.sh')
const script = fs.readFileSync(SCRIPT, 'utf-8')

function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(script)
  expect(m, `function ${name} in dev-prod.sh`).not.toBeNull()
  return m![0]
}

function bash(body: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', ['-c', `set -euo pipefail\n${body}`], { encoding: 'utf-8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const dirs: string[] = []
const procs: ChildProcess[] = []
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL')
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devprod-lkg-')))
  dirs.push(d)
  return d
}

/** An executable stand-in at `file` that just waits. */
function program(file: string, body = 'sleep 60'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}

/** Starts `file args...` and resolves once the process table shows it. */
async function runFrom(file: string, args: string[]): Promise<ChildProcess> {
  const p = spawn(file, args, { stdio: 'ignore' })
  procs.push(p)
  for (let i = 0; i < 50; i++) {
    const cmd = spawnSync('ps', ['-o', 'command=', '-p', String(p.pid)], { encoding: 'utf-8' }).stdout
    if (cmd.includes(file)) return p
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`${file} never showed up in ps`)
}

describe('the stray sweep in a rehearsal', () => {
  it('reaps only a server on its port that runs from one of its own stages', async () => {
    // 2026-10-23 review: the sweep reaped any server whose command line named the
    // rehearsal's port, wherever it ran from. `kill` is a stand-in that only
    // reports a signal (and delivers it to our own stand-in), so nothing else on
    // this machine can be touched by the test, whatever the sweep decides.
    const root = tmp()
    const state = path.join(root, 'rehearsal-state')
    const port = String(40000 + (process.pid % 9000))
    const own = await runFrom(program(path.join(state, 'open-walnut-stage.1.2', 'dist-bin', 'walnut-darwin-arm64')), ['web', '--port', port])
    const foreign = await runFrom(program(path.join(root, 'other', 'open-walnut-stage.3.4', 'dist-bin', 'walnut-darwin-arm64')), ['web', '--port', port])
    const noPort = await runFrom(program(path.join(state, 'open-walnut-stage.5.6', 'dist-bin', 'walnut-darwin-arm64')), ['web'])
    const otherPort = await runFrom(program(path.join(state, 'open-walnut-stage.7.8', 'dist-bin', 'walnut-darwin-arm64')), ['web', '--port', `${port}1`])
    const start = script.indexOf('self_pid=$$\n')
    const end = script.indexOf('\ndone\n', script.indexOf('Reaping stray', start))
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const r = bash([fn('rehearsal_owns_pid'),
      `kill() { if [[ "$1" == "-0" ]]; then command kill -0 "$2"; return; fi; echo "SIGNAL $1 $2"; if [[ "$2" == "${own.pid}" ]]; then command kill "$1" "$2"; fi; }`,
      `TMPDIR='${state}'`, `LKG_DIR='${state}/open-walnut-lkg'`, `REPO_ROOT='${root}/repo'`, `SERVE_ROOT='${root}/repo'`,
      `PORT=${port}`, 'REHEARSAL=1', script.slice(start, end + '\ndone\n'.length)].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toMatch(new RegExp(`Reaping stray Walnut server PID ${own.pid} `))
    const signalled = [...r.stdout.matchAll(/^SIGNAL -\d+ (\d+)$/gm)].map((m) => Number(m[1]))
    expect(new Set(signalled)).toEqual(new Set([own.pid]))
    for (const p of [foreign, noPort, otherPort]) expect(signalled).not.toContain(p.pid)
  })
})
