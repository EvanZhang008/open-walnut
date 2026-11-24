/**
 * The session's spawn preamble (session-shell.ts): run in real shells, the host's shell_setup
 * exports what it sets, prints nothing to the session's stdout, reads nothing of its stdin, and
 * a setup that fails, does not parse, or calls `exit` or `return` never stops the command after
 * it, in every shell a session can start in (bash run as sh, in POSIX mode, included). The
 * preamble names the setup's file and never holds its text. And the guard: the daemon's spawn
 * and host.preflight build the preamble from one function.
 *
 * MACHINE SAFETY: each shell runs a short `-c` script with HOME in a temp dir; nothing else.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildSessionPreamble, createShellSetupStore, runsAsShell, shellSetupStep } from '../../src/providers/session-shell.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-session-shell-')))
afterAll(() => { if (root.includes('walnut-session-shell-')) fs.rmSync(root, { recursive: true, force: true }) })
const BASH = ['/bin/bash', '/usr/bin/bash'].find((s) => fs.existsSync(s))
/** A `sh` that is bash, as /bin/sh is on some distributions: bash runs it in POSIX mode. */
const SH_AS_BASH = BASH ? path.join(root, 'bin-sh-is-bash', 'sh') : undefined
if (BASH && SH_AS_BASH) { fs.mkdirSync(path.dirname(SH_AS_BASH)); fs.symlinkSync(BASH, SH_AS_BASH) }
const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh', '/usr/bin/zsh', ...(SH_AS_BASH ? [SH_AS_BASH] : [])].filter((s) => fs.existsSync(s))

/** Run `<preamble>; <tail>` in `shell` with SHELL set to it, stdin given, and return stdout. */
function run(shell: string, setup: string, tail: string, opts: { input?: string; rc?: string; args?: string[] } = {}): string {
  const home = fs.mkdtempSync(path.join(root, 'home-'))
  if (opts.rc !== undefined) for (const rc of ['.bashrc', '.zshrc']) fs.writeFileSync(path.join(home, rc), opts.rc)
  const setupFile = path.join(home, 'setup')
  if (setup) fs.writeFileSync(setupFile, setup, { mode: 0o600 })
  const script = buildSessionPreamble({ shimDir: path.join(root, 'shim'), shellSetupFile: setup ? setupFile : '', fallbackPathStep: 'export PATH="$PATH:' + path.join(root, 'shim') + '"' }) + '; ' + tail
  return execFileSync(shell, [...(opts.args ?? []), '-c', script], {
    input: opts.input ?? 'the-first-line\n', encoding: 'utf8', timeout: 10_000,
    env: { PATH: '/usr/bin:/bin', HOME: home, SHELL: shell },
    stdio: ['pipe', 'pipe', 'ignore'],
  })
}

describe.each(SHELLS)('the preamble in %s', (shell) => {
  it('keeps what shell_setup exports, without its stdout or the stdin the CLI reads', () => {
    const out = run(shell, 'export SETUP_VAR=set; echo setup-noise; read -r stolen; export STOLEN="$stolen"',
      'read -r first; printf "%s|%s|%s" "$SETUP_VAR" "${STOLEN-}" "$first"')
    expect(out).toBe('set||the-first-line')
  })

  it('a setup that fails or does not parse never stops what follows', () => {
    expect(run(shell, 'false', 'echo after')).toBe('after\n')
    expect(run(shell, '. /nonexistent/env.sh', 'echo after')).toBe('after\n')
    expect(run(shell, 'if then (', 'echo after')).toBe('after\n')
    expect(run(shell, "it's unbalanced \"", 'echo after')).toBe('after\n')
  })

  it('an `exit` or `return` ends the setup alone, and what it exported before stays', () => {
    expect(run(shell, 'export A=1; exit 3; export B=2', 'echo "after ${A-}${B-}"')).toBe('after 1\n')
    expect(run(shell, 'export A=1; return 3; export B=2', 'echo "after ${A-}${B-}"')).toBe('after 1\n')
    expect(run(shell, '[ -n "${NOT_SET-}" ] || exit 0; export B=2', 'echo "after ${B-none}"')).toBe('after none\n')
    // The alias is gone once the setup has run.
    expect(run(shell, 'export A=1', 'alias exit >/dev/null 2>&1 && echo still || echo gone')).toBe('gone\n')
  })

  it('a setup that turns errexit on never ends the start, and errexit is off after it', () => {
    // bash 4.2 (AL2, CentOS 7) ended the shell here inside eval, `|| true` or not (2026-11-24 review).
    expect(run(shell, 'set -e; false; export B=1', 'false; echo "after ${B-none}"')).toBe('after 1\n')
    expect(run(shell, 'set -o errexit; false', 'false; echo after')).toBe('after\n')
    expect(run(shell, 'set -eu; export B=1', 'false; echo "after $B"')).toBe('after 1\n')
  })

  it('no setup: nothing of it runs', () => {
    expect(buildSessionPreamble({ shimDir: '/x', fallbackPathStep: 'export PATH="$PATH:/x"' })).not.toContain('__walnut_eval')
    expect(run(shell, '', 'echo "${__walnut_eval-none}"')).toBe('none\n')
  })
})

