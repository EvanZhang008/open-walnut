/**
 * What a session reads about the card line (experiment threads_reply_tag): the Threads rule in its
 * always-loaded prompt and the `threads` hint on each of his messages.
 *
 * Off: neither names the tag, and every prompt is what it is today. On: the rule of a session the
 * status question asks about its threads says its line for a thread is the card line that ends its
 * reply, the hint gives that line with the thread's id filled in, and a running session hears the
 * change through the instruction notice. The one thing Walnut asks for in a reply is this tag
 * form (tests/lib/internal-lines.test.ts lists the files that may name it).
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-reply-card-prompt'))
process.env.WALNUT_FLEET_PROMPT_REFRESH = '0'

import { WALNUT_HOME } from '../../../src/constants.js'
import { setThreadsKept } from '../../../src/core/org/threads-kept.js'
import { setReplyTag } from '../../../src/core/org/reply-card-switch.js'
import { setBriefOff } from '../../../src/core/org/brief-off.js'
import { threadHintText, type ThreadHintState } from '../../../src/core/org/thread-capture.js'
import {
  orgRoleLine, defaultInstructions, TASK_THREADS_KEPT_LINE, TASK_THREADS_LINE, TASK_THREADS_TAG_LINE, THREADS_KEPT_LINE, THREADS_TAG_LINE, THREADS_TAG_OFF_LINE,
} from '../../../src/core/sessions/session-context.js'
import { THREADS_KEPT_RULE, THREADS_KNOWN_RULE, THREADS_PENDING_RULE, THREADS_SUMMARY_RULE, THREADS_TAG_RULE, THREAD_ONE_PLACE_RULE } from '../../../src/core/org/thread-rules.js'
import { CARD_MAX, CARD_STATES, CARD_TAG_FORM, cardTagLine, readCardTags } from '../../../src/lib/card-tag.js'
import { STATUS_QUESTION } from '../../../src/lib/internal-lines.js'
import { dueChanges, parseInstructions, renderDue } from '../../../src/core/sessions/instruction-diff.js'
import { PROMPT_BUDGETS, promptBlock } from '../../../src/core/sessions/prompt-blocks.js'
import { composeRolePrompt, seedFixtureHome } from '../../helpers/prompt-size-fixture.js'

const lead = { id: 'lead-1', title: 'Garden VP', org_role: 'lead' as const }
const main = { ...lead, org_role: 'main' as const }
const task = { id: 't-1', title: 'Seed order', threads_on: true }
const plain = { id: 't-2', title: 'Fence posts' }
const perTurn = [THREADS_SUMMARY_RULE, THREADS_PENDING_RULE, THREADS_KNOWN_RULE, THREAD_ONE_PLACE_RULE]
const NAMES_THE_TAG = /walnut-card/

beforeAll(async () => { await seedFixtureHome(WALNUT_HOME) })
afterEach(() => { setThreadsKept(false); setReplyTag(false); setBriefOff(false) })

/** Every prompt variant a thread keeper can read, by name, under the switches as they are now. */
function variants(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const off of [false, true]) {
    setBriefOff(off)
    out.push([`lead, brief ${off ? 'off' : 'on'}`, orgRoleLine(lead as never)], [`main, brief ${off ? 'off' : 'on'}`, orgRoleLine(main as never)])
  }
  setBriefOff(false)
  out.push(['task with Threads', orgRoleLine(task as never)], ['task without Threads', orgRoleLine(plain as never)])
  out.push(['lead, whole instructions', defaultInstructions(lead as never)], ['task, whole instructions', defaultInstructions(task as never)])
  return out
}

describe('off: no text names the card line, and every prompt is today\'s', () => {
  it.each([[false], [true]])('threads kept by Walnut %s', (kept) => {
    setThreadsKept(kept)
    const before = variants()
    for (const [name, text] of before) expect(text, name).not.toMatch(NAMES_THE_TAG)
    // The switch read as off is the same as never read.
    setReplyTag(false)
    expect(variants()).toEqual(before)
  })

  it('the threads hint is today\'s text', () => {
    const s: ThreadHintState = { threadId: 'th-aaaaaa02', title: 'ok, now order', created: true, followUp: false, duplicate: false, open: [], closed: [] }
    for (const kept of [false, true]) {
      setThreadsKept(kept)
      expect(threadHintText(s)).not.toMatch(NAMES_THE_TAG)
      expect(threadHintText({ ...s, card: false })).toBe(threadHintText(s))
    }
  })
})

