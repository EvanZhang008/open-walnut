/**
 * One-shot claude runs ('oneshot-v1') are wired into the daemon, which imports
 * oneshot-core.ts. This pins the wiring (commands, capability, bridge and
 * follower exclusion, version/build lists, socket close and shutdown cleanup)
 * and the core's warm pool.
 */
import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createOneShotCore, type OneShotChild } from '../../src/providers/oneshot-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const COMMANDS = ['oneshot.run', 'oneshot.prewarm', 'oneshot.cancel']
const FAKE = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')

function allowlist(src: string, name: string): string {
  const start = src.indexOf(name + ' = new Set([')
  expect(start, name).toBeGreaterThan(0)
  const end = src.indexOf('])', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('oneshot-v1 daemon wiring', () => {
  it('the daemon dispatches the three commands, ends runs with their socket, and disposes at shutdown', () => {
    for (const cmd of COMMANDS) expect(standalone).toContain(`case '${cmd}':`)
    expect(standalone).toContain('oneShot.dropClient(ws)')
    expect(standalone).toMatch(/function cleanup\([^)]*\) \{\n {2}\/\/ One-shot claude runs[^\n]*\n {2}try \{ oneShot\.disposeAll\(\)/)
  })

  it('the capability is advertised, not required, and no command reaches the bridge or a follower', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('oneshot-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('oneshot-v1')
    for (const list of ['BRIDGE_ALLOWED_COMMANDS', 'FOLLOWER_ALLOWED_COMMANDS', 'LANE_ALLOWED_COMMANDS']) {
      if (standalone.indexOf(list + ' = new Set([') < 0) continue
      const allow = allowlist(standalone, list)
      for (const cmd of COMMANDS) expect(allow, list).not.toContain(cmd)
    }
  })

  it('the core is in the version hash list and the binary build list', () => {
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/oneshot-core.ts'")
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/oneshot-core.ts')
  })
})

describe('a run of a real child', () => {
  it('streams its lines and reports its exit', async () => {
    const lines: string[] = []
    let exit: Record<string, unknown> | null = null
    const core = createOneShotCore<string>({
      spawn: spawn as unknown as (cmd: string, args: string[], opts: Record<string, unknown>) => OneShotChild,
      send: (_ws, ev, data) => {
        if (ev === 'oneshot.out') lines.push(...(data.lines as string[]))
        if (ev === 'oneshot.exit') exit = data
      },
    })
    core.run('sock', { runId: 'r1', command: process.execPath, args: [FAKE, '-p'], cwd: os.tmpdir(), env: { PATH: guardedPath([], '/usr/bin:/bin') }, input: 'twin', endInput: true })
    const until = Date.now() + 20_000
    while (!exit && Date.now() < until) await new Promise((r) => setTimeout(r, 25))
    expect(core.stats()).toEqual({ runs: 0, pool: 0 })
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['system', 'assistant', 'result'])
    expect((exit as Record<string, unknown> | null)?.code).toBe(0)
  }, 60_000)
})

describe('the warm pool', () => {
  /** A child that never exits on its own; kill marks it gone. */
  function fakeChild(): OneShotChild & { signals: string[] } {
    const child = {
      exitCode: null as number | null, killed: false, signals: [] as string[],
      stdin: { write: () => true, end: () => true, on: () => child.stdin },
      stdout: { on: () => child.stdout }, stderr: { on: () => child.stderr },
      on: () => child,
      kill: (sig?: string) => { child.signals.push(sig ?? 'SIGTERM'); child.killed = true; return true },
    }
    return child
  }

  it('gives way oldest first, a kept child (AI search) only when every child is kept', () => {
    const spawned: Array<{ key: string; child: ReturnType<typeof fakeChild> }> = []
    let nextKey = ''
    const core = createOneShotCore<string>({
      spawn: () => { const child = fakeChild(); spawned.push({ key: nextKey, child }); return child },
      send: () => {},
      poolMax: 3,
    })
    const warm = (key: string, keep = false) => { nextKey = key; core.prewarm({ warmKey: key, command: 'c', args: [], ...(keep ? { warmKeep: true } : {}) }) }
    const killed = () => spawned.filter((s) => s.child.killed).map((s) => s.key)
    warm('search', true)
    warm('app1'); warm('app2'); warm('app3'); warm('app4')
    expect(killed()).toEqual(['app1', 'app2'])
    expect(core.stats().pool).toBe(3)
    // A run of the kept key takes its child and boots a kept replacement.
    nextKey = 'search'
    const run = core.run('ws', { runId: 'r', warmKey: 'search', warmKeep: true, command: 'c', args: [] })
    expect(run.warm).toBe(true)
    warm('app5')
    expect(killed()).toEqual(['app1', 'app2', 'app3'])
    warm('s2', true); warm('s3', true); warm('s4', true)
    // Only kept children left: the oldest kept one (search's replacement) gives way.
    // Alive: the child the run took, and the three newest kept ones.
    expect(spawned.filter((s) => !s.child.killed).map((s) => s.key)).toEqual(['search', 's2', 's3', 's4'])
    expect(spawned.filter((s) => s.key === 'search').map((s) => s.child.killed)).toEqual([false, true])
    core.disposeAll()
  })
})
