/**
 * A task's trigger never notifies the user (2026-11-02, the user: the trigger of a
 * completed task lost its check script and Walnut sent him an English letter,
 * "Trigger ... stopped after 5 failed checks"; trouble of a trigger goes to the task
 * that owns it or that task's lead, src/core/routines/trigger-health.ts).
 *
 * A source ratchet over the whole routines and cron code: every call that puts
 * something in front of the user (a bell, a letter, a phone push) is listed here with
 * the reason it is the user's to read. A new one fails until it is either routed
 * through `tellTriggerTeam` or added here with its reason.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
const DIRS = ['src/core/routines', 'src/core/cron']

/**
 * What reaches the user: the bell feed, the inbox, a push. The letter tool counts where code
 * names it as a tool (the whole string `'human_inbox_send'`, an op call's name); a prompt's
 * sentence that tells an agent about the tool (offline-run.ts) sends nothing.
 */
const USER_NOTICE = /\b(addNotification|upsertNotification|sendLetter|sendLetterOnce|sendWalnutLetter|notifyUser|sendPushNotification)\s*\(|human-inbox\/|(['"`])human_inbox_send\2/g

/**
 * The user's own routines, which no task owns: the user made them, so the user hears
 * about them. None of these is a task's trigger.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'src/core/routines/executors/watcher.ts': {
    count: 1, why: 'the watcher\'s notify outcome: the user\'s own sentence asks the watcher to tell them',
  },
  'src/core/routines/executors/claude-code.ts': {
    count: 1, why: 'a routine the user wrote, refused by the host gate; its run has no task to tell yet',
  },
  'src/core/routines/executors/session.ts': {
    count: 1, why: 'a routine the user made himself (no check), with no task of its own to tell: a trigger never takes this path (userRoutine)',
  },
  'src/core/routines/missed-runs.ts': {
    count: 1, why: 'a missed run of a routine nobody owns (no session made it, not a session routine): the user made it',
  },
  'src/core/routines/run-start-deps.ts': {
    count: 1, why: 'a run of a routine the user wrote that did not start; its fresh task is handed back to the user',
  },
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(rel))
    else if (entry.name.endsWith('.ts')) out.push(rel)
  }
  return out
}

/** The code without its comments, so a sentence about a letter is not a send. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('trigger notices never go to the user', () => {
  const files = DIRS.flatMap(sources)

  it('scans the routines and cron code', () => {
    expect(files).toContain('src/core/routines/trigger-health.ts')
    expect(files).toContain('src/core/routines/trigger-events.ts')
    expect(files).toContain('src/core/routines/executors/session.ts')
    expect(files).toContain('src/core/cron/trigger-apply.ts')
  })

  it('every call that reaches the user is a routine the user made, listed with its reason', () => {
    const found: Record<string, number> = {}
    for (const file of files) {
      const n = (code(fs.readFileSync(path.join(root, file), 'utf8')).match(USER_NOTICE) ?? []).length
      if (n) found[file] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([f, a]) => [f, a.count])))
  })

  it('the letter tool named as a tool counts, a sentence about it does not', () => {
    const count = (src: string) => (code(src).match(USER_NOTICE) ?? []).length
    expect(count("await call('human_inbox_send', { subject })")).toBe(1)
    expect(count('const op = { name: "human_inbox_send" }')).toBe(1)
    expect(count('tools.call(`human_inbox_send`, args)')).toBe(1)
    expect(count("const rule = 'a letter to the user with human_inbox_send.'")).toBe(0)
    expect(count("import { sendLetter } from '../human-inbox/letters.js'")).toBe(1)
  })

  it('a stopped trigger hands its waiting task back without a bell', () => {
    const health = code(fs.readFileSync(path.join(root, 'src/core/routines/trigger-health.ts'), 'utf8'))
    expect(health).toMatch(/handBackWaitingTaskOfDisabledTrigger\(event\.id, event\.error, \{ notify: false, quiet: true \}\)/)
  })
})
