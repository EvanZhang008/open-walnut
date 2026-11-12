/**
 * Guard: one place per update, the thread first (2026-11-04, the user, after a VP sent each thread
 * result as a letter too while he was away: "Only choose one, put it in thread or inbox, don't
 * cluster and duplicate everything everywhere, inbox leave for something else ... if it is just a
 * thread just put it there without sending it to inbox").
 *
 * Fails when a place an Org node reads (its prompt, the thread ops, human_inbox_send) loses
 * THREAD_ONE_PLACE_RULE (the user-away and threads hints are one line of facts since 2026-11-06 and
 * leave the rules to the prompt); when ANY text a node reads (every prompt line,
 * hint, op and param description, built-in skill) tells it again to send a thread's result to the
 * inbox, or that a result he asked for goes there while he is away; and when any of them says
 * again that Walnut refuses such a letter. The rule is prompt text only (2026-11-04, the user: "I
 * think there's no need for programmatic ... thread itself is a text ... just a prompt"): a letter
 * about a thread is sent like any other.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { THREAD_ONE_PLACE_RULE, THREADS_OPEN_RULE } from '../../../src/core/org/thread-rules.js'
import { AWAY_INBOX_LINE, THREADS_LINE } from '../../../src/core/sessions/session-context.js'
import { nodeReads } from '../../helpers/node-reads.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { USER_BACK_TEXT, effectiveHints, userAwayText } from '../../../src/core/hints/hint-registry.js'
import { getOp, listOps } from '../../../src/ops/index.js'

const hint: ThreadHintState = {
  threadId: 'th-aaaaaaaaaaaa', title: 'Star in Slack', created: true, followUp: false, duplicate: false,
  open: [{ id: 'th-bbbbbbbbbbbb', title: 'Other', state: 'answered' }], closed: [],
}
const MAIN = { org_role: 'main', project: 'Walnut' } as const
const LEAD = { org_role: 'lead', project: 'Walnut' } as const

describe('the rule says what the user said', () => {
  it('a thread\'s news goes to the thread only, away or not; a decision on it is its needs state; prompt only, no refusal', () => {
    expect(THREAD_ONE_PLACE_RULE).toMatch(/goes to that thread only/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/whether he is in your chat or away/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/never also a letter/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/decision about it is that thread's needs state/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/inbox is only for what needs him and has no thread/)
    expect(THREAD_ONE_PLACE_RULE).not.toMatch(/thread_instead|refuses/)
    // The old exception (a decision still a letter while he is away, named from the thread) is gone.
    expect(THREADS_OPEN_RULE).not.toMatch(/still goes to his inbox/)
    expect(THREADS_OPEN_RULE).toMatch(/never beside a letter about the same thing/)
  })
})

describe('every place a node reads it carries it', () => {
  it('Main\'s and every lead\'s prompt, through the away line', () => {
    expect(AWAY_INBOX_LINE).toContain(THREAD_ONE_PLACE_RULE)
    // In its prompt or the memory folder its away line's cap points to (nodeReads).
    for (const t of [MAIN, LEAD]) expect(nodeReads(t)).toContain(THREAD_ONE_PLACE_RULE)
    // A worker has no threads: none of it.
    expect(nodeReads({ project: 'Walnut' })).not.toContain(THREAD_ONE_PLACE_RULE)
  })

  it('the thread ops and human_inbox_send', () => {
    for (const name of ['thread_list', 'thread_update', 'thread_create', 'thread_split', 'thread_file']) {
      expect(getOp(name)?.description, name).toContain(THREAD_ONE_PLACE_RULE)
    }
    expect(getOp('human_inbox_send')?.description).toMatch(/One place per update[\s\S]*never also a letter/)
  })
})

/** Every text an Org node reads: its prompt, the hints, every op and param description, the built-in skills. */
function nodeTexts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  out.push({ where: 'prompt:main', text: nodeReads(MAIN) })
  out.push({ where: 'prompt:lead', text: nodeReads(LEAD) })
  out.push({ where: 'prompt:vp', text: nodeReads({ ...LEAD, org_vp_only: true } as never) })
  out.push({ where: 'hint:user-away', text: userAwayText(null) })
  out.push({ where: 'hint:user-back', text: USER_BACK_TEXT })
  out.push({ where: 'hint:threads', text: threadHintText(hint) })
  for (const h of effectiveHints({ session: {} } as never)) out.push({ where: `hint-description:${h.kind}`, text: h.description })
  for (const op of listOps({ includeDeprecated: true })) {
    out.push({ where: `op:${op.name}`, text: op.description })
    for (const [key, schema] of Object.entries(op.input ?? {})) {
      const d = (schema as { description?: string }).description
      if (d) out.push({ where: `op:${op.name}.${key}`, text: d })
    }
  }
  const roots = [path.resolve('src/data/skills'), path.resolve('src/integrations')]
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'SKILL.md') out.push({ where: path.relative(process.cwd(), p), text: fs.readFileSync(p, 'utf8') })
    }
  }
  for (const r of roots) if (fs.existsSync(r)) walk(r)
  return out
}

