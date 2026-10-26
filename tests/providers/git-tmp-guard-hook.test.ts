/**
 * The PreToolUse hook that refuses a session's own git clone / worktree add /
 * commit in a temp directory (src/providers/git-tmp-guard-hook.ts), run for
 * real: the exact command string Walnut puts in `--settings`, through every
 * POSIX shell on this machine (macOS: bash-as-sh; CI: dash), with the JSON a
 * Claude Code PreToolUse hook receives on stdin. A refusal is a `deny`
 * decision on stdout (exit 0); an allowed command prints nothing.
 *
 * MACHINE SAFETY: nothing here runs git; the hook only reads its stdin.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { GIT_TMP_GUARD_COMMAND, gitTmpGuardHooks } from '../../src/providers/git-tmp-guard-hook.js'

const TASK_DIR = '/home/u/.local/state/open-walnut/tasks/T1'
const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

function run(shell: string, command: string, cwd: string, env: Record<string, string> = {}) {
  const input = JSON.stringify({
    session_id: 's', transcript_path: '/x.jsonl', cwd, permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
  })
  const r = spawnSync(shell, ['-c', GIT_TMP_GUARD_COMMAND], {
    input,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/home/u', TMPDIR: '/var/folders/ab/T/', WALNUT_TASK_DIR: TASK_DIR, ...env },
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

// [command, cwd, refused?]
const CASES: Array<[string, string, boolean]> = [
  // Refused: the agent's own work placed in a temp dir.
  ['git clone https://github.com/acme/app.git /tmp/app', '/home/u', true],
  ['git clone https://github.com/acme/app.git', '/tmp', true],
  ['git clone git@github.com:acme/app.git /private/tmp/app', '/home/u', true],
  ['git clone --depth 1 -b main https://x/y.git $TMPDIR/y', '/home/u', true],
  ['git clone --branch=main https://x/y.git "${TMPDIR}y"', '/home/u', true],
  ['git clone /home/u/repo ../app', '/tmp/work', true],
  ['cd /tmp/x && git commit -m hi', '/home/u', true],
  ['cd /tmp/x; git add -A; git commit -am "wip"', '/home/u', true],
  ['git -C /tmp/x commit -m hi', '/home/u', true],
  ['git -c user.name=a commit -m b', '/tmp/r', true],
  ['ls && git commit -m x', '/private/tmp/r', true],
  ['git worktree add /tmp/wt -b feature', '/home/u/repo', true],
  ['git worktree add -B f /var/folders/ab/T/wt', '/home/u/repo', true],
  ['FOO=1 git clone https://x/y.git /tmp/y', '/home/u', true],
  ['(cd /tmp/x && git commit -m a)', '/home/u', true],
  ['echo start\ngit clone https://x/y.git /tmp/y\necho done', '/home/u', true],
  // Allowed: durable places, the task dir itself, temp-to-temp scratch, data that only mentions git.
  ['git clone https://x/y.git /home/u/work/y', '/tmp', false],
  ['git clone https://x/y.git $WALNUT_TASK_DIR/y', '/tmp', false],
  ['git clone https://x/y.git y', TASK_DIR, false],
  [`cd ${TASK_DIR}/y && git commit -m ok`, '/tmp', false],
  ['git clone /tmp/bare.git /tmp/work', '/home/u', false],
  ['git clone ./fixture.git copy', '/tmp/scratch', false],
  ['git commit -m "fix /tmp handling"', '/home/u/repo', false],
  ['git status', '/tmp/x', false],
  ['git log --oneline', '/tmp/x', false],
  ['echo "git clone a /tmp/b"', '/home/u', false],
  ["printf '%s' 'cd /tmp/x && git commit'", '/home/u', false],
  ['cat > run.sh <<EOF\ncd /tmp/x && git commit -m y\nEOF\nchmod +x run.sh', '/home/u', false],
  ["cat > run.sh <<'EOS'\ngit clone u /tmp/z\nEOS", '/home/u', false],
  ['git clone x "$OTHER/dir"', '/home/u', false],
  ['git worktree add ../wt', '/tmp/repo', false],
  ['git worktree list', '/home/u/repo', false],
  ['npm test', '/tmp/x', false],
  ['git clone https://x/y.git /tmpfoo/y', '/home/u', false],
  // A subshell's cd ends with it; cd -, popd and unknown targets leave the directory unknown.
  ['(cd /tmp/x && make); git commit -m m', '/home/u/repo', false],
  ['cd /tmp/b && make && cd - && git commit -am x', '/home/u/repo', false],
  ['pushd /tmp/x; ls; popd; git commit -m y', '/home/u/repo', false],
  // A variable the same command set is followed, mktemp included (2026-10-26: a
  // live session's first way around the guard was this exact mktemp + cd "$d").
  ['d=$(mktemp -d /tmp/probe.XXXX) && cd "$d" && git init -q && git commit -qm x', '/home/u', true],
  ['d="$(mktemp -d)"; git -C "$d" commit -m x', '/home/u', true],
  ['d=`mktemp -d`; cd $d && git commit -m a', '/home/u', true],
  ['git clone x $(mktemp -d)', '/home/u', true],
  ['cd "$(mktemp -d -t probe)" && git commit -m z', '/home/u', true],
  ['D=/tmp/w; git clone https://x/y.git $D/y', '/home/u', true],
  ['export D=/tmp/w && git clone u "${D}/y"', '/home/u', true],
  ['D=w; cd $D && git commit -m a', '/tmp', true],
  ['d=$(mktemp -d "$WALNUT_TASK_DIR/x.XXXX"); cd $d && git commit -m y', '/home/u', false],
  ['d=$(mktemp -d -p /home/u/scratch); cd $d && git commit -m a', '/home/u', false],
  ['D=/home/u/w; cd $D && git commit -m a', '/tmp', false],
  ['D=$(pwd); cd $D && git commit -m a', '/home/u', false],
  ['D=/tmp/w; D=$(git rev-parse --show-toplevel); cd $D && git commit -m a', '/home/u', false],
  ['D=/tmp/w; cd $DX && git commit -m a', '/home/u', false],
  ['DIR=/tmp/w git clone u y', '/home/u', false],
  // A commit message written the way Claude Code writes one.
  ['git commit -m "$(cat <<\'EOF\'\nfix: keep clones out of /tmp\n\nCo-Authored-By: x\nEOF\n)"', '/home/u/repo', false],
]

describe.each(SHELLS)('git /tmp guard under %s', (shell) => {
  it.each(CASES)('%j in %s → refused=%s', (command, cwd, refused) => {
    const r = run(shell, command, cwd)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).toBe('')
    if (refused) {
      expect(r.reason).toContain('Walnut refused this command')
      // The refusal names where the work goes instead.
      expect(r.reason).toContain(TASK_DIR)
    } else {
      expect(r.stdout).toBe('')
    }
  })

  it('a path with a quote still yields valid JSON', () => {
    expect(run(shell, 'git clone https://x/y.git "/tmp/a\\"b"', '/home/u').reason).toContain('/tmp/a"b')
  })

  it('treats /private/var and /var as the same place (a task dir under the macOS temp dir)', () => {
    const td = '/private/var/folders/ab/T/run/tasks/T2'
    expect(run(shell, 'git clone https://x/y.git /var/folders/ab/T/run/tasks/T2/y', '/home/u', { WALNUT_TASK_DIR: td }).stdout).toBe('')
    expect(run(shell, 'git clone https://x/y.git /private/var/folders/ab/T/other/y', '/home/u', { WALNUT_TASK_DIR: td }).reason).toContain('Walnut refused')
  })

  it('a backslash in a path still yields valid JSON', () => {
    expect(run(shell, "git clone https://x/y.git '/tmp/a\\b'", '/home/u').reason).toMatch(/\/tmp\/a\\b/)
  })

  it('a missing awk (or one that fails) allows the command', () => {
    const r = run(shell, 'git clone https://x/y.git /tmp/y', '/home/u', { PATH: '/nonexistent' })
    expect(r.stdout).toBe('')
    expect(r.status).toBe(0)
  })

  it('allows everything when the session has no task directory (an older daemon)', () => {
    const r = run(shell, 'git clone https://x/y.git /tmp/y', '/home/u', { WALNUT_TASK_DIR: '' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('stays fast on a long command that names no guarded subcommand', () => {
    const long = 'echo ' + 'a'.repeat(200_000)
    const t0 = Date.now()
    expect(run(shell, long, '/tmp').stdout).toBe('')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})

describe('gitTmpGuardHooks', () => {
  it('is a PreToolUse hook on Bash, off with WALNUT_TMP_GIT_GUARD=0', () => {
    const hooks = gitTmpGuardHooks({}) as { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> }
    expect(hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: 'command', command: GIT_TMP_GUARD_COMMAND })
    expect(gitTmpGuardHooks({ WALNUT_TMP_GIT_GUARD: '0' })).toBeNull()
  })

  it('carries no personal path or user name', () => {
    expect(GIT_TMP_GUARD_COMMAND).not.toMatch(/\/Users\/|\/home\/[a-z]/)
  })
})
