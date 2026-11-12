/**
 * The PreToolUse hook that refuses a session's own write to Walnut's approval records
 * (src/providers/approvals-guard-hook.ts), run for real: the exact command Walnut puts in
 * `--settings`, through every POSIX shell here, with the JSON a Claude Code hook receives.
 *
 * MACHINE SAFETY: the hook only reads its stdin (and, for a Write to config.yaml, that file in a
 * temp folder this test makes); nothing here writes Walnut's data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { APPROVALS_GUARD_COMMAND, approvalsGuardHooks } from '../../src/providers/approvals-guard-hook.js'

const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/usr/bin/dash', '/bin/zsh'].filter((s) => fs.existsSync(s))
let home = ''

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apr-guard-'))
  fs.mkdirSync(path.join(home, '.open-walnut'), { recursive: true })
  fs.writeFileSync(path.join(home, '.open-walnut', 'config.yaml'), 'approvals:\n  ask_me: true\n')
  fs.mkdirSync(path.join(home, 'other'), { recursive: true })
  fs.writeFileSync(path.join(home, 'other', 'config.yaml'), 'approvals:\n  ask_me: true\n')
})
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }) })

function run(shell: string, tool: string, input: Record<string, unknown>, env: Record<string, string> = {}) {
  const payload = JSON.stringify({ session_id: 's', cwd: path.join(home, 'work'), hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't' })
  const r = spawnSync(shell, ['-c', APPROVALS_GUARD_COMMAND], { input: payload, encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, ...env } })
  if (!r.stdout) return { refused: false, reason: '' }
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } }
  expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
  return { refused: true, reason: out.hookSpecificOutput.permissionDecisionReason }
}

const W = () => path.join(home, '.open-walnut')
// [tool, input, refused?]
const CASES: Array<[string, () => Record<string, unknown>, boolean]> = [
  // The approval records: every write refused, by any tool.
  ['Write', () => ({ file_path: `${W()}/approvals/keys.json`, content: '{"version":1,"keys":[]}' }), true],
  ['Edit', () => ({ file_path: `${W()}/approvals/approvals.json`, old_string: 'pending', new_string: 'approved' }), true],
  ['Write', () => ({ file_path: `${W()}/approvals/switch.json`, content: '{"on":false}' }), true],
  ['MultiEdit', () => ({ file_path: `${W()}/approvals/../approvals/keys.json`, edits: [] }), true],
  ['Bash', () => ({ command: `echo '{}' > ${W()}/approvals/keys.json` }), true],
  ['Bash', () => ({ command: 'cd ~/.open-walnut/approvals && python3 -c "open(\'switch.json\',\'w\').write(\'{}\')"' }), true],
  ['Bash', () => ({ command: 'cp /tmp/k.json "$HOME/.open-walnut/approvals/keys.json"' }), true],
  ['Bash', () => ({ command: 'sed -i "" s/active/retired/ ~/.open-walnut/approvals/keys.json' }), true],
  // The switch in config.yaml.
  ['Bash', () => ({ command: "sed -i '' 's/ask_me: true/ask_me: false/' ~/.open-walnut/config.yaml" }), true],
  ['Edit', () => ({ file_path: `${W()}/config.yaml`, old_string: 'ask_me: true', new_string: 'ask_me: false' }), true],
  ['Write', () => ({ file_path: `${W()}/config.yaml`, content: 'stt:\n  engine: x\n' }), true],
  // Reading stays open, and other files (another config.yaml, Walnut's own source) are not its business.
  ['Bash', () => ({ command: 'cat ~/.open-walnut/approvals/keys.json | jq .keys' }), false],
  ['Bash', () => ({ command: 'grep ask_me ~/.open-walnut/config.yaml' }), false],
  ['Bash', () => ({ command: "sed -i '' s/a/b/ src/core/approvals/keys.ts" }), false],
  ['Edit', () => ({ file_path: `${W()}/config.yaml`, old_string: 'engine: a', new_string: 'engine: b' }), false],
  ['Write', () => ({ file_path: `${home}/other/config.yaml`, content: 'x: 1\n' }), false],
  ['Write', () => ({ file_path: `${home}/repo/src/core/approvals/keys.ts`, content: 'export {}' }), false],
  ['Read', () => ({ file_path: `${W()}/approvals/keys.json` }), false],
]

describe('approvals guard hook', () => {
  for (const shell of SHELLS) {
    for (const [tool, input, refused] of CASES) {
      it(`${path.basename(shell)}: ${tool} ${JSON.stringify(input()).slice(0, 90)} is ${refused ? 'refused' : 'allowed'}`, () => {
        const r = run(shell, tool, input())
        expect(r.refused).toBe(refused)
        if (refused) expect(r.reason).toMatch(/^Walnut refused this: .*Settings, General/)
      })
    }
  }

  it('reads OPEN_WALNUT_HOME when it is set', () => {
    const r = run(SHELLS[0]!, 'Write', { file_path: '/data/walnut/approvals/keys.json', content: '{}' }, { OPEN_WALNUT_HOME: '/data/walnut' })
    expect(r.refused).toBe(true)
  })

  it('is on for every session, off with WALNUT_APPROVALS_GUARD=0', () => {
    expect(approvalsGuardHooks({})).toEqual({ PreToolUse: [{ matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: APPROVALS_GUARD_COMMAND, timeout: 10 }] }] })
    expect(approvalsGuardHooks({ WALNUT_APPROVALS_GUARD: '0' })).toBeNull()
  })
})
