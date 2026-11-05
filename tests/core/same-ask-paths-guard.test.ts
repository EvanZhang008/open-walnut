/**
 * Every path that puts an ask on the user goes through the same-ask rule (src/core/same-ask.ts):
 * the user sees one decision once, from the task closest to the work. Enumerated from the source,
 * so a NEW path fails here until it is checked or listed with why it needs no check.
 *
 *  1. The shown status: one function derives what a task stores (statusOf in user-status-sync.ts),
 *     and it folds a same ask; nothing else may call deriveUserStatus and store or compare it.
 *  2. Every Needs you source derive() makes is foldable, or listed as the task's own (a live
 *     prompt, a failed session).
 *  3. The writes: every file that writes a task's report, mints a letter or hands a Thread to the
 *     user either runs the tree check or is listed with its reason.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FOLDABLE_SOURCES } from '../../src/core/same-ask.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function srcFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...srcFiles(rel))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel)
  }
  return out
}
const FILES = srcFiles()
/** Code without comments, so a mention in a doc line is no call. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const filesWith = (re: RegExp) => FILES.filter((f) => re.test(code(f))).sort()

describe('the shown status folds a same ask', () => {
  it('only statusOf derives a status to store or compare, and it folds', () => {
    const callers = filesWith(/\bderiveUserStatus\(/).filter((f) => f !== 'src/core/user-status.ts')
    expect(callers, 'a new caller of deriveUserStatus must go through statusOf (user-status-sync.ts), which folds a same ask').toEqual(['src/core/user-status-sync.ts'])
    const sync = code('src/core/user-status-sync.ts')
    expect(sync.match(/deriveUserStatus\(/g)).toHaveLength(1)
    expect(sync).toMatch(/export function statusOf[\s\S]*?deriveUserStatus\([\s\S]*?foldSameAsk\([\s\S]*?relatives:[\s\S]*?answeredAbove\(/)
    expect(code('src/core/status-consistency.ts')).toContain('statusOf(')
  })

  it('every Needs you source is foldable, or is the task\'s own', () => {
    const OWN: Record<string, string> = {
      prompt: 'a live permission prompt blocks a turn someone started; it is answered in that session',
      error: 'a failed session or an undelivered message is that task\'s own state, never a decision',
      letter: 'the inbox letter is where the user answers it; a second letter in the tree is refused (letter-ops.ts)',
      none: 'a person set it to need them (MARKED_ASK): their own mark, one fixed sentence for every task',
    }
    const src = code('src/core/user-status.ts')
    const sources = new Set([...src.matchAll(/state: 'needs',\s*(?:source: '([a-z]+)')?/g)].map((m) => m[1] ?? 'none'))
    expect(sources.has('none')).toBe(true)
    expect(sources.size).toBeGreaterThan(3)
    for (const s of sources) expect(FOLDABLE_SOURCES.has(s as never) || s in OWN, `needs source "${s}": add it to FOLDABLE_SOURCES (same-ask.ts) or say here why it is the task's own`).toBe(true)
  })
})

describe('every write that asks the user is checked', () => {
  it('a task\'s report: a line set from outside is refused, the turn-end question lists the tree', () => {
    // Any object literal keyed status_report (a type's `status_report?:` is no write).
    const writers = filesWith(/[{,]\s*status_report\s*:/)
    const CHECKED: Record<string, RegExp> = {
      'src/core/sessions/report-set.ts': /refuseSameAsk\(/,
      // The turn-end report is the task's own words: the question lists its tree's asks first, and
      // the shown status folds whatever it still asks twice.
      'src/core/sessions/status-question.ts': /sameAskQuestionFor\(/,
    }
    expect(writers, 'a new writer of task.status_report: run refuseSameAsk or list it here').toEqual(Object.keys(CHECKED).sort())
    for (const [f, re] of Object.entries(CHECKED)) expect(code(f), f).toMatch(re)
    // The summary path asks the status lines for engines the question does not reach.
    expect(code('src/core/session-hooks/builtins.ts')).toContain('sameAskQuestionFor(')
  })

  it('a letter: a session\'s decision letter runs the check; every other sender is listed', () => {
    const callers = filesWith(/\bsendLetter(?:Once|AsCaller|AsCallerOnce)?\(/)
    const SENDERS: Record<string, string> = {
      'src/core/human-inbox/letter-ops.ts': 'THE place a caller\'s letter is minted: runs refuseSameAsk',
      'src/core/human-inbox/store.ts': 'the store itself',
      'src/web/routes/human-inbox-v1.ts': 'the route: sendLetterAsCaller',
      'src/core/human-inbox/relay.ts': 'the replica\'s relay: sendLetterAsCaller',
      'src/core/offline-merge/apply-letter.ts': 'a host\'s journal op, written while the server was away: never refused on the way in (opKey)',
      'src/core/offline-merge/letter.ts': 'the same journal op',
      'src/core/hosts/host-auth-alert.ts': 'Walnut\'s own letter: SSH sign-in expired, no task asks it',
      'src/core/hosts/host-exec-grant.ts': 'Walnut\'s own approval of a host command, no task\'s decision',
      'src/core/hosts/local-network-alert.ts': 'Walnut\'s own letter: macOS blocks the local network',
      'src/core/org/morning-report.ts': 'a report the user asked for, not a decision',
      'src/core/plugins/server-api.ts': 'a plugin\'s letter (a plugin sender is never a task)',
      'src/core/usage/session-budget.ts': 'Walnut\'s own budget alert',
      'src/integrations/git-sync-secrets.ts': 'Walnut\'s own letter: a credential held out of git sync',
    }
    expect(callers, 'a new letter sender: send through sendLetterAsCaller (which runs the same-ask check) or list it here with why').toEqual(Object.keys(SENDERS).sort())
    expect(code('src/core/human-inbox/letter-ops.ts')).toMatch(/async function sendLetterAsCallerOnce[\s\S]*?refuseSameAsk\([\s\S]*?sendLetterOnce\(/)
    for (const f of ['src/web/routes/human-inbox-v1.ts', 'src/core/human-inbox/relay.ts']) expect(code(f), f).toMatch(/sendLetterAsCaller(Once)?\(/)
  })

  it('a Thread handed to the user: both writes in the store run the check', () => {
    const writers = filesWith(/\b(openThread|updateThread)\(/)
    expect(writers).toEqual(['src/core/org/threads-model.ts', 'src/core/org/threads-store.ts'])
    const store = code('src/core/org/threads-store.ts')
    expect(store).toMatch(/export async function openNodeThread[\s\S]*?refuseSameAskThread\([\s\S]*?openThread\(/)
    expect(store).toMatch(/export async function patchThread[\s\S]*?refuseSameAskThread\([\s\S]*?updateThread\(/)
  })
})

describe('an ask answered above it', () => {
  it('only ask-answer.ts records an answer, and only through task_send answers_ask', () => {
    expect(filesWith(/[{,]\s*ask_answered\s*:/), 'a new writer of Task.ask_answered: go through sessions/ask-answer.ts (it checks the sender stands above the task and tells it once)')
      .toEqual(['src/core/sessions/ask-answer.ts'])
    expect(code('src/core/sessions/session-send-core.ts')).toMatch(/export async function performSessionSend[\s\S]*?answersAsk[\s\S]*?prepareAskAnswer\([\s\S]*?performPlainSend\([\s\S]*?commit\(\)/)
    expect(code('src/web/routes/messages-v1.ts')).toContain('answersAsk: b.answers_ask === true')
    expect(code('src/ops/work.ts')).toContain('answers_ask:')
  })

  it('Main and every lead are told to answer that way, and every session not to ask what was decided', async () => {
    const { DEFAULT_ORG_INSTRUCTIONS } = await import('../../src/core/org/core-instructions.js')
    for (const [role, text] of Object.entries(DEFAULT_ORG_INSTRUCTIONS)) expect(text, role).toContain('answers_ask=true')
    expect(code('src/core/session-hooks/builtins.ts')).toContain('Never a question your lead, a VP or Main already decided for the user')
  })
})
