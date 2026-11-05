/**
 * The daemon answers a pending Claude prompt itself while the Mac is away
 * (live-settings-core.ts permissionAnswer). Its own copy of the choice mapping
 * must write the same rules the server writes (claude-permission-options.ts
 * claudeChoiceResponse), for every option on every request shape: an answer
 * through the cloud must mean what the same answer means on the Mac.
 */
import { describe, expect, it } from 'vitest'
import { createLiveSettings } from '../../src/providers/live-settings-core.js'
import { claudeChoiceResponse } from '../../src/providers/claude-permission-options.js'

const live = createLiveSettings({
  writeLine: async () => 'ok' as never,
  randomHex: () => 'abcd',
  now: () => 1_800_000_000_000,
  log: () => {},
} as unknown as Parameters<typeof createLiveSettings>[0])

const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
const REQUESTS: Record<string, Record<string, unknown>> = {
  bashRule: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [rule] },
  editsMode: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt' }, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
  mixed: { subtype: 'can_use_tool', tool_name: 'Read', input: {}, permission_suggestions: [
    { type: 'addDirectories', directories: ['/srv/data', 4], destination: 'session' }, { ...rule, rules: [{ toolName: 'Read', ruleContent: '//srv/data/**' }] },
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
  ] },
  userRule: { subtype: 'can_use_tool', tool_name: 'WebFetch', input: {}, permission_suggestions: [{ ...rule, rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], destination: 'userSettings' }] },
  suppressed: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, permission_suggestions: [rule], suppress_always_allow_rule: true },
  none: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
  // A "*" the CLI would read as a wildcard: no remembering option on either side.
  wildcard: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'python3 -c "print(6*7)"' }, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(6*7)"' }] }] },
  spacedPrefix: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test -- --help' }, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }] }] },
  wildcardBeside: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: 'ls *.txt' }, { toolName: 'Bash', ruleContent: 'npm test:*' }] }] },
  question: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {}, permission_suggestions: [rule] },
  // A Bash ask's edit-mode suggestion never rides along with its session choice.
  bashWithEditsMode: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch /tmp/a.txt' }, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: 'touch /tmp/a.txt' }] }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
  // A command with its own "*": no Bash rule at all, even a prefix one; the folder stays.
  starCommand: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'cat /srv/x/*.log' }, permission_suggestions: [
    { type: 'addDirectories', directories: ['/srv/x'], destination: 'session' }, { ...rule, rules: [{ toolName: 'Bash', ruleContent: 'cat *' }] },
  ] },
  starCommandOnly: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'cat /srv/x/*.log' }, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: 'cat:*' }] }] },
  // A long one-off command: kept for the session, never offered as a project rule.
  longExact: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: `echo ${'y'.repeat(230)}` }, permission_suggestions: [{ ...rule, rules: [{ toolName: 'Bash', ruleContent: `echo ${'y'.repeat(230)}` }] }] },
}
const OPTIONS = ['allow_once', 'allow_session', 'allow_always', 'reject_once', 'approved-for-session']

describe('the daemon maps a choice exactly as the server does', () => {
  for (const [name, request] of Object.entries(REQUESTS)) {
    for (const optionId of OPTIONS) {
      it(`${name} / ${optionId}`, () => {
        const server = claudeChoiceResponse(request, optionId)
        const allow = server?.allow ?? optionId !== 'reject_once'
        const answer = live.permissionAnswer({ reqId: 'r1', request }, { requestId: 'r1', allow, optionId, ...(allow ? {} : { message: 'no' }) })
        if (!server) {
          expect(answer).toMatchObject({ ok: false, code: 'bad_request' })
          return
        }
        expect(answer.ok).toBe(true)
        const written = JSON.parse((answer as { line: string }).line).response.response
        expect(written.behavior).toBe(server.allow ? 'allow' : 'deny')
        expect(written.updatedPermissions).toEqual(server.updatedPermissions)
      })
    }
  }

  it('an allow that contradicts its option is refused', () => {
    expect(live.permissionAnswer({ reqId: 'r1', request: REQUESTS.bashRule }, { requestId: 'r1', allow: false, optionId: 'allow_session' }))
      .toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('no option: the answer is what it always was', () => {
    const answer = live.permissionAnswer({ reqId: 'r1', request: REQUESTS.bashRule }, { requestId: 'r1', allow: true })
    expect(JSON.parse((answer as { line: string }).line).response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } })
  })
})
