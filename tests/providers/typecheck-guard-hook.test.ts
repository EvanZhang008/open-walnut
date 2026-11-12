/**
 * The PreToolUse hook that keeps type checks from piling up
 * (src/providers/typecheck-guard-hook.ts), run for real: the exact command
 * string Walnut puts in `--settings`, through every POSIX shell on this
 * machine, with the JSON a Claude Code PreToolUse hook receives on stdin. The
 * process table comes from a fixture file (WALNUT_TYPECHECK_PS_FILE) with the
 * session's CLI as pid 1000, except in the last block, which reads the real
 * `ps` around a stand-in type check this test starts and stops itself.
 *
 * MACHINE SAFETY: the hook only reads its stdin and the process table; the one
 * process started here is a sleeping script named tsc, stopped by its own pid.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { TYPECHECK_GUARD_COMMAND, TYPECHECK_SCRIPT_NAME, typecheckGuardHooks } from '../../src/providers/typecheck-guard-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'typecheck-guard-'))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

/** A `ps -ax -o pid= -o ppid= -o etime= -o command=` table; the session's CLI is pid 1000. */
const CLI = '1000     1   01:02:03 claude -p --output-format stream-json --verbose'
const OTHER_CLI = '2000     1   01:02:03 claude -p --output-format stream-json --verbose'
const OWN_TSC = [
  ' 1100  1000      35:28 /bin/zsh -c cd web && node_modules/.bin/tsc --noEmit -p tsconfig.json > /tmp/t.log 2>&1',
  ' 1101  1100      35:27 node node_modules/.bin/tsc --noEmit -p tsconfig.json',
]
const otherTsc = (pid: number, cmd = 'node ../node_modules/.bin/tsc --noEmit -p tsconfig.json') => [
  ` ${pid}  2000      12:00 /bin/zsh -c ${cmd}`,
  ` ${pid + 1}  ${pid}      11:59 ${cmd}`,
]

let seq = 0
function psFile(lines: string[]): string {
  const f = path.join(TMP, `ps-${++seq}.txt`)
  fs.writeFileSync(f, lines.join('\n') + '\n')
  return f
}

function run(shell: string, command: string, ps: string[] | null, env: Record<string, string> = {}) {
  const input = JSON.stringify({
    session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u/repo', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
  })
  const r = spawnSync(shell, ['-c', TYPECHECK_GUARD_COMMAND], {
    input,
    encoding: 'utf8',
    env: {
      PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u',
      WALNUT_TYPECHECK_ROOT_PID: '1000', WALNUT_TYPECHECK_MAX: '3',
      ...(ps ? { WALNUT_TYPECHECK_PS_FILE: psFile(ps) } : {}),
      ...env,
    },
  })
  let reason = ''
  if (r.stdout) {
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    reason = out.hookSpecificOutput.permissionDecisionReason
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, reason }
}

