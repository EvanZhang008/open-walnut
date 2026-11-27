/**
 * The server re-runs itself once with the JS engine's RAM hint (src/lib/jsc-ram-hint.ts):
 * which starts do, the exact command line and env they run again with, the value, and
 * that the run it becomes hands no hint of Walnut's on to its children. execve is a
 * stub here: no test ever replaces its own process.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RAM_HINT_BYTES, JSC_RAM_ENV, RAM_HINT_APPLIED_ENV, RAM_HINT_ENV,
  decideRamHintReexec, isServerStart, ramHintBytes, ramHintSummary, startWithRamHint, takeRamHint,
  type RamHintDeps, type RamHintInput,
} from '../../src/lib/jsc-ram-hint.js'
import { bootEnvOf } from '../../src/commands/web.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const GiB = 1024 ** 3
const BUN = '/opt/bun/bin/bun'
const FILE = '/home/alice/.local/bin/walnut'
/** The compiled file's argv: bun names itself argv[0] and its own entry argv[1]. */
const FILE_ARGV = ['bun', '/$bunfs/root/walnut', 'web', '--port', '3456']
const ON_BUN = { node: '24.3.0', bun: '1.4.4' } as NodeJS.ProcessVersions

function input(over: Partial<RamHintInput> = {}): RamHintInput {
  return {
    argv: FILE_ARGV, argv0: FILE, execPath: FILE, env: { HOME: '/home/alice', LANG: 'en_US.UTF-8' },
    platform: 'linux', versions: ON_BUN, totalMem: 48 * GiB, hasExecve: true,
    ...over,
  }
}

describe('the hint value', () => {
  it('is 4 GiB, or the machine RAM when that is less; the person may choose another or 0 (off)', () => {
    expect(ramHintBytes({}, 48 * GiB)).toBe(DEFAULT_RAM_HINT_BYTES)
    expect(DEFAULT_RAM_HINT_BYTES).toBe(4294967296)
    expect(ramHintBytes({}, 2 * GiB)).toBe(2 * GiB)
    expect(ramHintBytes({ [RAM_HINT_ENV]: '8589934592' }, 2 * GiB)).toBe(8589934592)
    expect(ramHintBytes({ [RAM_HINT_ENV]: '0' }, 48 * GiB)).toBeNull()
    // A value that is no byte count keeps the default rather than turning it off.
    expect(ramHintBytes({ [RAM_HINT_ENV]: '4G' }, 48 * GiB)).toBe(DEFAULT_RAM_HINT_BYTES)
    expect(ramHintBytes({}, 0)).toBe(DEFAULT_RAM_HINT_BYTES)
  })

  it('respects a memory limit below the RAM (a cgroup or container), and ignores one that is no limit', () => {
    expect(ramHintBytes({}, 48 * GiB, 1.5 * GiB)).toBe(1.5 * GiB)
    expect(ramHintBytes({}, 48 * GiB, 8 * GiB)).toBe(4 * GiB)
    // No limit reads as 0, the RAM itself, or a number past the RAM (cgroup "max").
    expect(ramHintBytes({}, 2 * GiB, 0)).toBe(2 * GiB)
    expect(ramHintBytes({}, 2 * GiB, 2 * GiB)).toBe(2 * GiB)
    expect(ramHintBytes({}, 2 * GiB, Number.MAX_SAFE_INTEGER)).toBe(2 * GiB)
    // The person's own value is theirs.
    expect(ramHintBytes({ [RAM_HINT_ENV]: '3221225472' }, 48 * GiB, GiB)).toBe(3221225472)
    expect(decideRamHintReexec(input({ constrainedMem: GiB }))).toMatchObject({ kind: 'reexec', bytes: GiB })
  })
})

