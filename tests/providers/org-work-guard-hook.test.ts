/**
 * The hooks that hold Main and a VP to at most 3 commands of their own in a turn
 * (src/providers/org-work-guard-hook.ts), run for real: the exact command strings Walnut puts in
 * `--settings`, through every POSIX shell on this machine, with the JSON Claude Code gives a hook on
 * stdin. A refusal is a `deny` decision on stdout (exit 0); an allowed call prints nothing.
 *
 * MACHINE SAFETY: the hook only reads its stdin and makes directories under the TMPDIR given here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { ORG_WORK_RESET_COMMAND, orgWorkGuardCommand, orgWorkGuardHooks, orgWorkRefusal } from '../../src/providers/org-work-guard-hook.js'
import { sessionSettingsHooks } from '../../src/providers/session-settings-hooks.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))
const HOME = '/home/u'
const TASK_DIR = '/home/u/.local/state/open-walnut/tasks/t1'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'org-work-guard-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const env = () => ({ PATH: guardedPath([], '/usr/bin:/bin'), HOME, TMPDIR: tmp, WALNUT_TASK_DIR: TASK_DIR })

function payload(tool: string, input: Record<string, unknown>, sid = 'sid-1') {
  return JSON.stringify({
    session_id: sid, transcript_path: '/x.jsonl', cwd: '/home/u/repo', permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't',
  })
}

function call(shell: string, tool: string, input: Record<string, unknown>, sid = 'sid-1', role: 'main' | 'lead' = 'lead') {
  const r = spawnSync(shell, ['-c', orgWorkGuardCommand(role)], { input: payload(tool, input, sid), encoding: 'utf8', env: env() })
  expect(r.status).toBe(0)
  if (!r.stdout) return { denied: false, reason: '' }
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } }
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  return { denied: true, reason: out.hookSpecificOutput.permissionDecisionReason }
}

function reset(shell: string, sid = 'sid-1', event = 'Stop') {
  const r = spawnSync(shell, ['-c', ORG_WORK_RESET_COMMAND], {
    input: JSON.stringify({ session_id: sid, hook_event_name: event, stop_hook_active: false, last_assistant_message: '"session_id":"other"' }),
    encoding: 'utf8', env: env(),
  })
  expect(r.status).toBe(0)
  expect(r.stdout).toBe('')
}

const bash = (command: string) => ['Bash', { command, description: 'd' }] as const

// [tool, input, counts?]
const CALLS: Array<[string, Record<string, unknown>, boolean]> = [
  // The 2026-11-03 VP: host_exec through the CLI, by hand.
  [...bash(`walnut tools call host_exec '{"host":"chen-mac","command":"log show --last 30m"}'`), true],
  ['mcp__walnut__host_exec', { host: 'chen-mac', command: 'ls' }, true],
  ['mcp__walnut__host_mcp_call', { host: 'h', server: 's', tool: 't' }, true],
  ['mcp__walnut__host_http', { host: 'h', url: 'http://localhost' }, true],
  [...bash('ls -la /Users/u/Library/Logs'), true],
  [...bash('grep -rn password src/'), true],
  [...bash('walnut-cloud test -- bun x vitest run'), true],
  [...bash('walnut-dev run bun run test:quick'), true],
  ['Read', { file_path: '/home/u/repo/src/x.ts' }, true],
  ['Grep', { pattern: 'x', path: '/home/u/repo' }, true],
  ['Grep', { pattern: 'x' }, true],
  ['Glob', { pattern: '**/*.ts' }, true],
  ['Edit', { file_path: '/home/u/repo/src/x.ts', old_string: 'a', new_string: 'b' }, true],
  ['Agent', { description: 'investigate', prompt: 'find it' }, true],
  ['WebFetch', { url: 'https://example.com' }, true],
  ['Monitor', { command: 'tail -f log' }, true],
  ['mcp__playwright__browser_click', { ref: 'e1' }, true],
  // Walnut's own ops, and the bookkeeping around them.
  [...bash(`walnut tools call task_send '{"to":"x","text":"go"}'`), false],
  [...bash(`cd ${TASK_DIR} && cat > msgs/a.json <<'EOF'\n{"title":"x"}\nEOF\nwalnut tools call task_create --file msgs/a.json`), false],
  [...bash(`walnut tools call task_list | python3 -c 'import json,sys; print(1)'`), false],
  [...bash('/usr/local/bin/walnut tools list'), false],
  [...bash('out=$(walnut tools call task_get \'{"id":"x"}\'); echo "$out"'), false],
  [...bash('walnut-cloud start 62a4f68a --user-request "do it"'), false],
  // Read the way sh splits it (the 2026-11-03 review's cases).
  [...bash(`walnut tools call task_send '{"to":"x","text":"I ran host_exec on X and saw a password prompt"}'`), false],
  [...bash(`walnut tools call host_exec_read '{"jobId":"hx-1"}'`), false],
  [...bash(`FOO=1 walnut tools call task_get '{"id":"x"}'`), false],
  [...bash(`timeout 30 walnut tools call task_get '{"id":"x"}'`), false],
  [...bash('for i in a b; do walnut tools call task_get "{\\"id\\":\\"$i\\"}"; done'), false],
  [...bash(`if walnut tools call task_get '{"id":"x"}' >/dev/null 2>&1; then echo ok; fi`), false],
  [...bash('"$HOME/bin/walnut" tools list'), false],
  [...bash(`walnut tools call task_list 2>&1 | python3 -c 'import json,sys; [print(t["id"]) for t in json.load(sys.stdin)]' | head -5`), false],
  [...bash(`cat > ${TASK_DIR}/m.json <<'EOF'\n{"text":"ls -la; rm -rf /tmp/x | grep y"}\nEOF\nwalnut tools call task_send @${TASK_DIR}/m.json`), false],
  [...bash('grep -rn x / ; walnut --version'), true],
  [...bash(`bun run build && walnut tools call task_get '{"id":"x"}'`), true],
  [...bash(`walnut tools call task_get '{"id":"x"}'; ls /var/log`), true],
  [...bash(`walnut tools call 'host_exec' '{"host":"h","command":"id"}'`), true],
  [...bash("python3 - <<'EOF'\nprint(1)\nEOF"), true],
  [...bash('echo hi'), true],
  [...bash('echo "$(ls /var/log)" | walnut tools call task_send -'), true],
  [...bash('walnut tools call task_send "{\\"text\\":\\"$(walnut tools call task_get x)\\"}"'), false],
  ['mcp__walnut__task_create', { title: 'x' }, false],
  ['mcp__walnut__task_send', { to: 'x', text: 'y' }, false],
  ['mcp__walnut__org_get', {}, false],
  ['Read', { file_path: `${TASK_DIR}/notes.md` }, false],
  ['Read', { file_path: '/home/u/.claude/projects/-x/sid/tool-results/b1.txt' }, false],
  ['Read', { file_path: '/tmp/open-walnut/images/shot.PNG' }, false],
  ['Write', { file_path: `${TASK_DIR}/msgs/b.json`, content: '{}' }, false],
  ['Grep', { pattern: 'x', path: TASK_DIR }, false],
  ['ToolSearch', { query: 'select:TaskStop' }, false],
  ['TaskStop', { task_id: 'b1' }, false],
  ['TodoWrite', { todos: [] }, false],
  ['ScheduleWakeup', { delaySeconds: 60 }, false],
  ['Skill', { skill: 'walnut' }, false],
]