// Commands that start a type check (refused while the session runs one) and ones that do not.
const STARTS: string[] = [
  'tsc',
  'tsc --noEmit',
  'npx tsc --noEmit -p web/tsconfig.json',
  'bun x tsc --noEmit',
  'bunx vue-tsc --noEmit',
  'tsgo --noEmit',
  './node_modules/.bin/tsc --noEmit -p tsconfig.json',
  'cd /home/u/repo/web && ../node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | head -40; echo "exit $?"',
  'node node_modules/typescript/lib/tsc.js -p .',
  'bun run lint',
  'npm run typecheck',
  'pnpm run type-check',
  'yarn lint:plugins',
  'bun typecheck',
  'npm exec tsc -- --noEmit',
  'nice -n 5 tsc --noEmit',
  'timeout 600 bun run lint',
  'env FORCE_COLOR=0 tsc -p .',
  'NODE_OPTIONS=--max-old-space-size=8192 tsc -p .',
  '(cd web && bun x tsc --noEmit 2>&1 | head -40; echo TSC_DONE)',
  'echo start\ntsc --noEmit > /tmp/out.txt 2>&1',
  'if true; then tsc -p .; fi',
  'bun run tsc',
  'npm run tsc -- -p web',
  'bun --cwd web run lint',
  'pnpm --filter web run lint',
  'npm --prefix web run lint',
  'bash -c "tsc --noEmit"',
  "timeout 600 sh -c 'cd web && tsc -p .'",
  "zsh -lc 'bun x tsc --noEmit | head'",
  'if tsc -p a; then echo ok; fi',
  'while ! tsc; do sleep 1; done',
]
const DOES_NOT: string[] = [
  'git grep -n tsc -- src',
  'grep -rn "tsc --noEmit" package.json',
  'echo "run tsc later"',
  "printf '%s' 'tsc --noEmit'",
  'cat tsconfig.json',
  'bun run test',
  'bun run build',
  'npm run lint-staged-report',
  'cat > notes.md <<EOF\ntsc --noEmit\nbun run lint\nEOF',
  'git commit -m "fix tsc errors in lint"',
  'node scripts/check.mjs --tsc',
  'ls node_modules/.bin/tsc',
  'vitest run tests/typecheck/x.test.ts',
  'command -v tsc',
  'tsc --version',
  'npx tsc -v',
  'bun x tsc --version',
  'node node_modules/.bin/tsc --help',
  'tsc --help',
  'which tsc',
  'bash -c "echo tsc is slow"',
  'sh -c ls',
]

