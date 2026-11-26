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
      thread: 'a thread waiting on him is his own request to this task, one per subject; a same ask in the team folds at the thread itself (thread_update\'s same_ask check and ask_owner), not in the status',
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
      // Puts no ask on the user: it takes a task's own ask off its report (asking nothing of its
      // own, withoutOwnAsk) for the needs thread of its own that asks the same decision.
      'src/core/org/thread-report-ask.ts': /status_report: stampSaidDecision\(withoutOwnAsk\(cur\.status_report\)/,
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
      'src/core/hosts/ssh-cert-expiry-alert.ts': 'Walnut\'s own letter: the SSH certificate runs out, no task asks it',
      'src/core/org/morning-report.ts': 'a report the user asked for, not a decision',
      'src/core/plugins/plugin-letters.ts': 'a plugin\'s letter (a plugin sender is never a task)',
      'src/core/usage/session-budget.ts': 'Walnut\'s own budget alert',
      'src/core/router/service.ts': 'a router\'s per-item letter: what arrived for the person to act on, once per item; no task\'s decision ask',
      'src/core/router/account-intake.ts': 'Walnut\'s own letter: no router reads a mailbox (one per episode under its op key), no task asks it',
    }
    expect(callers, 'a new letter sender: send through sendLetterAsCaller (which runs the same-ask check) or list it here with why').toEqual(Object.keys(SENDERS).sort())
    expect(code('src/core/human-inbox/letter-ops.ts')).toMatch(/async function sendLetterAsCallerOnce[\s\S]*?refuseSameAsk\([\s\S]*?sendLetterOnce\(/)
    for (const f of ['src/web/routes/human-inbox-v1.ts', 'src/core/human-inbox/relay.ts']) expect(code(f), f).toMatch(/sendLetterAsCaller(Once)?\(/)
  })

  it('a Thread handed to the user: both writes in the store run the check', () => {
    const writers = filesWith(/\b(openThread|updateThread)\(/)
    expect(writers).toEqual(['src/core/org/thread-ack.ts', 'src/core/org/thread-answered-check.ts', 'src/core/org/threads-model.ts', 'src/core/org/threads-store.ts'])
    // The answered check (a reply that answers his question) writes only answered: a result for him to read, never a decision asked of him.
    const answered = [...code('src/core/org/thread-answered-check.ts').matchAll(/\bupdateThread\(([^;]*)\)\.file;/g)].map((m) => m[1])
    expect(answered.length).toBe(1)
    expect(answered[0]).toMatch(/state: 'answered'/)
    expect(answered[0]).not.toMatch(/needs/)
    // His Acknowledge kept open (ack_means_known) writes only pending, as him: it never hands a thread to him.
    const ack = [...code('src/core/org/thread-ack.ts').matchAll(/\bupdateThread\(([^;]*)\);/g)].map((m) => m[1])
    expect(ack.length).toBe(1)
    expect(ack[0]).toMatch(/state: 'pending'/)
    expect(ack[0]).toMatch(/'human', at$/)
    const store = code('src/core/org/threads-store.ts')
    expect(store).toMatch(/export async function openNodeThread[\s\S]*?refuseSameAskThread\([\s\S]*?openThread\(/)
    expect(store).toMatch(/export async function patchThread[\s\S]*?refuseSameAskThread\([\s\S]*?updateThread\(/)
  })
})

describe('one decision in other words (experiment asks_same_by_meaning)', () => {
  it('the word test runs only in refuseSameAsk, and the meaning check right after it, through one function', () => {
    // A new path that ran the word test itself would skip the meaning check: it calls refuseSameAsk instead.
    expect(filesWith(/\bfindSameAsk\(/).filter((f) => f !== 'src/core/same-ask.ts')).toEqual(['src/core/same-ask-tree.ts'])
    const tree = code('src/core/same-ask-tree.ts')
    expect(tree.match(/\bfindSameAsk\(/g)).toHaveLength(1)
    expect(tree).toMatch(/export async function refuseSameAsk[\s\S]*?hit = findSameAsk\([\s\S]*?if \(!hit && !reason && !restatesStanding\([^\n]*\n\s*hit = await sameDecisionByMeaning\([\s\S]*?if \(reason\)/)
    // One caller of the model check and of the cards it reads beside the tree's asks.
    expect(filesWith(/\bsameAskByMeaning\(/).filter((f) => f !== 'src/core/same-ask-meaning.ts')).toEqual(['src/core/same-ask-tree.ts'])
    expect(tree).toMatch(/async function sameDecisionByMeaning[\s\S]*?treeAsksOf\(taskId, everything, letters, false\)[\s\S]*?treeThreadAsksOf\([\s\S]*?sameAskByMeaning\(/)
    // The turn-end status question lists the same cards, so the session judges them too (no model call there).
    expect(tree).toMatch(/export async function sameAskQuestionFor[\s\S]*?treeThreadAsksOf\(/)
    expect(filesWith(/\btreeThreadAsksOf\(/).filter((f) => f !== 'src/core/same-ask-meaning.ts')).toEqual(['src/core/same-ask-tree.ts'])
  })

  it('the roll-up stays deterministic: no model call reads or folds the shown status', () => {
    for (const f of ['src/core/user-status-sync.ts', 'src/core/same-ask.ts', 'src/core/user-status.ts']) expect(code(f), f).not.toMatch(/same-ask-meaning|fast-model-call/)
  })

  it('the call is bounded: one source, a hard cap, the fast model helper', () => {
    const m = code('src/core/same-ask-meaning.ts')
    expect(m).toMatch(/callFastModel\(\{[\s\S]*?source: 'same-ask-meaning'[\s\S]*?capMs: MEANING_CAP_MS/)
    expect(code('src/core/fast-model-call.ts')).toMatch(/Math\.min\(fastCallBudgetMs\(config, c\.directMs\), c\.capMs \?\? Infinity\)/)
  })
})

describe('an ask answered above it', () => {
  it('only ask-answer.ts records an answer, and only through task_send answers_ask', () => {
    expect(filesWith(/[{,]\s*ask_answered\s*:/), 'a new writer of Task.ask_answered: go through sessions/ask-answer.ts (it checks the sender stands above the task and tells it once), or take one back through sessions/ask-withdraw.ts')
      .toEqual(['src/core/sessions/ask-answer.ts', 'src/core/sessions/ask-withdraw.ts'])
    expect(code('src/core/sessions/session-send-core.ts')).toMatch(/export async function performSessionSend[\s\S]*?answersAsk[\s\S]*?prepareAskAnswer\([\s\S]*?performPlainSend\([\s\S]*?commit\(\)/)
    expect(code('src/web/routes/messages-v1.ts')).toContain('answersAsk: b.answers_ask === true')
    expect(code('src/ops/work.ts')).toContain('answers_ask:')
  })

  it('an answer can be taken back: ask-withdraw.ts only removes answers, checked like answers_ask, and the task is told once', () => {
    const w = code('src/core/sessions/ask-withdraw.ts')
    // Who may: the person, the answerer, or one that stands above the task (ask-answer.ts).
    expect(w).toMatch(/caller\.id !== answer\.by && !standsAbove\(caller, target, everything\)[\s\S]*?AskWithdrawError\('not_above'/)
    // It writes only what it keeps of the answers already there, under the row's lock, never a new one.
    expect(w).toMatch(/storeEntry\(target\.id, entry, \(cur\) => \{[\s\S]*?answersOf\(cur\)[\s\S]*?\.filter\(\(a\) => !same\(a\)\)[\s\S]*?asks_answered: kept\.length \? kept : null,[\s\S]*?ask_answered: kept\.length \? kept\[kept\.length - 1\] : null/)
    // A teammate that read it answered there is told too, and the fold reads the withdrawal (same-ask.ts).
    expect(w).toMatch(/fold\?\.id !== target\.id \|\| !fold\.answered[\s\S]*?via: \{ id: target\.id/)
    expect(code('src/core/same-ask.ts')).toMatch(/export function foldSameAsk[\s\S]*?ctx\.withdrawnAt\?\.\(/)
    expect(code('src/core/user-status-sync.ts')).toMatch(/withdrawnAt: \(id, ask\) => withdrawnAtOf\(/)
    // Told now only into a live session, else with its next message, from the stored record (it survives a restart).
    expect(w).toMatch(/async function tellNow[\s\S]*?liveSendGuard\(/)
    expect(code('src/core/session-message-queue.ts')).toMatch(/pendingWithdrawnNote\(sessionId\)[\s\S]*?withdrawn\?\.text[\s\S]*?withdrawn\.markTold\(\)/)
    expect(code('src/web/routes/task-v1.ts')).toContain("'/tasks/:id/ask-answer/withdraw'")
    expect(code('src/ops/tasks.ts')).toContain("name: 'task_ask_answer_withdraw'")
  })

  it('Main and every lead are told to answer that way, and every session not to ask what was decided', async () => {
    const { DEFAULT_ORG_INSTRUCTIONS } = await import('../../src/core/org/core-instructions.js')
    for (const [role, text] of Object.entries(DEFAULT_ORG_INSTRUCTIONS)) expect(text, role).toContain('answers_ask=true')
    expect(code('src/core/session-hooks/builtins.ts')).toContain('Never a question your lead, a VP or Main already decided for the user')
  })
})