describe.each(SHELLS)('the org work guard under %s', (shell) => {
  it('lets three of the VP\'s own commands through in a turn and refuses the fourth and later', () => {
    const ls = bash('ls /var/log')
    for (let i = 0; i < 3; i++) expect(call(shell, ...ls).denied).toBe(false)
    const fourth = call(shell, ...ls)
    expect(fourth.denied).toBe(true)
    expect(fourth.reason).toBe(orgWorkRefusal('lead'))
    expect(call(shell, 'mcp__walnut__host_exec', { host: 'h', command: 'id' }).denied).toBe(true)
    // Walnut's own ops still go through after the limit.
    expect(call(shell, ...bash(`walnut tools call task_create '{"title":"look into it"}'`)).denied).toBe(false)
    expect(call(shell, 'mcp__walnut__task_send', { to: 'x', text: 'y' }).denied).toBe(false)
  })

  it('a new turn starts at none: Stop and a process start clear the count', () => {
    const ls = bash('ls')
    for (let i = 0; i < 3; i++) call(shell, ...ls)
    expect(call(shell, ...ls).denied).toBe(true)
    reset(shell, 'sid-1', 'Stop')
    for (let i = 0; i < 3; i++) expect(call(shell, ...ls).denied).toBe(false)
    expect(call(shell, ...ls).denied).toBe(true)
    reset(shell, 'sid-1', 'SessionStart')
    expect(call(shell, ...ls).denied).toBe(false)
  })

  it('counts each session apart', () => {
    for (let i = 0; i < 3; i++) call(shell, ...bash('ls'), 'sid-a')
    expect(call(shell, ...bash('ls'), 'sid-a').denied).toBe(true)
    expect(call(shell, ...bash('ls'), 'sid-b').denied).toBe(false)
  })

  it.each(CALLS)('%s %j counts: %s', (tool, input, counts) => {
    // Three of these: the fourth of a counting kind is refused, a free one never.
    for (let i = 0; i < 3; i++) expect(call(shell, tool, input).denied).toBe(false)
    expect(call(shell, tool, input).denied).toBe(counts)
  })

  it('Main is refused in Main\'s words', () => {
    for (let i = 0; i < 3; i++) call(shell, ...bash('ls'), 'sid-m', 'main')
    expect(call(shell, ...bash('ls'), 'sid-m', 'main').reason).toBe(orgWorkRefusal('main'))
  })

  it('a payload it cannot read allows (fail open)', () => {
    const r = spawnSync(shell, ['-c', orgWorkGuardCommand('lead')], { input: 'not json', encoding: 'utf8', env: env() })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('the org work guard, parallel calls of one turn', () => {
  it('ten calls at once take ten different slots: exactly three pass', async () => {
    const one = () => new Promise<boolean>((resolve) => {
      const child = spawn('/bin/sh', ['-c', orgWorkGuardCommand('lead')], { env: env() })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.on('close', () => resolve(out.includes('"deny"')))
      child.stdin.end(payload('Bash', { command: 'ls' }, 'sid-par'))
    })
    const denied = await Promise.all(Array.from({ length: 10 }, one))
    expect(denied.filter((d) => !d)).toHaveLength(3)
  })
})

describe('who gets the guard', () => {
  it('only a session with an org role, and not when it is turned off', () => {
    expect(orgWorkGuardHooks(undefined)).toBeNull()
    expect(orgWorkGuardHooks('lead', { WALNUT_ORG_WORK_GUARD: '0' })).toBeNull()
    const hooks = orgWorkGuardHooks('lead', {}) as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    expect(hooks.PreToolUse[0].matcher).toBe('*')
    expect(hooks.Stop[0].hooks[0].command).toBe(ORG_WORK_RESET_COMMAND)
    // A process's start resets; a compaction (mid-turn) and a message queued into a running turn never do.
    expect(hooks.SessionStart[0].matcher).toBe('startup|resume|clear')
    expect(hooks.SessionStart[0].hooks[0].command).toBe(ORG_WORK_RESET_COMMAND)
    expect(hooks.UserPromptSubmit).toBeUndefined()
  })

  it('the session settings add it beside the other hooks for an org node, never for a worker', () => {
    const worker = JSON.stringify(sessionSettingsHooks({}))
    const lead = sessionSettingsHooks({}, { orgRole: 'lead' }) as Record<string, unknown[]>
    expect(worker).not.toContain('walnut-org-work')
    expect(JSON.stringify(lead)).toContain('walnut-org-work')
    // The other Stop hook (the unanswered-request check) is still there beside the reset.
    expect((lead.Stop as unknown[]).length).toBeGreaterThanOrEqual(2)
  })
})