describe.each(SHELLS)('type check guard under %s', (shell) => {
  it.each(STARTS)('refuses a second type check of the same session: %s', (command) => {
    const r = run(shell, command, [CLI, OTHER_CLI, ...OWN_TSC])
    expect(r.status).toBe(0)
    expect(r.reason).toMatch(/^Walnut refused this command: a type check this session started is still running \(pid 1101, running 35:27: node node_modules\/.bin\/tsc --noEmit -p tsconfig.json\)/)
    expect(r.reason).toContain('kill 1101')
  })

  it.each(DOES_NOT)('never reads %s as a type check', (command) => {
    const r = run(shell, command, [CLI, ...OWN_TSC, OTHER_CLI, ...otherTsc(3000), ...otherTsc(3100), ...otherTsc(3200)])
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })

  it('allows the first type check of a session', () => {
    expect(run(shell, 'tsc --noEmit', [CLI, OTHER_CLI]).stdout).toBe('')
  })

  it('allows a type check beside other sessions\' runs below the machine count', () => {
    expect(run(shell, 'tsc --noEmit', [CLI, OTHER_CLI, ...otherTsc(3000), ...otherTsc(3100)]).stdout).toBe('')
  })

  it('refuses one more type check once the machine runs its count, listing the runs', () => {
    const r = run(shell, 'bun run lint', [CLI, OTHER_CLI, ...otherTsc(3000), ...otherTsc(3100), ...otherTsc(3200)])
    expect(r.reason).toMatch(/^Walnut refused this command: this machine already runs 3 type checks, as many as its memory holds \(3; /)
    expect(r.reason).toContain('pid 3001 (11:59)')
    expect(r.reason).toContain('pid 3201 (11:59)')
    expect(r.reason).toContain('Do not stop runs other tasks started')
  })

  it('counts a wrapper and the type check it starts once', () => {
    // bun run lint -> tsc, and bun x tsc -> node tsc: two runs, not four.
    const ps = [CLI, OTHER_CLI,
      ' 3000  2000      05:00 bun run lint', ' 3001  3000      04:59 node /r/node_modules/.bin/tsc --noEmit',
      ' 3100  2000      05:00 bun x tsc --noEmit', ' 3101  3100      04:59 node /r/node_modules/typescript/bin/tsc --noEmit',
      // A script runs its steps through a shell: bun run lint:plugins -> bash -c ... -> tsc is still one run.
      ' 3200  3000      04:00 bun run lint:plugins', ' 3201  3200      04:00 /bin/bash -c bun run build:plugins && tsc --noEmit -p a',
      ' 3202  3201      00:10 node /r/node_modules/.bin/tsc --noEmit -p a']
    expect(run(shell, 'tsc -p .', ps).stdout).toBe('')
    expect(run(shell, 'tsc -p .', ps, { WALNUT_TYPECHECK_MAX: '2' }).reason).toMatch(/already runs 2 type checks/)
  })

  it('does not count an editor\'s tsserver or a command that only names tsc', () => {
    const ps = [CLI, OTHER_CLI,
      ' 3000  2000      05:00 node /r/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot',
      ' 3100  2000      05:00 grep tsc',
      ' 3200  2000      05:00 /bin/zsh -c git grep tsc',
      ' 3300  1000      05:00 less tsconfig.json']
    expect(run(shell, 'tsc -p .', ps, { WALNUT_TYPECHECK_MAX: '1' }).stdout).toBe('')
  })

  it('reads the machine count from its memory: one per 16 GB, at least 2, and 0 turns it off', () => {
    const three = [CLI, OTHER_CLI, ...otherTsc(3000), ...otherTsc(3100), ...otherTsc(3200)]
    const two = [CLI, OTHER_CLI, ...otherTsc(3000), ...otherTsc(3100)]
    const GB = 1024 ** 3
    expect(run(shell, 'tsc', three, { WALNUT_TYPECHECK_MAX: '', WALNUT_TYPECHECK_MEM_BYTES: String(48 * GB) }).reason).toMatch(/already runs 3 type checks/)
    expect(run(shell, 'tsc', two, { WALNUT_TYPECHECK_MAX: '', WALNUT_TYPECHECK_MEM_BYTES: String(48 * GB) }).stdout).toBe('')
    expect(run(shell, 'tsc', two, { WALNUT_TYPECHECK_MAX: '', WALNUT_TYPECHECK_MEM_BYTES: String(8 * GB) }).reason).toMatch(/already runs 2 type checks/)
    expect(run(shell, 'tsc', three, { WALNUT_TYPECHECK_MAX: '0' }).stdout).toBe('')
    // The own-session rule holds with no machine count.
    expect(run(shell, 'tsc', [CLI, ...OWN_TSC], { WALNUT_TYPECHECK_MAX: '0' }).reason).toMatch(/this session started/)
  })

  it('WALNUT_TYPECHECK_GUARD=0 in the session turns it off', () => {
    expect(run(shell, 'tsc', [CLI, ...OWN_TSC], { WALNUT_TYPECHECK_GUARD: '0' }).stdout).toBe('')
  })

  it('fails open: no process table, a missing awk, or a table it cannot read', () => {
    expect(run(shell, 'tsc', null, { WALNUT_TYPECHECK_PS_FILE: path.join(TMP, 'missing.txt') }).stdout).toBe('')
    const r = run(shell, 'tsc', [CLI, ...OWN_TSC], { PATH: guardedPath([], '/nonexistent') })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
    expect(run(shell, 'tsc', ['garbage line', 'x y z']).stdout).toBe('')
  })

  it('a command line with quotes and backslashes still yields valid JSON', () => {
    const ps = [CLI, ' 1100  1000      01:00 /bin/zsh -c tsc -p "a\\b" \'c\'', ' 1101  1100      00:59 tsc -p "a\\b"']
    expect(run(shell, 'tsc', ps).reason).toMatch(/pid 1101, running 00:59: tsc -p "a\\b"\)/)
  })

  it('a control character in a running command line still yields valid JSON', () => {
    const ps = [CLI, ' 1100  1000      01:00 tsc -p a \u001b[1m bold \u0007']
    expect(run(shell, 'tsc', ps).reason).toMatch(/pid 1100, running 01:00: tsc -p a  \[1m bold/)
  })

  it('stays fast on a long command that names no type check', () => {
    const t0 = Date.now()
    expect(run(shell, 'echo ' + 'a'.repeat(200_000), [CLI, ...OWN_TSC]).stdout).toBe('')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})

describe('the real process table', () => {
  it('refuses while a type check this process started runs, and allows once it stopped', async () => {
    // A stand-in tsc: this runtime running a sleeping script named tsc, as `node .../tsc` shows in ps.
    const bin = path.join(TMP, 'bin'); fs.mkdirSync(bin, { recursive: true })
    const script = path.join(bin, 'tsc'); fs.writeFileSync(script, 'setTimeout(() => {}, 60000)\n')
    const child = spawn(process.execPath, [script], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 300))
      const shown = execFileSync('ps', ['-o', 'command=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()
      expect(path.basename(shown.split(/\s+/)[0])).toMatch(/^(node|bun|nodejs)$/)
      const r = run(SHELLS[0], 'tsc --noEmit', null, { WALNUT_TYPECHECK_ROOT_PID: String(process.pid), WALNUT_TYPECHECK_MAX: '0' })
      expect(r.reason).toContain(`pid ${child.pid}`)
    } finally {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
    expect(run(SHELLS[0], 'tsc --noEmit', null, { WALNUT_TYPECHECK_ROOT_PID: String(process.pid), WALNUT_TYPECHECK_MAX: '0' }).stdout).toBe('')
  })
})

describe('typecheckGuardHooks', () => {
  it('is a PreToolUse hook on Bash in every session\'s settings, off with WALNUT_TYPECHECK_GUARD=0', () => {
    const hooks = typecheckGuardHooks({}) as { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    expect(hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: TYPECHECK_GUARD_COMMAND })
    expect(typecheckGuardHooks({ WALNUT_TYPECHECK_GUARD: '0' })).toBeNull()
    const all = JSON.stringify(sessionSettingsHooks({}))
    expect(all).toContain(JSON.stringify(TYPECHECK_GUARD_COMMAND).slice(1, 80))
    expect(JSON.stringify(sessionSettingsHooks({ WALNUT_TYPECHECK_GUARD: '0' }))).not.toContain('a type check this session started')
  })

  it('carries no personal path or user name', () => {
    expect(TYPECHECK_GUARD_COMMAND).not.toMatch(/\/Users\/|\/home\/[a-z]/)
  })
})

/**
 * The class guard: every package script in this repository that runs the type
 * checker is one the hook reads as a type check by its name, or listed here
 * with why not. A new script that runs tsc under another name fails until it
 * is one or the other.
 */
const NOT_A_CHECK: Record<string, string> = {
  'desktop-windows/package.json#dist': 'a release build; its tsc still counts toward the machine count while it runs',
  'infra/package.json#build': 'the infra stack build; its tsc still counts toward the machine count while it runs',
  'web/package.json#build': 'the web bundle build (tsc -b then vite); its tsc still counts toward the machine count',
}

describe('every package script that runs the type checker', () => {
  it('is read as a type check by its name, or listed as a build', () => {
    const files = execFileSync('git', ['ls-files', '*package.json'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })
      .split('\n').filter((f) => f && !f.includes('node_modules'))
    const found: string[] = []
    for (const f of files) {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', f), 'utf8')) as { scripts?: Record<string, string> }
      for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
        if (!/(^|[\s&|;(/])(tsc|vue-tsc|tsgo)(\s|$)/.test(body)) continue
        found.push(`${f}#${name}`)
      }
    }
    expect(found.length).toBeGreaterThan(5)
    const unread = found.filter((k) => !TYPECHECK_SCRIPT_NAME.test(k.split('#')[1]) && !(k in NOT_A_CHECK))
    expect(unread).toEqual([])
    // A listed build that is gone or renamed leaves the list too.
    expect(Object.keys(NOT_A_CHECK).filter((k) => !found.includes(k))).toEqual([])
  })
})