describe.runIf(!!BASH)('bash in POSIX mode (bash --posix)', () => {
  it('a setup that does not parse or exits never stops what follows', () => {
    expect(run(BASH!, 'if then (', 'echo after', { args: ['--posix'] })).toBe('after\n')
    expect(run(BASH!, 'export A=1; exit 3', 'echo "after $A"', { args: ['--posix'] })).toBe('after 1\n')
    expect(run(BASH!, 'set -e; false; export B=1', 'false; echo "after ${B-none}"', { args: ['--posix'] })).toBe('after 1\n')
  })
})

describe('the rc files', () => {
  const RC_SHELLS = ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/zsh'].filter((s) => fs.existsSync(s))
  it.each(RC_SHELLS)('%s sources its rc file with no stdin: the first message stays the CLI\'s', (shell) => {
    const out = run(shell, '', 'read -r first; printf "%s|%s|%s" "${RC_VAR-}" "${RC_STOLE-}" "$first"',
      { rc: 'export RC_VAR=rc; read -r stole; export RC_STOLE="$stole"' })
    expect(out).toBe('rc||the-first-line')
  })
})

describe('shell_setup step', () => {
  it('comes after the rc files and before the fallback dirs, and the gateway shim stays last', () => {
    const text = buildSessionPreamble({ shimDir: '/s', shellSetupFile: '/state/setup', gatewayFirst: true, fallbackPathStep: 'export PATH="$PATH:$HOME/.local/bin:/s"' })
    const rc = text.indexOf('.zshrc')
    const setup = text.indexOf(shellSetupStep('/state/setup'))
    const fallback = text.indexOf('$HOME/.local/bin')
    expect(rc).toBeGreaterThanOrEqual(0)
    expect(setup).toBeGreaterThan(rc)
    expect(fallback).toBeGreaterThan(setup)
    expect(text.endsWith("export PATH=/s:\"$PATH\"")).toBe(true)
  })

  it('names the file, quoted, and never holds the setup text (argv shows in ps)', () => {
    const step = shellSetupStep("/state/it's here/setup")
    expect(step).toContain(`cat -- '/state/it'\\''s here/setup'`)
    // A store that holds a token answers the file; the preamble built from it names only the file.
    const store = createShellSetupStore({ fs, path, crypto, dir: path.join(root, 'store-argv') })
    const file = store.remember('w1', 'export SECRET_TOKEN=abc123')
    const text = buildSessionPreamble({ shimDir: '/s', shellSetupFile: file, fallbackPathStep: ':' })
    expect(text).toContain(file)
    expect(text).not.toContain('abc123')
  })
})

describe('runsAsShell', () => {
  it('an executable regular file runs; a directory (X_OK too), a missing or plain file does not', () => {
    const dir = fs.mkdtempSync(path.join(root, 'shells-'))
    const exe = path.join(dir, 'myshell')
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 })
    const plain = path.join(dir, 'plain')
    fs.writeFileSync(plain, '', { mode: 0o644 })
    expect(runsAsShell(fs, exe)).toBe(true)
    expect(runsAsShell(fs, dir)).toBe(false)
    expect(runsAsShell(fs, plain)).toBe(false)
    expect(runsAsShell(fs, path.join(dir, 'gone'))).toBe(false)
  })
})

