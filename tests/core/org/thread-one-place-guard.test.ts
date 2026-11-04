/**
 * Guard: one place per update, the thread first (2026-11-04, the user, after a VP sent each thread
 * result as a letter too while he was away: "Only choose one, put it in thread or inbox, don't
 * cluster and duplicate everything everywhere, inbox leave for something else ... if it is just a
 * thread just put it there without sending it to inbox").
 *
 * Fails when a place an Org node reads (its prompt, the user-away and threads hints, the thread ops,
 * human_inbox_send) loses THREAD_ONE_PLACE_RULE; when ANY text a node reads (every prompt line,
 * hint, op and param description, built-in skill) tells it again to send a thread's result to the
 * inbox, or that a result he asked for goes there while he is away; and when the pure gate
 * (human-inbox/thread-instead.ts) stops refusing a node's letter about an open thread, or starts
 * refusing one that is not about one. The server flow is tests/e2e/thread-instead.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { THREAD_ONE_PLACE_RULE, THREADS_OPEN_RULE } from '../../../src/core/org/thread-rules.js'
import { AWAY_INBOX_LINE, THREADS_LINE, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import { USER_BACK_TEXT, effectiveHints, userAwayText } from '../../../src/core/hints/hint-registry.js'
import { THREAD_JUST_UPDATED_MS, threadInsteadMessage, threadInsteadOf } from '../../../src/core/human-inbox/thread-instead.js'
import { emptyThreads, fileMessage, setAnswers, updateThread, type OrgThread } from '../../../src/core/org/threads-model.js'
import { getOp, listOps } from '../../../src/ops/index.js'

const hint: ThreadHintState = {
  threadId: 'th-aaaaaaaaaaaa', title: 'Star in Slack', created: true, followUp: false, duplicate: false,
  open: [{ id: 'th-bbbbbbbbbbbb', title: 'Other', state: 'answered' }], closed: [],
}
const MAIN = { org_role: 'main', project: 'Walnut' } as const
const LEAD = { org_role: 'lead', project: 'Walnut' } as const

describe('the rule says what the user said', () => {
  it('a thread\'s news goes to the thread only, away or not; a decision on it is its needs state; Walnut refuses the letter', () => {
    expect(THREAD_ONE_PLACE_RULE).toMatch(/goes to that thread only/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/whether he is in your chat or away/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/never also a letter/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/decision about it is that thread's needs state/)
    expect(THREAD_ONE_PLACE_RULE).toMatch(/inbox is only for what needs him and has no thread/)
    expect(THREAD_ONE_PLACE_RULE).toContain('thread_instead')
    // The old exception (a decision still a letter while he is away, named from the thread) is gone.
    expect(THREADS_OPEN_RULE).not.toMatch(/still goes to his inbox/)
    expect(THREADS_OPEN_RULE).toMatch(/never beside a letter about the same thing/)
  })
})

describe('every place a node reads it carries it', () => {
  it('Main\'s and every lead\'s prompt, through the away line', () => {
    expect(AWAY_INBOX_LINE).toContain(THREAD_ONE_PLACE_RULE)
    for (const t of [MAIN, LEAD]) expect(defaultInstructions(t)).toContain(THREAD_ONE_PLACE_RULE)
    // A worker has no threads: none of it.
    expect(defaultInstructions({ project: 'Walnut' })).not.toContain(THREAD_ONE_PLACE_RULE)
  })

  it('the user-away note and the threads hint on each of his messages', () => {
    expect(userAwayText(null)).toContain(THREAD_ONE_PLACE_RULE)
    expect(userAwayText(Date.parse('2026-11-04T00:00:00Z'))).toContain(THREAD_ONE_PLACE_RULE)
    for (const s of [hint, { ...hint, created: false, followUp: true }, { ...hint, open: [] }]) {
      expect(threadHintText(s)).toContain(THREAD_ONE_PLACE_RULE)
    }
  })

  it('the thread ops and human_inbox_send', () => {
    for (const name of ['thread_list', 'thread_update', 'thread_create', 'thread_split', 'thread_file']) {
      expect(getOp(name)?.description, name).toContain(THREAD_ONE_PLACE_RULE)
    }
    expect(getOp('human_inbox_send')?.description).toMatch(/One place per update[\s\S]*409 thread_instead/)
  })
})

/** Every text an Org node reads: its prompt, the hints, every op and param description, the built-in skills. */
function nodeTexts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  out.push({ where: 'prompt:main', text: defaultInstructions(MAIN) })
  out.push({ where: 'prompt:lead', text: defaultInstructions(LEAD) })
  out.push({ where: 'prompt:vp', text: defaultInstructions({ ...LEAD, org_vp_only: true } as never) })
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

