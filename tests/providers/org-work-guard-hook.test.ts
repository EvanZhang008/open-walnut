/**
 * The hooks that remind Main and a VP of their first rule, at most 3 commands of their own in a turn
 * (src/providers/org-work-guard-hook.ts), run for real: the exact command strings Walnut puts in
 * `--settings`, through every POSIX shell on this machine, with the JSON Claude Code gives a hook on
 * stdin. The 3rd command of a turn gets a reminder (`additionalContext` on stdout, once per turn);
 * any other call prints nothing.
 *
 * Nothing refuses Main's or a VP's own command (2026-11-03, the user: "walnut probally shoudo't
 * stoop it"; 2026-11-04, of a switch that refused the 4th: "remove this shodln;'t do this at all").
 * The class guard at the end fails on any hook Walnut gives an org node that prints a permission
 * decision, and on any source file that ties a deny to an org role.
 *
 * MACHINE SAFETY: the hook only reads its stdin and makes directories under the TMPDIR given here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { ORG_WORK_RESET_COMMAND, orgWorkGuardCommand, orgWorkGuardHooks, orgWorkReminder } from '../../src/providers/org-work-guard-hook.js'
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

/** One PreToolUse run of `command` (default: the role's org work hook). Returns the reminder, or ''. */
function call(shell: string, tool: string, input: Record<string, unknown>, sid = 'sid-1', role: 'main' | 'lead' = 'lead', command = orgWorkGuardCommand(role)): string {
  const r = spawnSync(shell, ['-c', command], { input: payload(tool, input, sid), encoding: 'utf8', env: env() })
  expect(r.status).toBe(0)
  if (!r.stdout) return ''
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; permissionDecision?: string; additionalContext?: string } }
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  // A reminder never decides the call: Claude Code's own permission rules still apply.
  expect(out.hookSpecificOutput.permissionDecision).toBeUndefined()
  expect(r.stdout).not.toContain('permissionDecision')
  return out.hookSpecificOutput.additionalContext ?? ''
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