describe('the shell_setup store', () => {
  it('keeps one private file per Walnut, answers its path, and an empty setup removes it', () => {
    const dir = path.join(root, 'store')
    const store = createShellSetupStore({ fs, path, crypto, dir })
    expect(store.recall('w1')).toBe('')
    const f1 = store.remember('w1', '  export A=1  ')
    expect(path.dirname(f1)).toBe(dir)
    expect(fs.readFileSync(f1, 'utf8')).toBe('export A=1')
    const f2 = store.remember('w2', 'export B=2')
    expect(f2).not.toBe(f1)
    expect(store.remember('w1', 'export A=1')).toBe(f1)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    for (const f of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, f)).mode & 0o777).toBe(0o600)
    // A new daemon reads them back.
    const again = createShellSetupStore({ fs, path, crypto, dir })
    expect([again.recall('w1'), again.recall('w2')]).toEqual([f1, f2])
    expect(again.remember('w1', '')).toBe('')
    expect(createShellSetupStore({ fs, path, crypto, dir }).recall('w1')).toBe('')
    expect(fs.readdirSync(dir)).toHaveLength(1)
  })

  it('a write that fails answers no file, so the old setup never runs in its place', () => {
    const dir = path.join(root, 'store-fail')
    const store = createShellSetupStore({ fs, path, crypto, dir })
    store.remember('w1', 'export OLD=1')
    const failing = { ...fs, writeFileSync: () => { throw new Error('disk full') } } as unknown as typeof fs
    const warns: string[] = []
    const broken = createShellSetupStore({ fs: failing, path, crypto, dir, log: (_l, msg) => warns.push(msg) })
    expect(broken.remember('w1', 'export NEW=1')).toBe('')
    expect(warns).toHaveLength(1)
  })

  it("preflight's scratch file is private and gone after remove", () => {
    const dir = path.join(root, 'store-scratch')
    const store = createShellSetupStore({ fs, path, crypto, dir })
    expect(store.scratch('   ')).toBeNull()
    const held = store.scratch('export T=1')!
    expect(fs.readFileSync(held.file, 'utf8')).toBe('export T=1')
    expect(fs.statSync(held.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(held.file)).mode & 0o777).toBe(0o700)
    held.remove()
    expect(fs.existsSync(path.dirname(held.file))).toBe(false)
    expect(fs.readdirSync(dir)).toEqual([])
  })
})

describe('one preamble for the spawn and host.preflight', () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, '../../src/providers', f), 'utf8')
  const code = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

  it('the daemon hands host.preflight the builder its spawns use, with the shell_setup in it', () => {
    const daemon = code(src('daemon-standalone.ts'))
    expect(daemon).toContain('spawnPreamble: (shellSetupFile) => buildSpawnPreamble({ shellSetupFile }),')
    expect(daemon).toContain('shellSetupFile: (setup) => shellSetupStore.scratch(setup),')
    expect(daemon).toContain('sessionShell: () => sessionShell(),')
    // buildSpawnPreamble is buildSessionPreamble, and every spawn-side use passes the start's setup file.
    expect(daemon).toMatch(/function buildSpawnPreamble\([^)]*\): string \{\n\s*return buildSessionPreamble\(/)
    const uses = [...daemon.matchAll(/buildSpawnPreamble\(([^\n]*)\)/g)].map((m) => m[1]).filter((a) => !a.startsWith('o:'))
    expect(uses.length).toBeGreaterThanOrEqual(3)
    for (const a of uses) expect(a).toMatch(/shellSetupFile/)
  })

  it('host.preflight runs shell_setup only through that preamble', () => {
    const core = code(src('host-runtime-core.ts'))
    expect(core).not.toMatch(/'\{ ' \+ setup/)
    expect(core).not.toMatch(/\beval\b[^\n]*setup/)
    // The preamble gets the setup's file, never its text.
    const sends = [...core.matchAll(/deps\.spawnPreamble\(([^)]*)\)/g)].map((m) => m[1])
    expect(sends).toEqual(['setupFile', 'setupFile'])
    expect(core).toContain('deps.shellSetupFile(setup)')
  })

  it('no other module builds a session preamble or runs a shell_setup', () => {
    const files = fs.readdirSync(path.resolve(__dirname, '../../src/providers')).filter((f) => f.endsWith('.ts') && f !== 'session-shell.ts')
    for (const f of files) {
      const text = code(src(f))
      expect(text, f).not.toMatch(/\bshellSetupStep\(/)
      expect(text, f).not.toMatch(/\. "\$HOME\/\.(zshrc|bashrc)"/)
    }
  })
})
