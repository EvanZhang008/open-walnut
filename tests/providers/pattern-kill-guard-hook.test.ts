/**
 * The PreToolUse hook that refuses a kill by a name pattern
 * (src/providers/pattern-kill-guard-hook.ts), run for real: the exact command
 * string Walnut puts in `--settings`, through every POSIX shell on this machine,
 * with the JSON a Claude Code PreToolUse hook receives on stdin. A refusal is a
 * `deny` decision on stdout (exit 0); an allowed command prints nothing.
 *
 * MACHINE SAFETY: nothing here kills anything; the hook only reads its stdin,
 * and the commands below are data in that JSON.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { guardedPath } from '../setup/exec-guard.js'
import { PATTERN_KILL_GUARD_COMMAND, patternSignalGuardHooks } from '../../src/providers/pattern-kill-guard-hook.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

function run(shell: string, command: string) {
  const input = JSON.stringify({
    session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
  })
  const r = spawnSync(shell, ['-c', PATTERN_KILL_GUARD_COMMAND], {
    input, encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: '/home/u' },
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

// The two 2026-10-31 incidents, as the session typed them.
const INCIDENT_1835 = 'sleep 5; pkill -f "clone.*playwright" 2>/dev/null; echo done'
const INCIDENT_1852 = [
  'M=/home/u/memory; python3 - <<EOF',
  "p='$M/note.md'",
  's=open(p).read()',
  "s+='''After a TaskStop I added `pkill -f \"clone.*playwright\"` to be sure.'''",
  "open(p,'w').write(s)",
  'EOF',
  'grep -n x $M/MEMORY.md',
].join('\n')

// [command, refused?]
const CASES: Array<[string, boolean]> = [
  [INCIDENT_1835, true],
  [INCIDENT_1852, true],
  ['pkill -f vite', true],
  ['pkill node', true],
  ['pkill -P 1234', true],
  ['killall Chromium', true],
  ['/usr/bin/pkill -f x', true],
  ['\\pkill x', true],
  ["'pkill' -f x", true],
  ['sudo -u root pkill -f x', true],
  ['env -i PATH=/bin pkill x', true],
  ['FOO=1 timeout 5 killall x', true],
  ['ls && pkill x', true],
  ['ls || killall x', true],
  ['(cd /a; pkill -f b)', true],
  ['{ pkill x; }', true],
  ['true | xargs pkill', true],
  ['echo "$(pkill -f x)"', true],
  ['echo `pkill -f x`', true],
  ['echo start\npkill -f x\necho end', true],
  ['pgrep -f vite | xargs kill', true],
  ['pgrep -f vite | xargs -I{} kill -9 {}', true],
  ['kill $(pgrep -f vite)', true],
  ['kill -9 `pgrep node`', true],
  ["bash -c 'pkill -f x'", true],
  ['sh -lc "killall x"', true],
  ["eval 'pkill x'", true],
  ["ssh devhost 'pkill -f claude'", true],
  ['ssh -p 22 devhost pkill -f claude', true],
  ['bash <<EOF\npkill -f x\nEOF', true],
  ["bash -s <<'EOF'\npkill -f x\nEOF", true],
  ['cat > /tmp/n.md <<EOF\nsee $(pkill x)\nEOF', true],
  // Shell keywords, pipes into a shell, expansions (found by review, 2026-10-31).
  ['if true; then pkill -f foo; fi', true],
  ['for p in a b; do pkill -f "$p"; done', true],
  ['while true; do killall node; done', true],
  ['! pkill -f x', true],
  ['if pgrep -f x; then kill $(pgrep -f x); fi', true],
  ['cat <<EOF | sh\npkill x\nEOF', true],
  ["echo 'pkill x' | bash", true],
  ['echo ${X:-$(pkill x)}', true],
  ["git commit -m \"$(cat <<'EOF'\nDon't\nEOF\n)\" && pkill -f foo", true],
  ['pids=$(pgrep -f vite); kill $pids', true],
  ['pgrep -f x 2>/dev/null | xargs kill', true],
  // Allowed: a kill by pid, lookups, and text that only names the tools.
  ['kill 12345', false],
  ['pgrep -fl playwright; kill 4242', false],
  ['pgrep -f vite && echo running; kill -0 $PID', false],
  ["git commit -m \"$(cat <<'EOF'\nDon't pkill by pattern\nEOF\n)\"", false],
  ['for f in a b; do echo $f; done', false],
  ['kill -- -12345', false],
  ['kill $!', false],
  ['kill $(lsof -tiTCP:35999 -sTCP:LISTEN)', false],
  ['pgrep -fl vite', false],
  ['ps -axo pid,command | grep pkill', false],
  ['grep -rn "pkill|killall" src', false],
  ["grep -n 'pkill -f' notes.md", false],
  ['which pkill', false],
  ['command -v pkill', false],
  ['man killall', false],
  ['echo "never use pkill by pattern"', false],
  ['git commit -m "fix: refuse a pkill by pattern"', false],
  ["cat > /tmp/n.md <<'EOF'\nNever run `pkill -f \"clone.*playwright\"`: it killed every session.\nEOF", false],
  ["python3 - <<'EOF'\nprint('pkill -f x')\nEOF", false],
  ['cat > n.md <<EOF\nNever use pkill by pattern.\nEOF', false],
  ['# pkill -f x would be wrong\nls', false],
  ['echo $((1 + 2)); ls', false],
  ['echo ${HOME}/pkill-notes', false],
  ['ls -la', false],
]

describe.each(SHELLS)('pattern kill guard under %s', (shell) => {
  it.each(CASES)('%j -> refused=%s', (command, refused) => {
    const r = run(shell, command)
    expect(r.status).toBe(0)
    if (refused) {
      expect(r.reason).toMatch(/^Walnut refused this command: it kills processes by a name pattern/)
      expect(r.reason).toContain('kill <pid>')
    } else {
      expect(r.stdout).toBe('')
    }
  })

  it('refuses a command too long to parse only when it names pkill or killall', () => {
    const big = 'cat > n.md <<EOF\n' + 'x'.repeat(120_000) + '\nEOF\n'
    expect(run(shell, big).stdout).toBe('')
    expect(run(shell, big + 'pkill -f x').reason).toMatch(/too long to check/)
  })

  it('answers a long command quickly', () => {
    const long = 'cat > n.md <<EOF\n' + 'word $(date) pgrep\n'.repeat(4000) + 'EOF\n'
    let t = Date.now()
    expect(run(shell, long + 'kill 1').stdout).toBe('')
    expect(Date.now() - t).toBeLessThan(5000)
    t = Date.now()
    expect(run(shell, long + 'pkill x').reason).toMatch(/name pattern \(pkill\)/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('patternSignalGuardHooks', () => {
  it('is a PreToolUse Bash hook, off with WALNUT_PATTERN_KILL_GUARD=0', () => {
    expect(patternSignalGuardHooks({})).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: PATTERN_KILL_GUARD_COMMAND, timeout: 10 }] }],
    })
    expect(patternSignalGuardHooks({ WALNUT_PATTERN_KILL_GUARD: '0' })).toBeNull()
  })
})