describe('which starts take it', () => {
  it('the server: web or serve, normal, replica, ephemeral child and restore trial', () => {
    for (const args of [['web'], ['serve'], ['web', '--port', '3456'], ['--json', 'web'], ['web', '--replica'], ['serve', '--replica'],
      ['web', '--_ephemeral-child'], ['web', '--_trial-start'], ['web', '--dev']]) expect(isServerStart(args), args.join(' ')).toBe(true)
  })

  it('nothing else: the ephemeral launcher, help, other commands, the daemon and service', () => {
    for (const args of [[], ['web', '--ephemeral'], ['web', '--help'], ['serve', '-h'], ['tools', 'list'], ['mcp'], ['demo', '--_child'],
      ['host-server'], ['__daemon', '--start'], ['--service'], ['--version'], ['tools', 'call', 'x', 'web']]) expect(isServerStart(args), args.join(' ')).toBe(false)
  })
})

describe('the command line it runs again', () => {
  it('the compiled file: argv[0] as started and its user arguments; its virtual entry it adds itself', () => {
    expect(decideRamHintReexec(input())).toMatchObject({ kind: 'reexec', file: FILE, args: [FILE, 'web', '--port', '3456'] })
    // No argv0 known: the file itself.
    expect(decideRamHintReexec(input({ argv0: undefined }))).toMatchObject({ file: FILE, args: [FILE, 'web', '--port', '3456'] })
  })

  it('a script never re-runs: bun resolved its argv[1], so the command line the Mac app finds it by would change', () => {
    for (const argv of [[BUN, '/srv/walnut/dist/cli.js', 'web'], [BUN, '/home/alice/.bun/install/global/node_modules/open-walnut/bin/open-walnut.js', 'serve'], [BUN]]) {
      expect(decideRamHintReexec(input({ argv, argv0: BUN, execPath: BUN })), argv.join(' '))
        .toEqual({ kind: 'skip', reason: argv.length > 1 ? 'run from a script: its command line cannot be kept' : 'not a server start' })
    }
  })
})

describe('the decision', () => {
  it('re-execs with the env exactly as it started plus the hint and its marker', () => {
    const env = { HOME: '/home/alice', LANG: 'en_US.UTF-8', BUN_BE_BUN: '1', OPEN_WALNUT_HOME: '/home/alice/.open-walnut' }
    const d = decideRamHintReexec(input({ env }))
    expect(d).toEqual({
      kind: 'reexec', file: FILE, args: [FILE, 'web', '--port', '3456'], bytes: 4 * GiB,
      env: { ...env, [JSC_RAM_ENV]: '4294967296', [RAM_HINT_APPLIED_ENV]: '4294967296' },
    })
    // The caller's env is never edited.
    expect(env).not.toHaveProperty(JSC_RAM_ENV)
  })

  it('skips off bun, on Windows, with the variable present (the loop guard), when turned off, and without execve', () => {
    const skip = (over: Partial<RamHintInput>) => decideRamHintReexec(input(over)).kind
    expect(skip({ versions: { node: '22.11.0' } as NodeJS.ProcessVersions })).toBe('skip')
    expect(skip({ platform: 'win32' })).toBe('skip')
    expect(skip({ env: { [JSC_RAM_ENV]: '1073741824' } })).toBe('skip')
    expect(skip({ env: { [RAM_HINT_ENV]: '0' } })).toBe('skip')
    expect(skip({ hasExecve: false })).toBe('skip')
    expect(skip({ argv: ['bun', '/$bunfs/root/walnut', 'tools', 'list'] })).toBe('skip')
    expect(skip({ platform: 'darwin' })).toBe('reexec')
  })
})

