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

/** The stage reap loop (top-level code), from its `for` to its `done`. */
function reapLoop(): string {
  const start = script.indexOf('for old_stage in "$STAGE_ROOT"/open-walnut-stage.*; do')
  const end = script.indexOf('\ndone\n', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return script.slice(start, end + '\ndone\n'.length)
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

function deadPid(): number {
  const r = spawnSync('true')
  return r.pid!
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
    return [fn('clone_copy'), fn('carry_plugin_source'), fn('dir_has_live_process'), fn('snapshot_lkg'),
      `STAGE_DIR='${stage}'`, `LKG_DIR='${lkg}'`, `SERVE_ROOT='${root}'`, `REPO_ROOT='${root}'`,
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

  // stage_plugin_source: the committed src/ plugins import from rides into the LKG, its
  // marker renamed to the LKG's own copy (a rollback server never reads the checkout's).
  it("carries the stage's committed plugin source, marker pointing at the LKG's copy", () => {
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    const script = harness(root, lkg)
    const stage = path.join(root, 'open-walnut-stage.9.9')
    fs.mkdirSync(path.join(stage, 'plugin-source', 'src', 'integrations'), { recursive: true })
    fs.writeFileSync(path.join(stage, 'plugin-source', 'src', 'integrations', 'x.ts'), 'committed')
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(stage, 'plugin-source', 'node_modules'))
    fs.writeFileSync(path.join(stage, '.walnut-plugin-source'), `${path.join(stage, 'plugin-source')}\n`)
    fs.mkdirSync(path.join(stage, 'plugin-source', '.plugin-cache'))
    fs.writeFileSync(path.join(stage, 'plugin-source', '.plugin-cache', 'old-bundle.mjs'), '')
    const r = bash(script)
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readFileSync(path.join(lkg, 'plugin-source', 'src', 'integrations', 'x.ts'), 'utf-8')).toBe('committed')
    // Bundles are rebuilt per process; the stage's old ones are not carried.
    expect(fs.existsSync(path.join(lkg, 'plugin-source', '.plugin-cache'))).toBe(false)
    expect(fs.lstatSync(path.join(lkg, 'plugin-source', 'node_modules')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(lkg, '.walnut-plugin-source'), 'utf-8').trim()).toBe(path.join(lkg, 'plugin-source'))
  })
})

describe('stage_plugin_source', () => {
  const dirsLine = () => /^PLUGIN_SOURCE_DIRS=.*$/m.exec(script)![0]
  // ca9bfc2bc review: the staged copy had src/ alone, so a bundle written in its
  // .plugin-cache found no package.json above it, and a `#ws` import (package.json
  // `imports`) failed at load time ("Cannot find package '#ws'").
  it("stages the commit's src/ and package.json, so a bundle in its .plugin-cache resolves the package's own # imports", () => {
    const root = tmp()
    const repo = path.join(root, 'clone')
    const serve = path.join(root, 'serve')
    const stage = path.join(root, 'open-walnut-stage.1.1')
    fs.mkdirSync(path.join(repo, 'src', 'integrations'), { recursive: true })
    fs.mkdirSync(path.join(repo, 'packages', 'plugin-api', 'src'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'packages', 'plugin-api', 'src', 'binding.ts'), "export const binding = 'packages'\n")
    fs.writeFileSync(path.join(repo, 'src', 'probe.ts'), "export { binding } from '../packages/plugin-api/src/binding.ts'\nexport const probe = 'committed'\n")
    const imports = { '#probe': { bun: './src/probe.ts', default: './src/probe.ts' } }
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', type: 'module', imports }))
    fs.mkdirSync(path.join(serve, 'node_modules'), { recursive: true })
    fs.mkdirSync(stage)
    const r = bash([fn('clone_copy'), dirsLine(), fn('stage_plugin_source'), `REPO_ROOT='${repo}'`, `SERVE_ROOT='${serve}'`,
      `stage_plugin_source '${stage}'`].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    const copy = path.join(stage, 'plugin-source')
    expect(fs.readFileSync(path.join(stage, '.walnut-plugin-source'), 'utf-8').trim()).toBe(copy)
    expect(fs.realpathSync(path.join(copy, 'node_modules'))).toBe(fs.realpathSync(path.join(serve, 'node_modules')))
    fs.mkdirSync(path.join(copy, '.plugin-cache'))
    const bundle = path.join(copy, '.plugin-cache', 'p.mjs')
    fs.writeFileSync(bundle, "import { probe, binding } from '#probe'\nconsole.log(probe, binding)\n")
    const run = spawnSync(process.execPath, [bundle], { encoding: 'utf-8' })
    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('committed packages')
  })

  // ca9bfc2bc's first deploy: src/lib/sqlite.ts imports ../../packages/plugin-api, which
  // the copy lacked, so an installed plugin failed its pre-kill check. Every top-level dir
  // a src/ file reaches by a relative import must be staged (node_modules is linked).
  it('stages every top-level directory src/ imports from', () => {
    const repoRoot = path.join(import.meta.dirname, '..', '..')
    const reached = new Set<string>()
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf-8').matchAll(/(?:from|import|require)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
            const top = path.relative(repoRoot, path.resolve(path.dirname(p), m[1])).split(path.sep)[0]
            if (top !== 'src' && top !== 'node_modules') reached.add(top)
          }
        }
      }
    }
    walk(path.join(repoRoot, 'src'))
    expect(reached.size).toBeGreaterThan(0)
    const staged = /^PLUGIN_SOURCE_DIRS="([^"]*)"$/m.exec(script)![1].split(/\s+/)
    expect(staged).toContain('src')
    for (const top of reached) expect(staged, `src/ imports from ${top}/`).toContain(top)
  })

  it('stages nothing when the deploy builds the serve root itself', () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, 'src', 'integrations'), { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules'))
    const stage = path.join(root, 'stage')
    fs.mkdirSync(stage)
    const r = bash([fn('clone_copy'), dirsLine(), fn('stage_plugin_source'), `REPO_ROOT='${root}'`, `SERVE_ROOT='${root}'`,
      `stage_plugin_source '${stage}'`].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.readdirSync(stage)).toEqual([])
  })
})