describe('the gate (threadInsteadOf)', () => {
  const NOW = Date.parse('2026-11-04T01:00:00Z')
  const iso = (agoMin: number) => new Date(NOW - agoMin * 60_000).toISOString()
  const node = 'mvm0n3bu-6910'
  const vp = 'mvp0aaaa-1111'
  const info = (taskRefs: string[] = []) => ({ nodeTaskId: node, type: 'info' as const, taskRefs })
  /** His message, then the node's write `agoMin` ago: a summary (a result) unless `reply` is off. */
  function threads(by: string, agoMin: number, extra: Partial<OrgThread> = {}, opts: { reply?: boolean; tasks?: string[] } = {}): OrgThread[] {
    let f = fileMessage(emptyThreads(node), { text: 'star a slack channel', via: 'chat', at: iso(agoMin + 5) }).file
    f = updateThread(f, f.threads[0].id, {
      title: 'Slack stars', state: 'pending', add_tasks: opts.tasks ?? ['mthfqunw-d46a'], ...(opts.reply === false ? {} : { reply: 'Stars ship today' }),
    }, by as never, iso(agoMin)).file
    return [{ ...f.threads[0], ...extra }]
  }

  it('a letter naming a task of an open thread is refused, by full id or a prefix, however long ago the thread moved', () => {
    const t = threads(`task:${node}`, 600)
    expect(threadInsteadOf(info(['mthfqunw-d46a']), t, NOW)).toMatchObject({ threadId: t[0].id, why: 'task', taskId: 'mthfqunw-d46a' })
    expect(threadInsteadOf(info(['mthfqu']), t, NOW)).toMatchObject({ why: 'task' })
    // The node's own task in the pills says nothing; another task's letter goes.
    expect(threadInsteadOf(info([node]), t, NOW)).toBeNull()
    expect(threadInsteadOf(info(['a0619f18-b0dc']), t, NOW)).toBeNull()
    // A very short prefix is too loose to count.
    expect(threadInsteadOf(info(['mthf']), t, NOW)).toBeNull()
    // A decision naming it is the thread's too: its needs state.
    expect(threadInsteadOf({ ...info(['mthfqunw-d46a']), type: 'action_required' }, t, NOW)).toMatchObject({ why: 'task' })
  })

  it('a decision is the thread\'s only through a task that one open thread went to: a team\'s task on several threads, or named only in answers, may be asked about something new', () => {
    const team = '2be78a01-1dd2'
    const two = [...threads(`task:${node}`, 600, {}, { tasks: [team] }), ...threads(`task:${node}`, 600, { id: 'th-cccccccccccc' }, { tasks: [team] })]
    const decision = { ...info([team]), type: 'action_required' as const }
    expect(threadInsteadOf(decision, two, NOW)).toBeNull()
    expect(threadInsteadOf(decision, two.slice(0, 1), NOW)).toMatchObject({ why: 'task' })
    // A report naming it is a result of one of them either way.
    expect(threadInsteadOf(info([team]), two, NOW)).toMatchObject({ why: 'task' })
    let f = fileMessage(emptyThreads(node), { text: 'is the Mac ok', via: 'chat', at: iso(300) }).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Yes.', at: iso(299), about: [team] }]])).file
    expect(threadInsteadOf(decision, f.threads, NOW)).toBeNull()
  })

  it('a task the node\'s chat answer named in the thread ties a letter to it, as one it went to does', () => {
    let f = fileMessage(emptyThreads(node), { text: 'why does the mic fail', via: 'chat', at: iso(300) }).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Fixed in the voice task.', at: iso(299), about: ['2be78a01-1dd2'] }]])).file
    expect(threadInsteadOf(info(['2be78a01-1dd2']), f.threads, NOW)).toMatchObject({ why: 'task', threadId: f.threads[0].id })
  })

  it('a thread handed to a VP or lead does not tie that node\'s other work to it', () => {
    const t = threads('task:main-1', 600, {}, { tasks: [vp] })
    const isNode = (id: string) => id === vp
    expect(threadInsteadOf({ nodeTaskId: 'main-1', type: 'action_required', taskRefs: [vp] }, t, NOW, isNode)).toBeNull()
    expect(threadInsteadOf({ nodeTaskId: 'main-1', type: 'info', taskRefs: [vp, 'other-task-1'] }, t, NOW, isNode)).toBeNull()
    // Without the role it would have matched: the roles are what keeps it out.
    expect(threadInsteadOf({ nodeTaskId: 'main-1', type: 'action_required', taskRefs: [vp] }, t, NOW)).toMatchObject({ why: 'task' })
  })

  it('a report naming no task right after the node put a result in a thread is refused; later, his own write, a tidy-up or a decision goes', () => {
    expect(threadInsteadOf(info(), threads(`task:${node}`, 2), NOW)).toMatchObject({ why: 'just_updated' })
    expect(threadInsteadOf(info([node]), threads(`task:${node}`, 2), NOW)).toMatchObject({ why: 'just_updated' })
    for (const type of ['completion', 'review'] as const) {
      expect(threadInsteadOf({ ...info(), type }, threads(`task:${node}`, 1), NOW), type).toMatchObject({ why: 'just_updated' })
    }
    expect(threadInsteadOf(info(), threads(`task:${node}`, THREAD_JUST_UPDATED_MS / 60_000 + 1), NOW)).toBeNull()
    expect(threadInsteadOf(info(), threads('human', 1), NOW)).toBeNull()
    expect(threadInsteadOf(info(), threads('task:another-node', 1), NOW)).toBeNull()
    // A title, known or state change without a new summary is no result.
    expect(threadInsteadOf(info(), threads(`task:${node}`, 1, {}, { reply: false }), NOW)).toBeNull()
    // A decision naming no task may be about anything: only its tasks tie it to a thread.
    expect(threadInsteadOf({ ...info(), type: 'action_required' }, threads(`task:${node}`, 1), NOW)).toBeNull()
  })

  it('the node\'s chat answer filed in a thread is a result too', () => {
    let f = fileMessage(emptyThreads(node), { text: 'is it live?', via: 'chat', at: iso(30) }).file
    f = setAnswers(f, new Map([[f.threads[0].messages[0].id, { text: 'Live, video at /x/v.mp4', at: iso(3) }]])).file
    expect(threadInsteadOf(info(), f.threads, NOW)).toMatchObject({ why: 'just_updated', threadId: f.threads[0].id })
  })

  it('a closed thread holds nothing', () => {
    const closed = threads(`task:${node}`, 1, { closed: { how: 'acked', at: iso(0), by: 'human' } })
    expect(threadInsteadOf(info(['mthfqunw-d46a']), closed, NOW)).toBeNull()
    expect(threadInsteadOf(info(), closed, NOW)).toBeNull()
  })

  it('the refusal names the thread and the way: thread_update, needs for a decision, user_asked only for a letter he asked for', () => {
    const msg = threadInsteadMessage({ threadId: 'th-31b6fb91ab98', title: 'Slack stars', state: 'pending', why: 'task', taskId: 'mthfqunw-d46a' })
    expect(msg).toMatch(/^Not sent: it names mthfqunw-d46a, a task of the user's open thread th-31b6fb91ab98 "Slack stars"/)
    expect(msg).toContain('thread_update {"id":"th-31b6fb91ab98"')
    expect(msg).toMatch(/state "needs" with user_kind/)
    expect(msg).toMatch(/user_asked:true only when he asked in his own words for this as a letter/)
    expect(threadInsteadMessage({ threadId: 'th-1', title: 'x', state: 'working', why: 'just_updated' })).toMatch(/a report naming no task, and you just put a result in/)
  })
})

describe('THREADS_LINE keeps the thread rules', () => {
  it('still carries the open rule', () => {
    expect(THREADS_LINE).toContain(THREADS_OPEN_RULE)
  })
})