describe('the run it becomes', () => {
  it("takes Walnut's hint out of its env, so no child inherits it", () => {
    const env: NodeJS.ProcessEnv = { HOME: '/h', [JSC_RAM_ENV]: '4294967296', [RAM_HINT_APPLIED_ENV]: '4294967296' }
    expect(takeRamHint(env)).toEqual({ on: true, bytes: 4294967296, by: 'walnut' })
    expect(env).toEqual({ HOME: '/h' })
  })

  it("keeps a hint the person set: no marker, or a marker naming another value (the marker always goes)", () => {
    const own: NodeJS.ProcessEnv = { [JSC_RAM_ENV]: '1073741824' }
    expect(takeRamHint(own)).toEqual({ on: true, bytes: 1073741824, by: 'person' })
    expect(own).toEqual({ [JSC_RAM_ENV]: '1073741824' })
    const mixed: NodeJS.ProcessEnv = { [JSC_RAM_ENV]: '1073741824', [RAM_HINT_APPLIED_ENV]: '4294967296' }
    expect(takeRamHint(mixed)?.by).toBe('person')
    expect(mixed).toEqual({ [JSC_RAM_ENV]: '1073741824' })
    expect(takeRamHint({})).toBeNull()
  })
})

/** A process stand-in whose execve records the call and returns (the real one never does). */
function fakeProc(over: { argv?: string[]; env?: NodeJS.ProcessEnv; execve?: (f: string, a: string[], e: NodeJS.ProcessEnv) => void } = {}) {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const proc = {
    argv: over.argv ?? FILE_ARGV, argv0: FILE, execPath: FILE,
    env: over.env ?? { HOME: '/home/alice' }, platform: 'darwin' as NodeJS.Platform, versions: ON_BUN,
    execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => { calls.push({ file, args, env }); over.execve?.(file, args, env) }) as never,
  }
  return { proc, calls, deps: { proc, totalMem: () => 48 * GiB } as RamHintDeps }
}

describe('startWithRamHint', () => {
  it('keeps argv[0] as the process was started (a link), so ps shows the same command line', () => {
    const LINK = '/Applications/Walnut.app/Contents/Resources/walnut'
    const FILE = '/opt/walnut/dist-bin/walnut-darwin-arm64'
    const d = decideRamHintReexec({
      argv: FILE_ARGV, argv0: LINK, execPath: FILE,
      env: {}, platform: 'darwin', versions: ON_BUN, totalMem: 48 * GiB, hasExecve: true,
    })
    expect(d).toMatchObject({ kind: 'reexec', file: FILE, args: [LINK, 'web', '--port', '3456'] })
  })

  it('execs once with the hint, then the new image strips it, and a restart from bootEnvOf takes it again', () => {
    const first = fakeProc()
    startWithRamHint(first.deps)
    expect(first.calls).toHaveLength(1)
    const exec = first.calls[0]!
    expect(exec).toMatchObject({ file: FILE, args: [FILE, 'web', '--port', '3456'] })
    // The image execve starts: the compiled file's argv again, the env it was given.
    const second = fakeProc({ env: { ...exec.env } })
    expect(startWithRamHint(second.deps)).toEqual({ on: true, bytes: 4 * GiB, by: 'walnut' })
    expect(second.calls).toHaveLength(0)
    expect(second.proc.env).toEqual({ HOME: '/home/alice' })
    // A restart into an update starts `web` with the env runWeb took (web.ts bootEnvOf): no stale hint, so it re-execs itself.
    const restart = bootEnvOf(second.proc.env)
    expect(restart).not.toHaveProperty(JSC_RAM_ENV)
    expect(decideRamHintReexec(input({ env: restart })).kind).toBe('reexec')
  })

  it('goes on without the hint when execve throws, its env as it was', () => {
    const t = fakeProc({ execve: () => { throw new Error('EPERM') } })
    expect(startWithRamHint(t.deps)).toEqual({ on: false, reason: 'execve failed: EPERM' })
    expect(t.proc.env).toEqual({ HOME: '/home/alice' })
  })

  it('never execs for another command', () => {
    const t = fakeProc({ argv: ['bun', '/$bunfs/root/walnut', 'tools', 'list'] })
    expect(startWithRamHint(t.deps)).toEqual({ on: false, reason: 'not a server start' })
    expect(t.calls).toHaveLength(0)
  })

  it('never execs a server run from a script, and says why', () => {
    const t = fakeProc({ argv: [BUN, '/srv/walnut/dist/cli.js', 'web'] })
    expect(startWithRamHint(t.deps)).toEqual({ on: false, reason: 'run from a script: its command line cannot be kept' })
    expect(t.calls).toHaveLength(0)
  })

  it('reads the memory limit from the process', () => {
    const t = fakeProc()
    ;(t.proc as { constrainedMemory?: () => number }).constrainedMemory = () => 2 * GiB
    startWithRamHint(t.deps)
    expect(t.calls[0]?.env[JSC_RAM_ENV]).toBe(String(2 * GiB))
  })

  it('says in the start line whether the hint is on', () => {
    expect(ramHintSummary({ on: true, bytes: 4 * GiB, by: 'walnut' })).toEqual({ on: true, bytes: 4 * GiB, mb: 4096, by: 'walnut' })
    expect(ramHintSummary({ on: false, reason: `${RAM_HINT_ENV}=0` })).toEqual({ on: false, reason: `${RAM_HINT_ENV}=0` })
    expect(ramHintSummary(null).on).toBe(false)
  })
})

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(ROOT, full))
  }
  return out
}