describe.each(SHELLS)('the org work reminder under %s', (shell) => {
  it('the 3rd of the VP\'s own commands in a turn carries the reminder, once; nothing is refused', () => {
    const ls = bash('ls /var/log')
    expect(call(shell, ...ls)).toBe('')
    expect(call(shell, ...ls)).toBe('')
    const third = call(shell, ...ls)
    expect(third).toBe(orgWorkReminder('lead'))
    expect(third).toMatch(/^Walnut: this is your 3rd command of your own in this turn\. Hand the rest to your team now: task_send/)
    expect(third).not.toMatch(/refus/i)
    // The 4th and later: no refusal (call() fails on any permission decision), and no second reminder.
    for (let i = 0; i < 6; i++) expect(call(shell, ...ls)).toBe('')
    expect(call(shell, 'mcp__walnut__host_exec', { host: 'h', command: 'id' })).toBe('')
  })

  it('Walnut\'s own ops never count toward it', () => {
    for (let i = 0; i < 6; i++) expect(call(shell, 'mcp__walnut__task_send', { to: 'x', text: 'y' })).toBe('')
    call(shell, ...bash('ls'))
    call(shell, ...bash(`walnut tools call task_get '{"id":"x"}'`))
    call(shell, ...bash('ls'))
    expect(call(shell, ...bash('ls'))).toBe(orgWorkReminder('lead'))
  })

  it('a new turn starts at none: Stop and a process start clear the count', () => {
    const ls = bash('ls')
    for (let i = 0; i < 4; i++) call(shell, ...ls)
    reset(shell, 'sid-1', 'Stop')
    call(shell, ...ls); call(shell, ...ls)
    expect(call(shell, ...ls)).toBe(orgWorkReminder('lead'))
    reset(shell, 'sid-1', 'SessionStart')
    call(shell, ...ls); call(shell, ...ls)
    expect(call(shell, ...ls)).toBe(orgWorkReminder('lead'))
  })

  it('counts each session apart, and Main reads Main\'s words', () => {
    for (let i = 0; i < 3; i++) call(shell, ...bash('ls'), 'sid-a')
    call(shell, ...bash('ls'), 'sid-m', 'main')
    call(shell, ...bash('ls'), 'sid-m', 'main')
    const third = call(shell, ...bash('ls'), 'sid-m', 'main')
    expect(third).toBe(orgWorkReminder('main'))
    expect(third).toMatch(/org_send to the VP of its project/)
  })

  it.each(CALLS)('%s %j counts: %s', (tool, input, counts) => {
    // Three of these: the 3rd of a counting kind is reminded, a free one never; none is refused.
    call(shell, tool, input); call(shell, tool, input)
    expect(call(shell, tool, input) !== '').toBe(counts)
    expect(call(shell, tool, input)).toBe('')
  })

  it('a payload it cannot read says nothing (fail open)', () => {
    const r = spawnSync(shell, ['-c', orgWorkGuardCommand('lead')], { input: 'not json', encoding: 'utf8', env: env() })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('the org work reminder, parallel calls of one turn', () => {
  it('ten calls at once take ten different slots: none refused, exactly one reminded', async () => {
    const run = () => new Promise<string>((resolve) => {
      const child = spawn('/bin/sh', ['-c', orgWorkGuardCommand('lead')], { env: env() })
      let out = ''
      child.stdout.on('data', (d) => { out += String(d) })
      child.on('close', () => resolve(out))
      child.stdin.end(payload('Bash', { command: 'ls' }, 'sid-par'))
    })
    const outs = await Promise.all(Array.from({ length: 10 }, run))
    expect(outs.filter((o) => o.includes('permissionDecision'))).toHaveLength(0)
    expect(outs.filter((o) => o.includes('additionalContext'))).toHaveLength(1)
  })
})

describe('who gets the reminder', () => {
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

/**
 * The class: no path refuses Main's or a VP's own command. Every hook Walnut adds for an org role
 * (the hooks an org node's settings carry that a worker's do not) is run on every call of the table,
 * past the limit, and must print no permission decision; and no source file may tie a deny to an
 * org role, except the ones listed here with why.
 */
const ORG_DENY_EXEMPT: Record<string, string> = {
  'src/providers/claude-code-session.ts': 'the permission prompt answers the user\'s own allow or deny, for every session alike; the org role only picks the reminder hooks',
}

describe('nothing refuses Main\'s or a VP\'s own command', () => {
  it.each(['main', 'lead'] as const)('every PreToolUse hook only an org node gets (%s) prints no permission decision', (role) => {
    const commandsOf = (h: Record<string, unknown> | null) => ((h?.PreToolUse ?? []) as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap((g) => g.hooks.map((x) => x.command))
    const workerCmds = new Set(commandsOf(sessionSettingsHooks({})))
    const orgOnly = commandsOf(sessionSettingsHooks({}, { orgRole: role })).filter((c) => !workerCmds.has(c))
    expect(orgOnly.length).toBeGreaterThan(0)
    for (const command of orgOnly) {
      expect(command).not.toContain('permissionDecision')
      for (const [tool, input] of CALLS) for (let i = 0; i < 5; i++) call('/bin/sh', tool, input, `sid-class-${role}`, role, command)
    }
  })

  it('no source file ties a deny to an org role', () => {
    const SRC = path.resolve(__dirname, '../../src')
    const walk = (d: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|mjs|cjs)$/.test(e.name)) out.push(p)
      }
      return out
    }
    const DENY = /permissionDecision|behavior:\s*'deny'|"deny"/
    const ORG = /orgRole|org_role|walnut-org-work|ORG_SELF_COMMAND_LIMIT|block_own_commands|blockOwnCommands/
    const hits = walk(SRC).filter((f) => { const t = fs.readFileSync(f, 'utf8'); return DENY.test(t) && ORG.test(t) })
      .map((f) => path.relative(path.resolve(SRC, '..'), f))
    expect(hits.filter((f) => !ORG_DENY_EXEMPT[f]), 'A path that may refuse Main\'s or a VP\'s own command: the user asked for reminders only').toEqual([])
    for (const f of Object.keys(ORG_DENY_EXEMPT)) expect(hits, `${f} is listed but no longer matches: drop it`).toContain(f)
    // The retired switch is read nowhere (org-settings.ts only drops an older Walnut's value).
    const readers = walk(SRC).filter((f) => /block_own_commands|blockOwnCommands/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(path.resolve(SRC, '..'), f))
    expect(readers).toEqual(['src/core/org/org-settings.ts'])
  })
})
