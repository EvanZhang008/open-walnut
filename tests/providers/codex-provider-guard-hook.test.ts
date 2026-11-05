/**
 * The PreToolUse hook that refuses a Codex model run with no model provider
 * override (src/providers/codex-provider-guard-hook.ts), run for real: the
 * exact command string Walnut puts in `--settings`, through every POSIX shell on
 * this machine, with the JSON a Claude Code PreToolUse hook receives on stdin. A
 * refusal is a `deny` decision on stdout (exit 0); an allowed command prints
 * nothing.
 *
 * MACHINE SAFETY: nothing here runs codex; the hook only reads its stdin, and
 * the commands below are data in that JSON.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { guardedPath } from '../setup/exec-guard.js'
import { CODEX_PROVIDER_GUARD_COMMAND, codexProviderGuardHooks } from '../../src/providers/codex-provider-guard-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))

function payload(command: string): string {
  return JSON.stringify({
    session_id: 's', transcript_path: '/x.jsonl', cwd: '/home/u', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, tool_use_id: 't',
  })
}

function runRaw(shell: string, input: string) {
  const r = spawnSync(shell, ['-c', CODEX_PROVIDER_GUARD_COMMAND], {
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

const run = (shell: string, command: string) => runRaw(shell, payload(command))

// [command, refused?]
const CASES: Array<[string, boolean]> = [
  // Model runs with no provider override.
  ['codex exec "review this diff"', true],
  ['codex exec -m gpt-5 --full-auto "x"', true],
  ['codex e "x"', true],
  ['codex review', true],
  ['codex review --uncommitted', true],
  ['codex', true],
  ['codex "fix the failing test"', true],
  ['codex resume --last', true],
  ['codex exec resume --last', true],
  ['codex app-server', true],
  ['codex exec --profile proxy "x"', true],
  // An override that is not the provider, empty, or before the subcommand.
  ['codex -c model_provider=myproxy exec "x"', true],
  ['codex --config model_provider=myproxy review', true],
  ['codex exec -c model="gpt-5" "x"', true],
  ['codex exec -c model_provider= "x"', true],
  ['codex exec -c \'model_provider=""\' "x"', true],
  ['codex exec -c model_providers.myproxy.name=x "x"', true],
  ['codex exec "use -c model_provider=myproxy"', true],
  ['codex exec hi # -c model_provider=myproxy', true],
  // Every place the shell runs a command.
  ['env OPENAI_API_KEY=x codex exec hi', true],
  ['env -i PATH=/bin codex exec hi', true],
  ['FOO=1 codex exec hi', true],
  ['command codex exec hi', true],
  ['exec codex exec hi', true],
  ['sudo -u me codex exec hi', true],
  ['timeout 600 codex exec hi', true],
  ['nohup codex exec hi > log 2>&1 &', true],
  ['/opt/x/bin/codex exec hi', true],
  ['./node_modules/.bin/codex review', true],
  ['\\codex exec hi', true],
  ['npx -y @openai/codex exec hi', true],
  ['npx @openai/codex@latest review', true],
  ['cat prompt.md | codex exec -', true],
  ['git diff | codex exec "review"', true],
  ['ls && codex exec hi', true],
  ['false || codex exec hi', true],
  ['cd /a; codex exec hi', true],
  ['echo start\ncodex exec hi\necho end', true],
  ['(cd /a && codex exec hi)', true],
  ['{ codex exec hi; }', true],
  ['out=$(codex exec hi)', true],
  ['echo "$(codex exec hi)"', true],
  ['echo `codex exec hi`', true],
  ["bash -c 'codex exec hi'", true],
  ['sh -lc "codex review"', true],
  ["eval 'codex exec hi'", true],
  ["ssh devhost 'codex exec hi'", true],
  ['ssh devhost codex exec hi', true],
  ['bash <<EOF\ncodex exec hi\nEOF', true],
  ["bash -s <<'EOF'\ncodex exec hi\nEOF", true],
  ["echo 'codex exec hi' | sh", true],
  ['cat <<EOF | bash\ncodex review\nEOF', true],
  ['cat > /tmp/n.md <<EOF\nsee $(codex exec hi)\nEOF', true],
  ['if true; then codex exec hi; fi', true],
  ['for f in a b; do codex exec "$f"; done', true],
  ['! codex exec hi', true],
  ['xargs -n1 codex exec < prompts.txt', true],
  ['codex exec -c model_provider=myproxy hi && codex exec hi', true],
  ["codex exec -c model_provider=myproxy \"$(bash -c 'codex review')\"", true],
  // Found by review: prefix options without a value, here-strings, eval words, wrappers.
  ['sudo -n codex exec hi', true],
  ['sudo -E codex exec hi', true],
  ['xargs -t codex exec hi', true],
  ["bash <<< 'codex exec hi'", true],
  ['eval codex exec hi', true],
  ["env -S 'codex exec hi'", true],
  ['find . -name x -exec codex exec {} \\;', true],
  ['npm exec -- codex exec hi', true],
  ['pnpm dlx @openai/codex exec hi', true],
  ['bun x codex review', true],
  ['watch -n 5 codex exec hi', true],
  ['arch -arm64 codex exec hi', true],
  ['codex exec hi -- -c model_provider=myproxy', true],
  ['codex exec "-c model_provider=myproxy"', true],
  ['codex cloud exec --env e "x"', true],
  ["echo 'codex exec hi' | ssh devhost", true],
  ["echo 'codex exec hi' | bash -s", true],
  // Allowed: the provider named after the subcommand, in every spelling.
  ['codex exec -c model_provider=myproxy "x"', false],
  ['codex exec -c "model_provider=myproxy" "x"', false],
  ['codex exec -c \'model_provider="myproxy"\' x', false],
  ['codex exec -c "model_provider = myproxy" x', false],
  ['codex exec --config model_provider=myproxy x', false],
  ['codex exec --config=model_provider=myproxy x', false],
  ['codex exec -cmodel_provider=myproxy x', false],
  ['codex exec -c=model_provider=myproxy x', false],
  ['codex exec -c model_provider=$PROVIDER x', false],
  ['codex exec -m gpt-5 -c model_reasoning_effort=medium -c model_provider=myproxy x', false],
  ['codex exec --skip-git-repo-check -c model_provider=myproxy -s read-only "review" < /dev/null', false],
  ['codex review -c model_provider=myproxy --uncommitted', false],
  ['codex e -c model_provider=myproxy x', false],
  ['codex exec resume --last -c model_provider=myproxy', false],
  ['codex -c model_provider=myproxy "fix it"', false],
  ['codex "fix it" -c model_provider=myproxy', false],
  ['codex -c model_provider=myproxy', false],
  ['env -i PATH=/bin /opt/x/bin/codex exec -c model_provider=myproxy hi < /dev/null', false],
  ['timeout 900 codex exec -c model_provider=myproxy hi > /tmp/out.txt 2>&1', false],
  ["bash -c 'codex exec -c model_provider=myproxy hi'", false],
  ['cat p.md | codex exec -c model_provider=myproxy - > out.txt 2>&1', false],
  ['out=$(codex exec -c model_provider=myproxy "$(cat prompt.md)")', false],
  ['npx -y @openai/codex exec -c model_provider=myproxy hi', false],
  ['codex exec -c model_provider=myproxy <<< "prompt"', false],
  ["eval 'codex exec -c model_provider=myproxy hi'", false],
  ['eval codex exec -c model_provider=myproxy hi', false],
  ['sudo -n codex exec -c model_provider=myproxy hi', false],
  // Allowed: no model run.
  ['codex --version', false],
  ['codex -V', false],
  ['codex --help', false],
  ['codex exec --help', false],
  ['codex review -h', false],
  ['codex help exec', false],
  ['codex login status', false],
  ['codex login', false],
  ['codex logout', false],
  ['codex mcp list', false],
  ['codex completion zsh', false],
  ['codex features list', false],
  ['codex sandbox macos -- ls', false],
  ['codex apply abc123', false],
  ['codex 2>/dev/null --version', false],
  ['codex update', false],
  ['codex cloud', false],
  ['codex cloud list', false],
  // Allowed: text that only names codex.
  ['grep codex file', false],
  ['grep -rn "codex exec" src', false],
  ['echo "codex exec"', false],
  ["echo 'codex exec hi'", false],
  ['git log --grep codex', false],
  ['cat src/codex-session.ts', false],
  ['vim src/providers/codex-model-probe.ts', false],
  ['cat ~/.codex/config.toml', false],
  ['ls ~/.codex', false],
  ['which codex', false],
  ['command -v codex', false],
  ['type codex', false],
  ['man codex', false],
  ['ps aux | grep codex', false],
  ['codex-acp --help', false],
  ['codex2 exec hi', false],
  ['echo $CODEX_HOME', false],
  ['git commit -m "fix: refuse codex exec with no provider"', false],
  ["cat > /tmp/n.md <<'EOF'\nRun `codex exec hi` here.\nEOF", false],
  ['cat > n.md <<EOF\nNever run codex exec without a provider.\nEOF', false],
  ["python3 - <<'EOF'\nprint('codex exec')\nEOF", false],
  ['# codex exec hi\nls', false],
  ['echo ${HOME}/codex-notes', false],
  ['case $x in\n  codex) echo hi;;\nesac', false],
  ['engines=(codex claude); echo ${engines[0]}', false],
  ['codex() { echo hi; }', false],
  ["git diff | ssh host 'cat > f'; git commit -m \"codex exec rule\"", false],
  ["echo 'codex exec hi' | bash script.sh", false],
  ["bash <<< 'echo codex exec'", false],
  ['find . -name "*.ts" -exec grep -l codex {} +', false],
  ['ls -la', false],
]

describe.each(SHELLS)('codex provider guard under %s', (shell) => {
  it.each(CASES)('%j -> refused=%s', (command, refused) => {
    const r = run(shell, command)
    expect(r.status).toBe(0)
    if (refused) {
      expect(r.reason).toMatch(/^Walnut refused this command: it starts a Codex model run/)
      expect(r.reason).toContain('codex exec -c model_provider=<your provider> ...')
      expect(r.reason).toContain('WALNUT_CODEX_PROVIDER_GUARD=0')
      expect(r.reason).toContain('Codex engine')
    } else {
      expect(r.stdout).toBe('')
    }
  })

  it('names what it refused', () => {
    expect(run(shell, 'codex review').reason).toContain('(codex review)')
    expect(run(shell, 'codex').reason).toContain('(a bare codex)')
    expect(run(shell, 'codex "fix the test"').reason).toContain('(codex with a prompt)')
    expect(run(shell, 'codex -c model_provider=p exec x').reason).toContain('comes before the subcommand')
  })

  it('never refuses input that is not a well formed hook payload', () => {
    const full = payload('codex exec hi')
    expect(runRaw(shell, full).reason).not.toBe('')
    expect(runRaw(shell, full.slice(0, full.indexOf('codex exec hi') + 13)).stdout).toBe('')
    expect(runRaw(shell, full.slice(0, -1)).stdout).toBe('')
    expect(runRaw(shell, 'codex exec hi').stdout).toBe('')
    expect(runRaw(shell, '{"tool_input":{"command":"codex exec hi').stdout).toBe('')
    expect(runRaw(shell, '').stdout).toBe('')
    expect(runRaw(shell, '{"tool_input":{"command":12}} codex').stdout).toBe('')
  })

  it('refuses a command too long to parse only when it runs codex exec, review or resume with no provider', () => {
    const big = 'cat > n.md <<EOF\n' + 'x'.repeat(120_000) + '\nEOF\n'
    expect(run(shell, big).stdout).toBe('')
    expect(run(shell, big + 'codex --version').stdout).toBe('')
    expect(run(shell, big + 'codex exec hi').reason).toMatch(/too long to check/)
    expect(run(shell, big + 'codex --full-auto exec hi').reason).toMatch(/too long to check/)
    expect(run(shell, big + 'codex resume --last').reason).toMatch(/too long to check/)
    expect(run(shell, big + 'codex exec -c model_provider=p hi').stdout).toBe('')
  })

  it('answers a long command quickly', () => {
    const long = 'cat > n.md <<EOF\n' + 'word $(date) codex exec\n'.repeat(3000) + 'EOF\n'
    let t = Date.now()
    expect(run(shell, long + 'codex --version').stdout).toBe('')
    expect(Date.now() - t).toBeLessThan(5000)
    t = Date.now()
    expect(run(shell, long + 'codex exec hi').reason).toMatch(/\(codex exec\)/)
    expect(Date.now() - t).toBeLessThan(5000)
  })
})

describe('codexProviderGuardHooks', () => {
  it('is a PreToolUse Bash hook, off with WALNUT_CODEX_PROVIDER_GUARD=0', () => {
    expect(codexProviderGuardHooks({})).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CODEX_PROVIDER_GUARD_COMMAND, timeout: 10 }] }],
    })
    expect(codexProviderGuardHooks({ WALNUT_CODEX_PROVIDER_GUARD: '0' })).toBeNull()
  })

  it('rides every Claude Code session\'s settings, and leaves them when turned off', () => {
    const groups = (env: NodeJS.ProcessEnv) => ((sessionSettingsHooks(env) as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse)
      .flatMap((g) => g.hooks.map((h) => h.command))
    expect(groups({})).toContain(CODEX_PROVIDER_GUARD_COMMAND)
    expect(groups({ WALNUT_CODEX_PROVIDER_GUARD: '0' })).not.toContain(CODEX_PROVIDER_GUARD_COMMAND)
  })
})