/**
 * A sentence that tells a node to send a thread's news to the inbox. "Thread" here is one of his
 * Threads; a letter's own thread (its replies), the absence's thread of letters and a board thread
 * are other things, so those phrases are taken out before the check.
 */
const OTHER_THREADS = /\b(?:letter(?:'s)? (?:own )?thread|thread of (?:the|that|this) (?:letter|absence)|(?:its|their|that letter's|the letter's|one|the same|the absence's|an away|the away|away|a board|board|slack|mail|email|inbox(?:'s)?) threads?|in (?:its|the letter's) thread|thread replies|thread reply|thread line|(?:is )?on none of (?:his|the user's) threads|(?:has|with) no (?:open )?thread|not on a thread|threaded|threads? of (?:the|its|his) (?:letter|inbox|mail)|human_inbox_reply)\b/gi
/** A send whose target is the inbox: "goes to his inbox", "send a letter", "use human_inbox_send for it", "copy it into his inbox". */
const TO_INBOX = /\b(?:goes|go|send|sends|sent|put|mail|letter|use|copy|notify|forward|tell|also)\b[^.;]{0,40}?\b(?:inbox|human_inbox_send|a letter|as a letter)\b/gi
/** Only a negation right before the verb undoes it ("never goes", "is not sent"), not one earlier in the sentence. */
const NEGATED_VERB = /\b(?:never|not|no|nor|don't|doesn't|neither)\s+(?:\w+\s+)?$/i
const RESULT_WHILE_AWAY = /\baway\b[\s\S]*\b(?:results?|updates?|answers?|summary|news)\b|\b(?:results?|updates?|answers?|summary|news)\b[\s\S]*\baway\b/i

function offenders(texts: Array<{ where: string; text: string }>): string[] {
  const bad: string[] = []
  for (const { where, text } of texts) {
    for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
      const s = raw.replace(OTHER_THREADS, ' ')
      // About one of his threads, a result while he is away, or "a result he asked for" (the old away rule in any words).
      if (!/\bthreads?\b/i.test(s) && !RESULT_WHILE_AWAY.test(s) && !/\bresults? (?:he|they|the user) asked for\b/i.test(s)) continue
      for (const m of s.matchAll(TO_INBOX)) {
        // "go here again, not to his inbox": a negation between the verb and the inbox undoes it too.
        if (!NEGATED_VERB.test(s.slice(0, m.index!)) && !/\b(?:not|never|nor)\b/i.test(m[0])) { bad.push(`${where}: ${raw.trim()}`); break }
      }
    }
  }
  return bad
}

describe('no text tells a node to send a thread\'s result to the inbox', () => {
  it('none of the prompts, hints, op descriptions or built-in skills', () => {
    expect(offenders(nodeTexts())).toEqual([])
  })

  it('none says Walnut refuses a letter about a thread: the rule is prompt text only', () => {
    expect(nodeTexts().filter((t) => /thread_instead/.test(t.text)).map((t) => t.where)).toEqual([])
  })

  it('the check catches the old wording and new ones like it', () => {
    const planted = [
      'An update that needs him then (a decision only he can make, something to review, a result he asked for) goes to his inbox with human_inbox_send.',
      'While he is away a decision still goes to his inbox as a letter: the thread names the letter (ref).',
      'When a thread\'s result is in and he is away, send it to his inbox too.',
      'Put the result in the thread summary and also send a letter with human_inbox_send.',
      // Rewordings the first scanner missed (the review of 2026-11-04).
      'When he is not in your chat, send the thread\'s result as a letter.',
      'Use human_inbox_send for a thread\'s result when he is away.',
      'While he is away, a finished result goes to his inbox with human_inbox_send.',
      'Copy the thread summary into his inbox too.',
      'Also notify him in the inbox about the thread\'s result.',
    ]
    const caught = offenders(planted.map((text, i) => ({ where: `planted:${i}`, text })))
    expect(planted.filter((_, i) => !caught.some((c) => c.startsWith(`planted:${i}:`)))).toEqual([])
    const fine = [
      THREAD_ONE_PLACE_RULE,
      'Walnut adds your letters of that absence to one thread and his phone buzzes once.',
      'reply in its thread instead, or pass resend_reason',
    ]
    expect(offenders(fine.map((text, i) => ({ where: `fine:${i}`, text })))).toEqual([])
  })
})

describe('THREADS_LINE keeps the thread rules', () => {
  it('still carries the open rule', () => {
    expect(THREADS_LINE).toContain(THREADS_OPEN_RULE)
  })
})
