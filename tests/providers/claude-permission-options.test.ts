/**
 * A Claude prompt's remembering choices, built from the CLI's own suggestions
 * (src/providers/claude-permission-options.ts). The suggestion shapes are the
 * ones CLI 2.1.312 sent for a Bash command and for a Write in default mode.
 */
import { describe, expect, it } from 'vitest'
import {
  bashCommandParts, bashRuleCovers, claudeChoiceResponse, claudePermissionChoices, cliDenyMessage, ruleAllowedLine, scopeOfDestination, settingsBashRules, MESSAGE_DENIES_PROMPT, pendingPermissionRecordFields, permissionDecisionLine, withPermissionDecision, PERMISSION_DECISIONS_KEPT, permissionEventFields, requestFromPendingRecord, validSuggestions,
} from '../../src/providers/claude-permission-options.js'

const bashRule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }
const editsMode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
const bash = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [bashRule] }

describe('claudePermissionChoices', () => {
  it('offers Allow, the session rule, the project rule and Deny for a Bash ask', () => {
    expect(claudePermissionChoices(bash)).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for this session', detail: 'Bash commands starting with npm test' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow in this project', detail: 'Bash commands starting with npm test', savedTo: '.claude/settings.local.json' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
    ])
  })

  it('an edits-mode suggestion is a session choice only (nothing to keep in a file)', () => {
    const choices = claudePermissionChoices({ tool_name: 'Write', permission_suggestions: [editsMode] })
    expect(choices?.map((c) => c.optionId)).toEqual(['allow_once', 'allow_session', 'reject_once'])
    expect(choices?.[1].detail).toBe('Auto-accept every file edit')
  })

  it('a Bash ask never carries the edits mode with its session choice', () => {
    const request = { tool_name: 'Bash', input: { command: 'touch /tmp/a.txt' }, permission_suggestions: [bashRule, editsMode] }
    expect(claudePermissionChoices(request)?.[1].detail).toBe('Bash commands starting with npm test')
    expect(claudeChoiceResponse(request, 'allow_session')).toEqual({ allow: true, updatedPermissions: [{ ...bashRule, destination: 'session' }] })
    // Only the mode on offer: nothing to remember, so the plain Allow / Deny.
    expect(claudePermissionChoices({ tool_name: 'Bash', input: { command: 'touch /tmp/a.txt' }, permission_suggestions: [editsMode] })).toBeUndefined()
  })

  it('a user-settings rule says "Always allow", not "in this project"', () => {
    const choices = claudePermissionChoices({ tool_name: 'WebFetch', permission_suggestions: [{ ...bashRule, rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], destination: 'userSettings' }] })
    expect(choices?.[2]).toMatchObject({ optionId: 'allow_always', name: 'Always allow', detail: 'WebFetch(domain:example.com)', savedTo: '~/.claude/settings.json' })
  })

  it('a rule that is exactly the command on the card says so instead of repeating it', () => {
    const exact = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(40+2)"' }], behavior: 'allow', destination: 'localSettings' }
    const choices = claudePermissionChoices({ tool_name: 'Bash', input: { command: 'python3 -c "print(40+2)"' }, permission_suggestions: [exact] })
    expect(choices?.[1].detail).toBe('Bash: this exact command')
    expect(choices?.[2].detail).toBe('Bash: this exact command')
    // A prefix rule is not the command: it keeps its own words.
    expect(claudePermissionChoices(bash)?.[1].detail).toBe('Bash commands starting with npm test')
  })

  it('every rule is its own line, and a path rule reads as the files it opens', () => {
    const request = { tool_name: 'Bash', permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }, { toolName: 'Bash', ruleContent: 'python3 -c "print(1)"' }], behavior: 'allow', destination: 'session' },
      { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'mcp__notes__search' }], behavior: 'allow', destination: 'session' },
    ] }
    expect(claudePermissionChoices(request)?.[1].detail).toBe('Read any file under /tmp\nBash command: python3 -c "print(1)"\nAccess to the folder /srv/data\nEvery mcp__notes__search call')
    // One part of a compound command says it covers only that part.
    const part = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(1)"' }], behavior: 'allow', destination: 'session' }
    expect(claudePermissionChoices({ tool_name: 'Bash', input: { command: 'python3 -c "print(1)" && echo done' }, permission_suggestions: [part] })?.[1].detail).toBe('Part of this command: python3 -c "print(1)"')
  })

  it('a Bash rule whose "*" would be a wildcard is never offered (it would allow more than it says)', () => {
    const star = (ruleContent: string) => ({ tool_name: 'Bash', input: { command: ruleContent }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent }], behavior: 'allow', destination: 'localSettings' }] })
    // Nothing is left to remember, and the plain yes says why instead of the choices vanishing.
    expect(claudePermissionChoices(star('python3 -c "print(6*7)"'))).toEqual([
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once', detail: "Can't be remembered: its * would match other commands" },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny', takesNote: true },
    ])
    expect(claudePermissionChoices(star('ls *.txt:*'))?.map((c) => c.optionId)).toEqual(['allow_once', 'reject_once'])
    // Another rule beside it stays, and says the command itself is not part of it.
    const beside = claudePermissionChoices({ tool_name: 'Bash', permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls /tmp/*' }, { toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' },
    ] })
    expect(beside?.[1].detail).toBe('Read any file under /tmp\nThe command itself is not remembered: its * would match other commands')
    expect(claudeChoiceResponse(star('python3 -c "print(6*7)"'), 'allow_session')).toBeNull()
    // The trailing " *" (what CLI 2.1.312 suggests for `npm test -- --help`) or ":*" of a
    // prefix rule is the one wildcard meant as one, and reads as the prefix it is.
    expect(claudePermissionChoices({ ...star('npm test:*'), input: { command: 'npm test' } })?.map((c) => c.optionId)).toEqual(['allow_once', 'allow_session', 'allow_always', 'reject_once'])
    const spaced = claudePermissionChoices({ ...star('npm test *'), input: { command: 'npm test -- --help' } })
    expect(spaced?.[1].detail).toBe('Bash commands starting with npm test')
    expect(claudePermissionChoices(star('rm * *'))?.map((c) => c.optionId)).toEqual(['allow_once', 'reject_once'])
    // A command with a "*" of its own offers no Bash rule, even one ending in " *" that
    // would read as a prefix (CLI 2.1.312 suggested `printf '%s\n' *` for this one).
    const glob = { tool_name: 'Bash', input: { command: "printf '%s\\n' * | head -1" }, permission_suggestions: [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: "printf '%s\\n' *" }], behavior: 'allow', destination: 'localSettings' },
    ] }
    expect(claudePermissionChoices(glob)?.map((c) => c.optionId)).toEqual(['allow_once', 'reject_once'])
    expect(claudePermissionChoices(glob)?.[0].detail).toBe("Can't be remembered: its * would match other commands")
    expect(claudeChoiceResponse(glob, 'allow_always')).toBeNull()
    const globBeside = { ...glob, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'head -1:*' }, { toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }] }
    expect(claudePermissionChoices(globBeside)?.[1].detail).toBe('Read any file under /tmp\nThe command itself is not remembered: its * would match other commands')
    expect(claudeChoiceResponse(globBeside, 'allow_session')?.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }])
    // A path rule's "*" is a glob the person reads as one: it stays.
    expect(claudePermissionChoices({ tool_name: 'Read', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }], behavior: 'allow', destination: 'session' }] })?.[1].detail).toBe('Read any file under /tmp')
  })

  it.each([
    ['no suggestions', { tool_name: 'Bash' }],
    ['an empty list', { tool_name: 'Bash', permission_suggestions: [] }],
    ['the CLI suppressing a standing rule', { ...bash, suppress_always_allow_rule: true }],
    ['AskUserQuestion', { ...bash, tool_name: 'AskUserQuestion' }],
    ['ExitPlanMode', { ...bash, tool_name: 'ExitPlanMode' }],
    ['only unusable suggestions', { tool_name: 'Bash', permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }, { type: 'setMode', mode: 'bypassPermissions', destination: 'session' }, 'junk', null] }],
  ])('offers nothing beyond Allow / Deny with %s', (_label, request) => {
    expect(claudePermissionChoices(request)).toBeUndefined()
  })
})

describe('validSuggestions', () => {
  it('keeps allow rules, directories and an edits mode; drops deny rules, other modes and junk', () => {
    expect(validSuggestions([
      bashRule,
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf:*' }], behavior: 'deny', destination: 'session' },
      { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      { type: 'addDirectories', directories: ['/srv/data', 3], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: '' }, { toolName: 'Read', ruleContent: 7 }], behavior: 'allow', destination: 'session' },
      editsMode,
    ])).toEqual([
      bashRule,
      { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' },
      editsMode,
    ])
  })
})

describe('claudeChoiceResponse', () => {
  it('Allow and Deny need no list', () => {
    expect(claudeChoiceResponse({ tool_name: 'Bash' }, 'allow_once')).toEqual({ allow: true })
    expect(claudeChoiceResponse({ tool_name: 'Bash' }, 'reject_once')).toEqual({ allow: false })
  })

  it('the session choice sends every suggestion with destination session', () => {
    // A file tool's ask (a Bash one never carries the mode: see above).
    expect(claudeChoiceResponse({ ...bash, tool_name: 'Write', permission_suggestions: [bashRule, editsMode] }, 'allow_session')).toEqual({
      allow: true,
      updatedPermissions: [{ ...bashRule, destination: 'session' }, editsMode],
    })
  })

  it('the project choice keeps the CLI\'s own destination', () => {
    expect(claudeChoiceResponse(bash, 'allow_always')).toEqual({ allow: true, updatedPermissions: [bashRule] })
  })

  it('the project choice sends the rules its label names, a session-only one marked so', () => {
    const dirs = { type: 'addDirectories', directories: ['/srv/data'], destination: 'session' }
    const request = { ...bash, permission_suggestions: [dirs, bashRule, editsMode] }
    expect(claudePermissionChoices(request)?.[2].detail).toBe('Bash commands starting with npm test\nAlso, for this session only: access to the folder /srv/data')
    expect(claudeChoiceResponse(request, 'allow_always')).toEqual({ allow: true, updatedPermissions: [dirs, bashRule] })
  })

  it('a long one-off command is not offered as a project rule, only for this session', () => {
    const command = `python3 -c "print('${'x'.repeat(220)}')"`
    const exact = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: command }], behavior: 'allow', destination: 'localSettings' }
    const ids = claudePermissionChoices({ ...bash, input: { command }, permission_suggestions: [exact] })?.map((c) => c.optionId)
    expect(ids).toEqual(['allow_once', 'allow_session', 'reject_once'])
    const built = claudePermissionChoices({ ...bash, input: { command }, permission_suggestions: [exact] })
    expect(built?.[0].detail).toBe('No "Always allow in this project": a command this long rarely runs again')
    expect(built?.[1].detail).toBe('Bash: this exact command')
    expect(claudeChoiceResponse({ ...bash, input: { command }, permission_suggestions: [exact] }, 'allow_always')).toBeNull()
  })

  it('an option the request never offered is refused', () => {
    expect(claudeChoiceResponse({ tool_name: 'Write', permission_suggestions: [editsMode] }, 'allow_always')).toBeNull()
    expect(claudeChoiceResponse({ ...bash, suppress_always_allow_rule: true }, 'allow_session')).toBeNull()
    expect(claudeChoiceResponse(bash, 'approved-for-session')).toBeNull()
  })
})

describe('record round trip', () => {
  it('the record keeps what rebuilds the same choices after a restart', () => {
    const record = pendingPermissionRecordFields('req-1', { ...bash, decision_reason: 'This command requires approval' })
    expect(record).toMatchObject({ requestId: 'req-1', toolName: 'Bash', subtype: 'can_use_tool', permissionSuggestions: [bashRule], reason: 'This command requires approval' })
    // The restore path (claude-code-session.ts Layer 2) maps the record back to a request.
    const restored = requestFromPendingRecord(record)
    expect(permissionEventFields('req-1', restored).acpOptions).toEqual(record.acpOptions)
    expect(claudeChoiceResponse(restored, 'allow_session')).toEqual(claudeChoiceResponse(bash, 'allow_session'))
    // A suppressed ask stays suppressed after a restart.
    const quiet = pendingPermissionRecordFields('req-2', { ...bash, suppress_always_allow_rule: true })
    expect(claudePermissionChoices(requestFromPendingRecord(quiet))).toBeUndefined()
    // The call it gates comes back too: its row reads as waiting and its answer is recorded.
    const gated = pendingPermissionRecordFields('req-3', { ...bash, tool_use_id: 'toolu_9' })
    expect(requestFromPendingRecord(gated).tool_use_id).toBe('toolu_9')
  })

  it('the event names the call it gates, so its row reads as waiting', () => {
    expect(permissionEventFields('r', { ...bash, tool_use_id: 'toolu_1' }).toolUseId).toBe('toolu_1')
  })

  it('a request with no choices adds no fields', () => {
    expect(permissionEventFields('r', { subtype: 'can_use_tool', tool_name: 'Bash' })).toEqual({ requestId: 'r', toolName: 'Bash', input: undefined, reason: undefined })
  })
})

describe('cliDenyMessage', () => {
  it('a note goes to the CLI in its own rejection words; anything else as it is', () => {
    expect(cliDenyMessage('The user denied this tool call and said: use pnpm ')).toBe("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse pnpm")
    // A person's new message stops the agent in the CLI's own words.
    expect(cliDenyMessage(MESSAGE_DENIES_PROMPT)).toBe("The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.")
    expect(cliDenyMessage('User dismissed the questions')).toBe('User dismissed the questions')
    expect(cliDenyMessage(undefined)).toBe('User denied permission')
  })
})

describe('withPermissionDecision', () => {
  it('appends, replaces the same call, and keeps only the newest', () => {
    const one = withPermissionDecision(undefined, 'a', 'Allowed once: Bash')
    expect(withPermissionDecision(one, 'a', 'Denied: Bash')).toEqual([{ toolUseId: 'a', line: 'Denied: Bash' }])
    let many: ReturnType<typeof withPermissionDecision> = []
    for (let i = 0; i < PERMISSION_DECISIONS_KEPT + 5; i++) many = withPermissionDecision(many, `t${i}`, 'x')
    expect(many).toHaveLength(PERMISSION_DECISIONS_KEPT)
    expect(many[0].toolUseId).toBe('t5')
  })
})

describe('permissionDecisionLine', () => {
  it('names the choice in the card\'s words, and what it was for', () => {
    const npm = { command: 'npm test' }
    expect(permissionDecisionLine('Bash', true, undefined, undefined, undefined, npm)).toBe('Allowed once: npm test')
    expect(permissionDecisionLine('Bash', true, [{ ...bashRule, destination: 'session' } as never, editsMode as never], undefined, undefined, npm)).toBe('Allowed for this session: Bash commands starting with npm test, Auto-accept every file edit')
    expect(permissionDecisionLine('Bash', true, [bashRule as never], undefined, undefined, npm)).toBe('Always allowed in this project: Bash commands starting with npm test')
    // A rule kept only for this session says so beside the saved one.
    expect(permissionDecisionLine('Bash', true, [{ type: 'addDirectories', directories: ['/var'], destination: 'session' }, bashRule] as never, undefined, undefined, npm))
      .toBe('Always allowed in this project: Bash commands starting with npm test; this session only: Access to the folder /var')
    expect(permissionDecisionLine('AskUserQuestion', false, undefined, MESSAGE_DENIES_PROMPT, undefined, { questions: [{}] })).toBe('Dismissed by your message')
    expect(permissionDecisionLine('WebFetch', true, [{ ...bashRule, rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], destination: 'userSettings' } as never])).toBe('Always allowed: WebFetch(domain:example.com)')
    // The rule that is the command itself reads as the command, as the card said "this exact command".
    const exact = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(40+2)"' }], behavior: 'allow', destination: 'session' }
    expect(permissionDecisionLine('Bash', true, [exact as never], undefined, undefined, { command: 'python3 -c "print(40+2)"' })).toBe('Allowed for this session: python3 -c "print(40+2)"')
    expect(permissionDecisionLine('Bash', false, undefined, 'The user denied this tool call and said: use pnpm', undefined, npm)).toBe('Denied with note \u201Cuse pnpm\u201D: npm test')
    expect(permissionDecisionLine('Bash', false, undefined, 'User denied permission', undefined, npm)).toBe('Denied: npm test')
    // A message sent while the prompt was open denied it: the row says so.
    expect(permissionDecisionLine('Bash', false, undefined, MESSAGE_DENIES_PROMPT, undefined, npm)).toBe('Denied by your message: npm test')
    // A file tool names its file; a long or multi-line command its cut first line; no input, the tool.
    expect(permissionDecisionLine('Write', true, undefined, undefined, undefined, { file_path: '/srv/a.txt' })).toBe('Allowed once: Write /srv/a.txt')
    expect(permissionDecisionLine('Bash', true, undefined, undefined, undefined, { command: 'cd /x\nmake' })).toBe('Allowed once: cd /x \u2026')
    expect(permissionDecisionLine('Bash', true, undefined, undefined, undefined, { command: 'x'.repeat(120) })).toBe(`Allowed once: ${'x'.repeat(79)}\u2026`)
    expect(permissionDecisionLine('Bash', false)).toBe('Denied: Bash')
    // A question and a plan are answered, not permitted.
    expect(permissionDecisionLine('AskUserQuestion', true, undefined, undefined, { 'Which color?': 'Green', 'Which fruit?': 'Apple' })).toBe('Answered: Green; Apple')
    expect(permissionDecisionLine('AskUserQuestion', false, undefined, 'User dismissed the questions')).toBe('Questions dismissed')
    expect(permissionDecisionLine('AskUserQuestion', false, undefined, 'User dismissed the questions', undefined, { questions: [{ question: 'Which?' }] })).toBe('Question dismissed')
    expect(permissionDecisionLine('ExitPlanMode', true)).toBe('Plan approved')
    expect(permissionDecisionLine('ExitPlanMode', false, undefined, 'The user denied this tool call and said: smaller steps')).toBe('Plan rejected with note: \u201Csmaller steps\u201D')
  })
})

describe('calls a remembered rule allows', () => {
  it('a prefix rule covers the prefix and more words; any other rule exactly its text', () => {
    expect(bashRuleCovers('npm test *', 'npm test')).toBe(true)
    expect(bashRuleCovers('npm test *', 'npm test -- --watch')).toBe(true)
    expect(bashRuleCovers('npm test:*', 'npm testing')).toBe(false)
    expect(bashRuleCovers('python3 -c "print(1)"', 'python3 -c "print(1)"')).toBe(true)
    expect(bashRuleCovers('python3 -c "print(1)"', 'python3 -c "print(2)"')).toBe(false)
  })

  it('splits a compound command where the shell would, never inside quotes', () => {
    expect(bashCommandParts('python3 -c "print(3+3)" && echo done')).toEqual(['python3 -c "print(3+3)"', 'echo done'])
    expect(bashCommandParts("grep 'a|b' f.txt | head -1; ls || true")).toEqual(["grep 'a|b' f.txt", 'head -1', 'ls', 'true'])
    expect(bashCommandParts('echo "a && b \\" c"')).toEqual(['echo "a && b \\" c"'])
    expect(bashCommandParts('npm test')).toEqual(['npm test'])
  })

  it('a rule kept for one part of a command names that part, never the whole command', () => {
    const part = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(3+3)"' }], behavior: 'allow', destination: 'session' }
    expect(permissionDecisionLine('Bash', true, [part as never], undefined, undefined, { command: 'python3 -c "print(3+3)" && echo done' }))
      .toBe('Allowed for this session: python3 -c "print(3+3)" (part of this command)')
    expect(ruleAllowedLine('session', 'python3 -c "print(3+3)"', 'python3 -c "print(3+3)" && echo done'))
      .toBe('Allowed by session rule: python3 -c "print(3+3)" (part of this command)')
  })

  it('reads the Bash rules of a settings file as the CLI writes them', () => {
    expect(settingsBashRules(JSON.stringify({ permissions: { allow: ['Bash(npm test *)', 'Bash(python3 -c "print\\(10+5\\)")', 'Read(//tmp/**)', 7] } })))
      .toEqual(['npm test *', 'python3 -c "print(10+5)"'])
    expect(settingsBashRules('not json')).toEqual([])
  })

  it('names the rule and where it is kept', () => {
    expect(scopeOfDestination('session')).toBe('session')
    expect(scopeOfDestination('localSettings')).toBe('project')
    expect(scopeOfDestination('userSettings')).toBe('user')
    expect(ruleAllowedLine('session', 'npm test *', 'npm test -- --watch')).toBe('Allowed by session rule: Bash commands starting with npm test')
    expect(ruleAllowedLine('project', 'python3 -c "print(1)"', 'python3 -c "print(1)"')).toBe('Allowed by project rule: python3 -c "print(1)"')
  })
})
