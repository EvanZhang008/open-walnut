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

describe('dir_has_live_process (the LKG, whose name is not unique)', () => {
  it('finds a process running from exactly this directory, however the path is spelled', async () => {
    const root = tmp()
    const lkg = path.join(root, 'T', 'open-walnut-lkg')
    const other = path.join(root, 'rehearsal-state', 'open-walnut-lkg')
    fs.mkdirSync(lkg, { recursive: true })
    await runFrom(program(path.join(other, 'dist-bin', 'walnut-x')), ['web', '--port', '1'])
    const check = (dir: string) => bash(`${fn('dir_has_live_process')}\ndir_has_live_process '${dir}' || echo none`).stdout.trim()
    // A process from another dir of the same name is not this one's.
    expect(check(lkg)).toBe('none')
    const p = await runFrom(program(path.join(lkg, 'dist-bin', 'walnut-x')), ['__daemon', '--start'])
    expect(check(lkg)).toBe(String(p.pid))
    expect(check(`${lkg}/`)).toBe(String(p.pid))
    expect(check(lkg.replace('/T/', '/T//'))).toBe(String(p.pid))
  })
})

describe('snapshot_lkg', () => {
  function harness(root: string, lkg: string): string {
    const stage = path.join(root, 'open-walnut-stage.9.9')
    fs.mkdirSync(path.join(stage, 'dist-bin'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'dist-bin', 'walnut-x'), 'new build')
    fs.mkdirSync(path.join(stage, 'runtime', 'id-new'), { recursive: true })
    return [fn('clone_copy'), fn('dir_has_live_process'), fn('snapshot_lkg'),
      `STAGE_DIR='${stage}'`, `LKG_DIR='${lkg}'`, 'SERVER_KIND=file', `SERVE_ROOT='${root}'`, `REPO_ROOT='${root}'`,
      'snapshot_lkg'].join('\n')
  }

  it('never replaces an LKG that a process still runs from, and replaces it once nothing does', async () => {
    // 2026-10-23 review: a daemon respawned from a rollback server's LKG path
    // survived the next deploy, whose snapshot deleted its executable and tree.
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    const live = program(path.join(lkg, 'dist-bin', 'walnut-x'))
    fs.mkdirSync(path.join(lkg, 'runtime', 'id-old'), { recursive: true })
    const p = await runFrom(live, ['__daemon', '--start'])
    const kept = bash(harness(root, lkg))
    expect(kept.status, kept.stderr).toBe(0)
    expect(kept.stderr).toMatch(new RegExp(`Keeping the last-known-good build at ${lkg}: process ${p.pid} still runs from it`))
    expect(fs.existsSync(path.join(lkg, 'runtime', 'id-old'))).toBe(true)
    expect(fs.readFileSync(live, 'utf-8')).toContain('sleep 60')

    p.kill('SIGKILL')
    await new Promise((r) => p.once('exit', r))
    const replaced = bash(harness(root, lkg))
    expect(replaced.status, replaced.stderr).toBe(0)
    expect(fs.readFileSync(path.join(lkg, 'dist-bin', 'walnut-x'), 'utf-8')).toBe('new build')
    expect(fs.existsSync(path.join(lkg, 'runtime', 'id-new'))).toBe(true)
    expect(fs.existsSync(path.join(lkg, 'runtime', 'id-old'))).toBe(false)
    expect(fs.readFileSync(path.join(lkg, '.walnut-source-root'), 'utf-8').trim()).toBe(root)
  })
})

describe('rollback_to_lkg', () => {
  function harness(root: string, lkg: string): string {
    return [fn('clone_copy'), fn('lkg_has_build'), fn('stage_lkg_for_rollback'), fn('rollback_to_lkg'),
      'launch_server() { printf "LAUNCH %s %s\\n" "$1" "$2"; }',
      'wait_for_config_ready() { return 0; }',
      `STAGE_ROOT='${root}'`, `LKG_DIR='${lkg}'`, `SERVE_ROOT='${root}/serve'`, 'MACHINE_TARGET=darwin-arm64',
      'NODE_BIN=/usr/bin/true', 'PORT=1', 'rollback_to_lkg'].join('\n')
  }

  it('starts the compiled file from a stage cloned from the LKG, never from the LKG itself', () => {
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    program(path.join(lkg, 'dist-bin', 'walnut-darwin-arm64'))
    program(path.join(lkg, 'dist-bin', 'walnut-linux-x64'))
    fs.mkdirSync(path.join(lkg, 'runtime', 'id-1', 'dist'), { recursive: true })
    const r = bash(harness(root, lkg))
    expect(r.status, r.stderr).toBe(0)
    const m = /^LAUNCH file (.+)$/m.exec(r.stdout)
    expect(m, r.stdout + r.stderr).not.toBeNull()
    const launched = m![1]
    expect(launched.startsWith(`${root}/open-walnut-stage.rollback.`)).toBe(true)
    expect(launched.endsWith('/dist-bin/walnut-darwin-arm64')).toBe(true)
    const stage = path.dirname(path.dirname(launched))
    // The stage carries what the server reads: its runtime tree, its siblings, the checkout marker.
    expect(fs.existsSync(path.join(stage, 'runtime', 'id-1', 'dist'))).toBe(true)
    expect(fs.existsSync(path.join(stage, 'dist-bin', 'walnut-linux-x64'))).toBe(true)
    expect(fs.readFileSync(path.join(stage, '.walnut-source-root'), 'utf-8').trim()).toBe(`${root}/serve`)
  })

  it('starts a Node LKG from a stage too, with its package.json and the serve root dependencies', () => {
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    fs.mkdirSync(path.join(lkg, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(lkg, 'dist', 'cli.js'), '// cli')
    fs.writeFileSync(path.join(lkg, 'package.json'), '{"version":"1.2.3"}')
    const r = bash(harness(root, lkg))
    expect(r.status, r.stderr).toBe(0)
    const launched = /^LAUNCH node (.+)$/m.exec(r.stdout)![1]
    expect(launched.startsWith(`${root}/open-walnut-stage.rollback.`)).toBe(true)
    const stage = path.dirname(path.dirname(launched))
    expect(fs.readFileSync(path.join(stage, 'package.json'), 'utf-8')).toContain('1.2.3')
    expect(fs.readlinkSync(path.join(stage, 'node_modules'))).toBe(`${root}/serve/node_modules`)
  })
})

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