describe('on: the rule says the line for a thread is the card line that ends the reply', () => {
  it('Main and a lead where Walnut keeps their threads: only the kept rule changes', () => {
    setThreadsKept(true)
    const before = new Map(variants())
    setReplyTag(true)
    for (const [name, text] of variants()) {
      if (name === 'task without Threads') { expect(text).toBe(before.get(name)); continue }
      expect(text, name).toContain(THREADS_TAG_RULE)
      expect(text, name).not.toContain(THREADS_KEPT_RULE)
      for (const rule of perTurn) expect(text, `${name} still asks for a write each turn`).not.toContain(rule)
      if (!name.startsWith('task') && !name.includes('whole')) expect(text.replace(THREADS_TAG_RULE, THREADS_KEPT_RULE), name).toBe(before.get(name))
    }
    expect(orgRoleLine(task as never)).toBe(TASK_THREADS_TAG_LINE)
  })

  it('Main and a lead that write their threads themselves are not asked the status question, so nothing changes for them', () => {
    const before = new Map(variants())
    setReplyTag(true)
    const after = new Map(variants())
    for (const name of ['lead, brief on', 'lead, brief off', 'main, brief on', 'main, brief off', 'lead, whole instructions', 'task without Threads']) {
      expect(after.get(name), name).toBe(before.get(name))
    }
    // A task with Threads on is asked either way: its rule is the card line's.
    expect(after.get('task with Threads')).toBe(TASK_THREADS_TAG_LINE)
    expect(before.get('task with Threads')).toBe(TASK_THREADS_LINE)
  })

  it('the rule gives the form, each state, what the line may add, and what still needs thread_update', () => {
    expect(THREADS_TAG_RULE).toContain(CARD_TAG_FORM)
    for (const state of CARD_STATES) expect(THREADS_TAG_RULE, state).toContain(state)
    for (const attribute of ['summary=', 'title=', 'seen="yes"', 'merge=', 'ask=', 'options=', 'kind=', 'why=']) expect(THREADS_TAG_RULE, attribute).toContain(attribute)
    expect(THREADS_TAG_RULE).toContain(`at most ${CARD_MAX}`)
    expect(THREADS_TAG_RULE).toContain('&quot;')
    // 2026-11-26, real use: in a turn no message of his started, sessions wrote thread="none" or a placeholder.
    expect(THREADS_TAG_RULE).toContain('The thread id is the one the note on his message gives: with none at hand, write no line, never a made-up id.')
    // A sample on a line of its own would be read as a real line (and sent back as no thread of the task).
    expect(THREADS_TAG_RULE).toContain('A card line shown as an example goes in backticks or a code block.')
    expect(THREADS_TAG_RULE).toMatch(/Call thread_update yourself only for what the line cannot do: a close he asked for in his own words/)
    // Every other rule that names "its line in Walnut's status question" is told where the line now goes.
    expect(THREADS_TAG_RULE).toContain(`Where these rules name a thread's line, this is it; ${STATUS_QUESTION} asks only about the open threads you gave none.`)
    // No report field is named, and nothing puts a line "at the turn's end" (tests/lib/internal-lines.test.ts).
    expect(THREADS_TAG_RULE).not.toMatch(/FOR_USER_/)
    expect(THREADS_TAG_RULE).not.toMatch(/at (?:the|this|each|every|your|its) turn(?:'s)? end|at the end of (?:the|this|each|every|your|its) turn/i)
  })

  // 2026-11-25, a live session: after a thread_split its reply told him "I moved your compost
  // question into its own thread". The card shows that; the chat is for his answer.
  it('the rule keeps what a session did to a thread out of its reply, and a held turn end is no reason for thread_update', () => {
    expect(THREADS_TAG_RULE).toContain('Your reply holds no other list of threads and no word of what you did to one (its line, a split, a merge, a mark) unless he asks: his cards show it.')
    // Who has his ask now is still his to hear: a thread that went to another node with its work is no upkeep.
    expect(THREADS_TAG_RULE).not.toMatch(/what you did to one \([^)]*\bmove\b/)
    // A held turn end asks such a session for card lines only (tests/core/org/stop-checks-guard.test.ts).
    expect(THREADS_TAG_RULE).toContain('When Walnut could not ask you (a "threads to tidy" note names threads), write what it names with thread_update.')
    expect(THREADS_TAG_RULE).not.toContain('held turn end')
    expect(THREADS_KEPT_RULE).toContain('or a held turn end, names threads')
  })

  it('the example decision in the rule is a line Walnut reads', () => {
    const line = '<walnut-card thread="th-0a1b2c3d4e5f" state="needs" ask="what he decides" options="Larch; Oak" kind="spending" why="oak is twice the budget"/>'
    for (const part of ['state="needs"', 'ask="what he decides"', 'options="Larch; Oak"']) expect(THREADS_TAG_RULE).toContain(part)
    expect(readCardTags(`Pick one.\n${line}`)).toMatchObject({ errors: [], cards: [{ state: 'needs', options: ['Larch', 'Oak'] }] })
  })

  it('the hint gives the line with the thread\'s id filled in, after today\'s words', () => {
    const s: ThreadHintState = { threadId: 'th-aaaaaa02', title: 'Spring seed order', created: false, followUp: true, duplicate: false, open: [], closed: [] }
    setThreadsKept(true)
    const today = threadHintText(s)
    const asked = threadHintText({ ...s, card: true })
    expect(asked).toBe(`${today} End your reply with: ${cardTagLine('th-aaaaaa02')} (state: working, waiting, answered, done).`)
    // The line it gives is one Walnut reads.
    expect(readCardTags(`Done.\n${cardTagLine('th-aaaaaa02')}`).cards).toEqual([{ thread: 'th-aaaaaa02', state: 'answered' }])
    expect(asked.length - today.length).toBeLessThan(130)
  })

  // 2026-11-25, a real session on an isolated server: "filed as new thread th-.... Give it a short
  // title (thread_update). End your reply with: <walnut-card .../>" asked for the title twice, by
  // two ways. With the line asked, a thread with no title of its own gets it in the line.
  describe('a thread with no title of its own: the title rides the line, never a thread_update beside it', () => {
    const fresh: ThreadHintState = { threadId: 'th-aaaaaa02', title: 'ok, now order the seeds', created: true, followUp: false, duplicate: false, open: [], closed: [], card: true, untitled: true }
    const open = [{ id: 'th-aaaaaa01', title: 'Orchard fence', state: 'answered' as const }, { id: 'th-aaaaaa03', title: 'Shed colour', state: 'working' as const }]

    it.each([[false], [true]])('a new thread, threads kept by Walnut %s: one instruction, in the line', (kept) => {
      setThreadsKept(kept)
      const text = threadHintText(fresh)
      expect(text).toBe('filed as new thread th-aaaaaa02. End your reply with: <walnut-card thread="th-aaaaaa02" state="answered" title="..."/> (state: working, waiting, answered, done; title: a short one of your own).')
      expect(text).not.toMatch(/thread_update|Give it a short title/)
      // Filled in, it is a line Walnut reads, title and all.
      expect(readCardTags('Done.\n<walnut-card thread="th-aaaaaa02" state="working" title="Spring seed order"/>')).toMatchObject({ errors: [], cards: [{ thread: 'th-aaaaaa02', state: 'working', title: 'Spring seed order' }] })
      // What it costs a message over today's words for the same thread.
      const today = threadHintText({ ...fresh, card: false })
      expect(Buffer.byteLength(text) - Buffer.byteLength(today)).toBeLessThanOrEqual(kept ? 170 : 130)
    })

    it.each([[false], [true]])('a new thread beside open ones, threads kept by Walnut %s: the merge is the line too', (kept) => {
      setThreadsKept(kept)
      const text = threadHintText({ ...fresh, open })
      expect(text).toBe('filed as new thread th-aaaaaa02. Open: th-aaaaaa01 "Orchard fence"; th-aaaaaa03 "Shed colour". '
        + 'End your reply with: <walnut-card thread="th-aaaaaa02" state="answered" title="..."/> (state: working, waiting, answered, done; title: a short one of your own). '
        + 'Same subject as an open one: <walnut-card thread="th-aaaaaa02" merge="th-..."/> alone instead.')
      expect(text).not.toMatch(/thread_update|give it a short title/i)
      expect(readCardTags('It is the fence.\n<walnut-card thread="th-aaaaaa02" merge="th-aaaaaa01"/>')).toMatchObject({ errors: [], cards: [{ thread: 'th-aaaaaa02', merge: 'th-aaaaaa01' }] })
      const today = threadHintText({ ...fresh, open, card: false })
      expect(Buffer.byteLength(text) - Buffer.byteLength(today)).toBeLessThanOrEqual(kept ? 220 : 195)
    })

    // 2026-11-25, the live server: the related threads still gave the join as a thread_update,
    // beside the line's merge a sentence later.
    it('related threads beside it: joining one of the node\'s own is the line\'s merge too, and today\'s words stay with no line asked', () => {
      setThreadsKept(false)
      const related = [
        { id: 'th-aaaaaa01', title: 'Orchard fence', state: 'answered' as const, lanes: ['words' as const] },
        { id: 'th-bbbbbb07', title: 'Fence paint', state: 'working' as const, lanes: ['words' as const], task: { id: 't-9', title: 'Paint order' } },
      ]
      const text = threadHintText({ ...fresh, open, related })
      expect(text).toBe('filed as new thread th-aaaaaa02. Open: th-aaaaaa01 "Orchard fence"; th-aaaaaa03 "Shed colour". '
        + 'Related threads (its subject is one of yours: its line with merge="<id>" alone; another task\'s: that task keeps it, task_send it): th-aaaaaa01 (yours); th-bbbbbb07 "Fence paint" (working, on "Paint order" t-9). '
        + 'End your reply with: <walnut-card thread="th-aaaaaa02" state="answered" title="..."/> (state: working, waiting, answered, done; title: a short one of your own). '
        + 'Same subject as an open one: <walnut-card thread="th-aaaaaa02" merge="th-..."/> alone instead.')
      expect(text).not.toMatch(/thread_update|merge_into/)
      const today = threadHintText({ ...fresh, open, related, card: false })
      expect(today).toContain('Related threads (its subject is one of yours: thread_update {"id":"th-aaaaaa02","merge_into":"<id>"}; another task\'s: that task keeps it, task_send it): ')
      // The line's way is the shorter one.
      expect(Buffer.byteLength(text) - Buffer.byteLength(today)).toBeLessThanOrEqual(195)
    })

    it('a follow-up in a thread that still has none asks for it the same way, and one that has a title does not', () => {
      setThreadsKept(true)
      const follow = { ...fresh, created: false, followUp: true }
      expect(threadHintText(follow)).toBe('a follow-up in thread th-aaaaaa02 "ok, now order the seeds", filed there. End your reply with: <walnut-card thread="th-aaaaaa02" state="answered" title="..."/> (state: working, waiting, answered, done; title: a short one of your own).')
      const { untitled: _, ...titled } = follow
      expect(threadHintText(titled)).not.toContain('title=')
    })

    it('no line asked: the mark changes nothing, the words are today\'s', () => {
      for (const kept of [false, true]) {
        setThreadsKept(kept)
        const { card: _c, untitled: _u, ...plainHint } = { ...fresh, open }
        expect(threadHintText({ ...plainHint, untitled: true })).toBe(threadHintText(plainHint))
        expect(threadHintText({ ...plainHint, untitled: true })).toMatch(/thread_update merge_into/)
      }
    })
  })
})

describe('a running session hears the switch', () => {
  it('a lead: the new rule is told, and says it replaces the earlier ones', () => {
    setThreadsKept(true)
    const before = parseInstructions(defaultInstructions(lead as never))
    setReplyTag(true)
    const due = dueChanges(parseInstructions(defaultInstructions(lead as never)), before, new Set(), {})
    expect(due).not.toBeNull()
    const told = renderDue(due!)
    expect(told).toContain(CARD_TAG_FORM)
    expect(told).toContain('in place of the earlier rules that had you write each thread\'s summary, state and known mark with thread_update every turn, or give its line only when asked (those no longer apply)')
  })

  it('a lead hears it turned off again: the kept rule comes back', () => {
    setThreadsKept(true)
    setReplyTag(true)
    const before = parseInstructions(defaultInstructions(lead as never))
    setReplyTag(false)
    const due = dueChanges(parseInstructions(defaultInstructions(lead as never)), before, new Set(), {})
    expect(renderDue(due!)).toContain(THREADS_KEPT_RULE.slice(0, 80))
  })

  it('a task: its Threads block is another version in each mode', () => {
    const versions = [TASK_THREADS_LINE, TASK_THREADS_KEPT_LINE, TASK_THREADS_TAG_LINE].map((l) => l.split('\n')[0])
    expect(new Set(versions).size).toBe(3)
    expect(TASK_THREADS_TAG_LINE).toMatch(/^Threads, the user's setting for your task \(v[0-9a-f]{8}\): /)
  })
})

describe('the always-loaded prompt stays within its caps with the rule in it', () => {
  it.each(['main', 'lead'] as const)('%s: the role block within its cap, the prompt within its budget', async (role) => {
    setThreadsKept(true)
    const kept = await composeRolePrompt(role)
    setReplyTag(true)
    for (const off of [false, true]) {
      setBriefOff(off)
      const p = await composeRolePrompt(role)
      expect(p.text).toContain(THREADS_TAG_RULE)
      for (const b of p.blocks) expect(b.chars, `${role}: block ${b.id}`).toBeLessThanOrEqual(promptBlock(b.id).cap)
      expect(p.chars, role).toBeLessThanOrEqual(PROMPT_BUDGETS[role])
    }
    setBriefOff(false)
    // What the rule adds to every prompt of such a node (reported with the change): the two rules' difference.
    const grown = (await composeRolePrompt(role)).chars - kept.chars
    expect(grown).toBe(THREADS_TAG_RULE.length - THREADS_KEPT_RULE.length)
    expect(grown).toBeLessThan(900)
  })

  it('the lines of the two views differ only by where the Threads are shown', () => {
    expect(THREADS_TAG_LINE).toContain(THREADS_TAG_RULE)
    expect(THREADS_TAG_OFF_LINE).toContain(THREADS_TAG_RULE)
    expect(THREADS_TAG_LINE.replace(THREADS_TAG_RULE, THREADS_KEPT_RULE)).toBe(THREADS_KEPT_LINE)
  })
})