describe('every way the server starts is known', () => {
  // Each file that starts the web server, and whether its process took the hint at its entry.
  // A new one fails here: route it through `web` (hinted at the compiled file's entry, main.ts),
  // or add it with why not. Run from a script, none is hinted (jsc-ram-hint.ts says why).
  const SERVER_STARTS: Record<string, string> = {
    'src/commands/web.ts': 'hinted: `web` / `serve`, normal and replica',
    'src/commands/web-ephemeral.ts': 'hinted: `web --_ephemeral-child`',
    'src/commands/web-trial.ts': 'hinted: `web --_trial-start`',
    'src/commands/demo-server.ts': 'not hinted: `demo --_child`, a short Demo of a first run',
    'src/binary/service-entry.ts': 'not hinted: `--service` runs the daemon runtime in the same process, and its start hooks must not run twice',
  }

  it('names each file that starts the server', () => {
    // The `web` command's own action calls runWeb: that is the hinted start itself.
    const WEB_COMMAND = new Set(['src/commands/index.ts', 'src/commands/web.ts'])
    const starters = walk(path.join(ROOT, 'src')).filter((file) => {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
      const startsServer = /\{[^}]*\bstartServer\b[^}]*\}\s*=\s*await import\(['"][./]+web\/server\.js['"]\)/.test(text)
        || /\bimport\s*\{[^}]*\bstartServer\b[^}]*\}\s*from\s*['"][./]+web\/server\.js['"]/.test(text)
      const callsRunWeb = !WEB_COMMAND.has(file) && /\brunWeb\(/.test(text)
      return startsServer || callsRunWeb
    })
    expect(starters.sort()).toEqual(Object.keys(SERVER_STARTS).sort())
  })

  it('takes the hint before anything else: in entry-runtime.ts before BUN_BE_BUN goes, in main.ts before the CLI loads', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'src/lib/entry-runtime.ts'), 'utf8')
    expect(entry.indexOf('\nstartWithRamHint()')).toBeGreaterThan(0)
    expect(entry.indexOf('\nstartWithRamHint()')).toBeLessThan(entry.indexOf('\ndropBunBeBun()'))
    const main = fs.readFileSync(path.join(ROOT, 'src/binary/main.ts'), 'utf8')
    const hint = main.indexOf('startWithRamHint()')
    expect(hint).toBeGreaterThan(0)
    expect(hint).toBeLessThan(main.indexOf("import('../providers/in-process-daemon.js')).provideDaemonRuntime"))
    expect(hint).toBeLessThan(main.indexOf("await import('../cli.js')"))
  })

  it('imports nothing of Walnut, so it runs before every Walnut module', () => {
    const imports = fs.readFileSync(path.join(ROOT, 'src/lib/jsc-ram-hint.ts'), 'utf8').match(/^import .*$/gm) ?? []
    expect(imports).toEqual(["import os from 'node:os'"])
  })
})