describe('rollback_to_lkg', () => {
  function harness(root: string, lkg: string): string {
    return [fn('clone_copy'), fn('carry_plugin_source'), fn('stage_lkg_for_rollback'), fn('lkg_file'), fn('rollback_to_lkg'),
      'launch_server() { printf "LAUNCH %s\\n" "$*"; }',
      'wait_for_config_ready() { return 0; }',
      `STAGE_ROOT='${root}'`, `LKG_DIR='${lkg}'`, `SERVE_ROOT='${root}/serve'`, 'MACHINE_TARGET=darwin-arm64',
      'PORT=1', 'rollback_to_lkg'].join('\n')
  }

  it('starts the compiled file from a stage cloned from the LKG, never from the LKG itself', () => {
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    program(path.join(lkg, 'dist-bin', 'walnut-darwin-arm64'))
    program(path.join(lkg, 'dist-bin', 'walnut-linux-x64'))
    fs.mkdirSync(path.join(lkg, 'runtime', 'id-1', 'dist'), { recursive: true })
    const r = bash(harness(root, lkg))
    expect(r.status, r.stderr).toBe(0)
    const m = /^LAUNCH (.+)$/m.exec(r.stdout)
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

  it('reads the old temp snapshot until the first one lands off the temp dir, and stages it too', () => {
    const root = tmp()
    const legacy = path.join(root, 'tmp', 'open-walnut-lkg')
    program(path.join(legacy, 'dist-bin', 'walnut-darwin-arm64'))
    const r = bash([harness(root, path.join(root, 'state', 'open-walnut-lkg')).replace(/\nrollback_to_lkg$/, ''),
      `LKG_LEGACY_DIR='${legacy}'`, 'rollback_to_lkg'].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    const launched = /^LAUNCH (.+)$/m.exec(r.stdout)![1]
    expect(launched.startsWith(`${root}/open-walnut-stage.rollback.`)).toBe(true)
    expect(launched.endsWith('/dist-bin/walnut-darwin-arm64')).toBe(true)
    // A WALNUT_DEVPROD_LKG_DIR the caller named is the only place read.
    const named = bash([harness(root, path.join(root, 'state', 'open-walnut-lkg')).replace(/\nrollback_to_lkg$/, ''),
      `LKG_LEGACY_DIR='${legacy}'`, `WALNUT_DEVPROD_LKG_DIR='${root}/state/open-walnut-lkg'`, 'rollback_to_lkg'].join('\n'))
    expect(named.stdout).not.toMatch(/^LAUNCH/m)
    expect(named.stderr).toMatch(/No last-known-good file at/)
  })

  it('never starts a Node LKG an older deploy left: it names it and leaves the port unserved', () => {
    const root = tmp()
    const lkg = path.join(root, 'open-walnut-lkg')
    fs.mkdirSync(path.join(lkg, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(lkg, 'dist', 'cli.js'), '// cli')
    fs.writeFileSync(path.join(lkg, 'package.json'), '{"version":"1.2.3"}')
    const r = bash(harness(root, lkg))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/^LAUNCH/m)
    expect(r.stderr).toMatch(/is a Node build, which Walnut can no longer run; :1 is left unserved/)
    // Nothing was staged for it.
    expect(fs.readdirSync(root).filter((n) => n.startsWith('open-walnut-stage.rollback.'))).toEqual([])
  })

  it('says so when there is no LKG at all', () => {
    const root = tmp()
    const r = bash(harness(root, path.join(root, 'open-walnut-lkg')))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).not.toMatch(/^LAUNCH/m)
    expect(r.stderr).toMatch(/No last-known-good file at .*open-walnut-lkg; :1 is left unserved/)
  })
})

describe('the stage reaper', () => {
  it('removes dead stages, and strips the Linux files from a stage kept only for a daemon', async () => {
    // 2026-10-23 review: one live MCP child held a 537 MB stage, 476 MB of it the
    // four Linux files only a serving server reads.
    const root = tmp()
    const tag = `t${process.pid}x${Date.now()}`
    const stage = (name: string) => path.join(root, `open-walnut-stage.${tag}.${name}`)
    const files = (dir: string) => {
      for (const t of ['darwin-arm64', 'linux-x64', 'linux-arm64-musl']) program(path.join(dir, 'dist-bin', `walnut-${t}`))
      fs.mkdirSync(path.join(dir, 'runtime', 'id'), { recursive: true })
    }
    for (const n of ['dead', 'daemon', 'web', 'current']) files(stage(n))
    await runFrom(path.join(stage('daemon'), 'dist-bin', 'walnut-darwin-arm64'), ['__daemon', '--start'])
    await runFrom(path.join(stage('web'), 'dist-bin', 'walnut-darwin-arm64'), ['web', '--port', '1'])
    const r = bash([fn('stage_has_live_process'), fn('stage_serves_web'),
      `STAGE_ROOT='${root}'`, `STAGE_DIR='${stage('current')}'`, 'MACHINE_TARGET=darwin-arm64', reapLoop()].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(stage('dead'))).toBe(false)
    expect(fs.readdirSync(path.join(stage('daemon'), 'dist-bin'))).toEqual(['walnut-darwin-arm64'])
    expect(fs.existsSync(path.join(stage('daemon'), 'runtime', 'id'))).toBe(true)
    expect(fs.readdirSync(path.join(stage('web'), 'dist-bin')).sort()).toEqual(['walnut-darwin-arm64', 'walnut-linux-arm64-musl', 'walnut-linux-x64'])
    expect(fs.readdirSync(path.join(stage('current'), 'dist-bin'))).toHaveLength(3)
  })
})

describe('sweep_build_clones', () => {
  it('removes only a clone an interrupted deploy left: ours, older than the lock, its deploy gone, nothing running from it', async () => {
    const root = tmp()
    const clone = (sha: string, pid: number) => {
      const d = path.join(root, `open-walnut-build.${sha}.${pid}`)
      fs.mkdirSync(path.join(d, 'scripts'), { recursive: true })
      return d
    }
    const dead = deadPid()
    const self = clone('000000000000', dead)
    const stale = clone('111111111111', dead)
    const ownerAlive = clone('222222222222', process.pid)
    const newer = clone('333333333333', dead)
    const inUse = clone('444444444444', dead)
    const odd = path.join(root, 'open-walnut-build.not-a-clone')
    fs.mkdirSync(odd)
    const old = new Date(Date.now() - 3_600_000)
    for (const d of [self, stale, ownerAlive, inUse, odd]) fs.utimesSync(d, old, old)
    const lock = path.join(root, 'lock')
    fs.mkdirSync(lock)
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(newer, later, later)
    await runFrom(program(path.join(inUse, 'scripts', 'job.sh')), [])
    const r = bash([fn('sweep_build_clones'), `REPO_ROOT='${self}'`, `LOCK_DIR='${lock}'`, 'REHEARSAL=0', 'REHEARSAL_ROOT=', `TMPDIR='${root}'`, 'sweep_build_clones'].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(`Removed a build clone an interrupted deploy left: ${stale}`)
    for (const d of [self, ownerAlive, newer, inUse, odd]) expect(fs.existsSync(d), d).toBe(true)
    expect(fs.existsSync(stale)).toBe(false)
  })

  it('in a rehearsal, never sweeps outside the rehearsal dir', () => {
    const root = tmp()
    const self = path.join(root, `open-walnut-build.000000000000.${deadPid()}`)
    const stale = path.join(root, `open-walnut-build.111111111111.${deadPid()}`)
    for (const d of [self, stale]) fs.mkdirSync(d)
    const old = new Date(Date.now() - 3_600_000)
    fs.utimesSync(stale, old, old)
    fs.mkdirSync(path.join(root, 'lock'))
    const r = bash([fn('sweep_build_clones'), `REPO_ROOT='${self}'`, `LOCK_DIR='${root}/lock'`, 'REHEARSAL=1', `REHEARSAL_ROOT='${root}/elsewhere'`, 'sweep_build_clones'].join('\n'))
    expect(r.status, r.stderr).toBe(0)
    expect(fs.existsSync(stale)).toBe(true)
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
