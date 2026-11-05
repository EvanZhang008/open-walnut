/**
 * The collapsed tool-run line counts files for reads and edits, not calls: six
 * Edits to one index.html read "edited 6 files" beside a Changed view that
 * listed one file.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { isRoutedQuestion, isUserDenied, runSegments, toolRunPhrase } from '../../web/src/components/sessions/tool-run-phrase.js'
import { answeredCallState, callAnswerText, callDecisionLabel, runAnswerLines } from '../../web/src/components/sessions/waiting-tools.js'
import { denyNoteMessage } from '../../web/src/components/sessions/prompt-keys.js'
import { cliDenyMessage, MESSAGE_DENIES_PROMPT } from '../../src/providers/claude-permission-options.js'

const edit = (file_path: string) => ({ name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } })
const read = (file_path: string) => ({ name: 'Read', input: { file_path } })

describe('toolRunPhrase', () => {
  it('many edits to one file are one edited file', () => {
    expect(toolRunPhrase([read('/r/index.html'), ...Array.from({ length: 6 }, () => edit('/r/index.html')), { name: 'Bash', input: { command: 'node --check x.js' } }]))
      .toBe('Read a file, edited a file, ran a command')
  })

  it('counts distinct files per category, Write and Edit together', () => {
    expect(toolRunPhrase([
      edit('/r/a.ts'), { name: 'Write', input: { file_path: '/r/b.ts', content: 'x' } }, edit('/r/a.ts'),
      read('/r/a.ts'), read('/r/a.ts'), read('/r/c.ts'),
    ])).toBe('Edited 2 files, read 2 files')
  })

  it('a call without a known path counts as its own file', () => {
    expect(toolRunPhrase([{ name: 'Edit' }, { name: 'Edit', input: {} }, edit('/r/a.ts')])).toBe('Edited 3 files')
    expect(toolRunPhrase([{ name: 'NotebookEdit', input: { notebook_path: '/r/n.ipynb' } }, { name: 'NotebookEdit', input: { notebook_path: '/r/n.ipynb' } }]))
      .toBe('Edited a file')
  })

  it('commands and other tools still count calls', () => {
    expect(toolRunPhrase([{ name: 'Bash', input: { command: 'ls' } }, { name: 'Bash', input: { command: 'ls' } }, { name: 'Grep' }, { name: 'Grep' }]))
      .toBe('Ran 2 commands, ran 2 searches')
  })
})

describe('a question in the tool run', () => {
  it('reads as asking, not as an anonymous tool', () => {
    expect(toolRunPhrase([{ name: 'AskUserQuestion' }])).toBe('Asked a question')
    expect(toolRunPhrase([{ name: 'AskUserQuestion' }, { name: 'Bash' }, { name: 'AskUserQuestion' }])).toBe('Asked 2 questions, ran a command')
  })

  it('a worker question Walnut sent to its leader is not a failure (worker-question.ts)', () => {
    const routed = 'In this team your questions go to your leader, "Triage" (task t-1), not to the user. Your question was sent to it as request rq-abc123.'
    expect(isRoutedQuestion('AskUserQuestion', routed)).toBe(true)
    expect(isRoutedQuestion('AskUserQuestion', `\n${routed}`)).toBe(true)
    // Anything else stays what it is: a user's deny, another tool, no text.
    expect(isRoutedQuestion('AskUserQuestion', 'User denied permission')).toBe(false)
    expect(isRoutedQuestion('Bash', routed)).toBe(false)
    expect(isRoutedQuestion('AskUserQuestion', undefined)).toBe(false)
  })
})

describe("Walnut's messaging ops in a tool run", () => {
  it('say they sent a message or wrote to the inbox, never "used a tool"', () => {
    expect(toolRunPhrase([{ name: 'mcp__walnut__org_send' }])).toBe('Sent a message')
    expect(toolRunPhrase([{ name: 'mcp__walnut__task_send' }, { name: 'Bash' }, { name: 'mcp__walnut__session_send' }])).toBe('Sent 2 messages, ran a command')
    expect(toolRunPhrase([{ name: 'mcp__walnut__human_inbox_send' }])).toBe('Wrote to your inbox')
    expect(toolRunPhrase([{ name: 'mcp__walnut__task_get' }])).toBe('Used a tool')
  })
})

describe('isUserDenied', () => {
  it('reads a deny, a deny with a note, a withdrawn prompt and a dismissed question as the person\'s no', () => {
    expect(isUserDenied('User denied permission')).toBe(true)
    expect(isUserDenied(denyNoteMessage('use pnpm'))).toBe(true)
    // What the CLI is actually sent for a note (and writes back as the call's result).
    expect(isUserDenied(cliDenyMessage(denyNoteMessage('use pnpm')))).toBe(true)
    expect(isUserDenied(MESSAGE_DENIES_PROMPT)).toBe(true)
    expect(isUserDenied(cliDenyMessage(MESSAGE_DENIES_PROMPT))).toBe(true)
    expect(isUserDenied('User sent a new message \u2014 permission auto-denied')).toBe(true)
    expect(isUserDenied('User dismissed the questions')).toBe(true)
    expect(isUserDenied('Exit code 1: command not found')).toBe(false)
    expect(isUserDenied(undefined)).toBe(false)
  })

  // A new deny message that this check misses would count a person's no as a
  // failure again (red "1 failed" and a cross). Every literal one in the code is here.
  it('knows every deny message the code sends', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) } else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk('src'); walk('web/src')
    const patterns = [
      /resolvePermissionRequest\([^,]+, ?false, ?'([^']+)'/g,
      /denyMessage \?\? '([^']+)'/g,
      /\? raw\.message : '([^']+)'/g,
      /\((?:respond|go)\(false, \{ message: '([^']+)'/g,
      /handleResponse\(false, undefined, '([^']+)'/g,
      // The Claude session's own: a message that denies an open prompt, and a deny with no words.
      /MESSAGE_DENIES_PROMPT = '([^']+)'/g,
      /function cliDenyMessage[^{]*\{\s*if \(!message\) return '([^']+)'/g,
    ]
    const found = new Set<string>()
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      for (const re of patterns) for (const m of src.matchAll(re)) found.add(m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))))
    }
    expect(found.size).toBeGreaterThanOrEqual(3)
    for (const msg of found) expect(isUserDenied(msg), msg).toBe(true)
  })
})

describe('runSegments', () => {
  const bash = (toolUseId: string, denied = false) => ({ name: 'Bash', input: { command: 'ls' }, toolUseId, denied })
  const none = new Set<string>()
  it('a denied or held call never counts as one that ran', () => {
    expect(runSegments([bash('a'), bash('b', true)], none)).toEqual([{ kind: 'ran', text: 'Ran a command' }, { kind: 'denied', text: 'denied a command' }])
    expect(runSegments([bash('a', true), bash('b', true)], none)).toEqual([{ kind: 'denied', text: 'Denied 2 commands' }])
    expect(runSegments([bash('a'), bash('b')], new Set(['b']))).toEqual([{ kind: 'ran', text: 'Ran a command' }, { kind: 'waiting', text: 'waiting for approval' }])
    expect(runSegments([bash('a')], new Set(['a']))).toEqual([{ kind: 'waiting', text: 'Waiting for approval' }])
    // Sent together: the second waits behind the first one's prompt, it has not run.
    expect(runSegments([{ ...bash('a'), done: false }, { ...bash('b'), done: false }], new Set(['a']))).toEqual([{ kind: 'waiting', text: 'Waiting for approval' }, { kind: 'queued', text: '1 queued' }])
    expect(runSegments([{ ...bash('a'), done: true }, { ...bash('b'), done: false }], new Set(['b']))).toEqual([{ kind: 'ran', text: 'Ran a command' }, { kind: 'waiting', text: 'waiting for approval' }])
  })
  it('a question waits for an answer, not an approval', () => {
    expect(runSegments([{ name: 'AskUserQuestion', toolUseId: 'q' }], new Set(['q']))).toEqual([{ kind: 'waiting', text: 'Waiting for your answer' }])
  })
  it('names what was denied: a dismissed question, or a tool call of another kind', () => {
    expect(runSegments([{ name: 'AskUserQuestion', toolUseId: 'q', denied: true }], none)).toEqual([{ kind: 'denied', text: 'Dismissed a question' }])
    expect(runSegments([{ name: 'Write', input: { file_path: '/a' }, toolUseId: 'w', denied: true }, bash('b', true)], none)).toEqual([{ kind: 'denied', text: 'Denied 2 tool calls' }])
  })
})

describe('answeredCallState', () => {
  it('a call answered no is denied before its result; an allowed one is no longer queued', () => {
    const none = new Set<string>()
    expect(answeredCallState('a', 'Denied: npm test', none)).toBe('denied')
    expect(answeredCallState('a', 'Denied by your message: npm test', none)).toBe('denied')
    expect(answeredCallState('a', 'Questions dismissed', none)).toBe('denied')
    expect(answeredCallState('a', undefined, new Set(['a']))).toBe('denied')
    expect(answeredCallState('a', 'Allowed once: npm test', none)).toBe('answered')
    expect(answeredCallState('a', undefined, none)).toBeUndefined()
    expect(answeredCallState(undefined, 'Denied: x', none)).toBeUndefined()
  })
})

describe('callDecisionLabel', () => {
  it('a call\'s own row already shows the command: the line keeps only the choice', () => {
    expect(callDecisionLabel('Allowed once: npm test')).toBe('Allowed once')
    expect(callDecisionLabel('Denied: npm test')).toBe('Denied')
    expect(callDecisionLabel('Allowed by session rule: Bash commands starting with npm test')).toBe('Allowed by session rule: Bash commands starting with npm test')
    expect(callDecisionLabel('Denied by your message: npm test')).toBe('Denied by your message')
    expect(callDecisionLabel('Denied: npm test (note: \u201Cuse pnpm (not npm)\u201D)')).toBe('Denied with note \u201Cuse pnpm (not npm)\u201D')
    expect(callDecisionLabel('Denied with note \u201Cuse pnpm: not npm\u201D: npm test')).toBe('Denied with note \u201Cuse pnpm: not npm\u201D')
    // A remembering line keeps its rule: it can be wider than the command.
    expect(callDecisionLabel('Allowed for this session: Bash commands starting with npm test')).toBe('Allowed for this session: Bash commands starting with npm test')
  })
})

describe('runAnswerLines', () => {
  it('lists each answer once, in call order, with how many calls it answered', () => {
    // Two calls allowed once read as two answers, not one; a rule line after a person's answer stays.
    expect(runAnswerLines(['Allowed once: npm test', 'Allowed once: npm test'])).toEqual(['Allowed once: npm test (2 times)'])
    expect(runAnswerLines(['Always allowed in this project: npm test', 'Allowed by project rule: npm test']))
      .toEqual(['Always allowed in this project: npm test · 1 more call by that rule'])
    expect(runAnswerLines(['Allowed once: npm test', 'Allowed by project rule: npm test'])).toEqual(['Allowed once: npm test', 'Allowed by project rule: npm test'])
    expect(runAnswerLines([])).toEqual([])
    // A note after the command, not run into it.
    expect(runAnswerLines(['Denied with note \u201CUse pnpm.\u201D: npm test'])).toEqual(['Denied with note: npm test \u00b7 \u201CUse pnpm.\u201D'])
    // The rule a grant made, used by a later call: the same grant with a count.
    expect(runAnswerLines(['Allowed for this session: npm test', 'Allowed by session rule: npm test'])).toEqual(['Allowed for this session: npm test · 1 more call by that rule'])
    expect(runAnswerLines(['Allowed for this session: npm test', 'Allowed by session rule: npm test', 'Allowed by session rule: npm test']))
      .toEqual(['Allowed for this session: npm test · 2 more calls by that rule'])
  })

  it('names the command a prefix rule let run, when its calls all ran the same one', () => {
    const rule = 'Allowed for this session: Bash commands starting with npm test'
    expect(runAnswerLines([rule], ['npm test --silent'])).toEqual(['Allowed for this session (commands starting with npm test): npm test --silent'])
    expect(runAnswerLines([rule, 'Allowed by session rule: Bash commands starting with npm test'], ['npm test --silent', 'npm test --loglevel=error']))
      .toEqual(['Allowed for this session (commands starting with npm test): npm test --silent \u00b7 1 more call by that rule'])
    // Two calls on one line that ran different commands: the rule alone, never one of them for both.
    expect(runAnswerLines([rule, rule], ['npm test a', 'npm test b'])).toEqual([`${rule} (2 times)`])
    // An exact rule already names its command.
    expect(runAnswerLines(['Allowed for this session: npm test'], ['npm test'])).toEqual(['Allowed for this session: npm test'])
    expect(runAnswerLines([rule])).toEqual([rule])
  })
})

describe('callAnswerText', () => {
  it('says "this exact command" instead of naming the command shown just above', () => {
    expect(callAnswerText('Allowed for this session: npm test', 'npm test')).toBe('Allowed for this session (this exact command)')
    const long = `python3 -c "${'x'.repeat(120)}"`
    expect(callAnswerText(`Always allowed in this project: ${long.slice(0, 79)}\u2026`, long)).toBe('Always allowed in this project (this exact command)')
    expect(callAnswerText('Allowed once: npm test', 'npm test')).toBe('Allowed once')
  })
  it('keeps a rule wider than the command, and a note whole', () => {
    expect(callAnswerText('Allowed for this session: Bash commands starting with npm test', 'npm test --silent')).toBe('Allowed for this session: Bash commands starting with npm test')
    expect(callAnswerText('Denied with note \u201CUse this: pnpm\u201D: npm test', 'npm test')).toBe('Denied with note \u201CUse this: pnpm\u201D')
    expect(callAnswerText('Allowed by session rule: npm test')).toBe('Allowed by session rule: npm test')
  })
})
