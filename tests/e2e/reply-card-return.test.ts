/**
 * A decision line after his words on its thread, through a real turn end with only the CLI faked
 * (experiment threads_reply_tag; src/core/org/reply-card-decision.ts, reply-card-stop.ts).
 *
 * 2026-11-25, a live walk (turn d): a thread waited on him with a decision; he wrote on it ("forget
 * that, ask me instead ..."); the session's line put it in needs again with the new question. The
 * store refused it with "Pass since_you_wrote ...", the session wrote since_you_wrote into its line,
 * and the line, which had no such attribute, was dropped with only a log row: the one send-back of
 * the turn was spent, and the decision reached him only through the status answer.
 *
 * Here: the send-back names, in the line's own attributes, everything the line lacks (since and
 * decision); the line again with since and decision="same" is written (needs again, the card
 * starting from the decision and what was done since he wrote); a line with decision="new" leaves
 * his message answered on its thread and opens the new decision as its own card; and a decision
 * line that cannot be read at the turn's end is named by the next status question.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reply-card-return', { IS_EPHEMERAL: true }))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { getTask } from '../../src/core/task-manager.js'
import { readThreads } from '../../src/core/org/threads-store.js'
import { applyReplyCards } from '../../src/core/org/reply-card.js'
import { CARD_STOP_LINES, cardStopReason } from '../../src/core/org/reply-card-stop.js'
import { ASKED_MARK, linesThatAsked } from '../../src/core/sessions/status-thread-asked.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'
import { cliTakes, filedUnder, flow, of, questionAfter, say, setTag, startFlow, stopFlow, stopHook, turnEnds } from '../helpers/reply-card-flow.js'

const SID = '5e55104a-0000-4000-8000-00000000d0d0'
const KIND = 'kind="spending" why="the dearer choice costs twice the budget he set"'
const WORKING = 'FOR_USER_STATE: working\nFOR_USER_NOW: Planning the basil.'

beforeAll(async () => {
  await startFlow({ sid: SID, title: 'Balcony basil helper', project: 'Garden' })
}, 40_000)

afterAll(stopFlow)

const threads = async (): Promise<OrgThread[]> => (await readThreads(flow.taskId)).threads
/** His Threads as his clients read them: the cards that wait on him now. */
async function waitingOnHim(): Promise<OrgThread[]> {
  const res = await fetch(`${flow.base}/api/v1/tasks/${flow.taskId}/threads`)
  expect(res.status).toBe(200)
  return ((await res.json()) as { threads: OrgThread[] }).threads.filter((t) => !t.closed && t.state === 'needs')
}

describe('a decision line after his words on its thread', () => {
  let basil = ''
  const POT = 'One big pot or three small ones for the basil?'
  const POT_LINE = (more = '') => `<walnut-card thread="${basil}" state="needs" ask="${POT}" options="One big pot (recommended); Three small pots" ${KIND}${more}/>`
  const SINCE = 'Dropped the planter comparison, as he asked.'

  it('the first decision goes up on its thread', async () => {
    await setTag(true, { threads_reminder: true, threads_one_card: true })
    await say('Terracotta trough or self-watering planter for the basil? Put it to me as a decision.')
    const rows = await cliTakes()
    basil = filedUnder(rows[0])
    flow.statusAnswer = WORKING
    const line = `<walnut-card thread="${basil}" state="needs" title="Basil planter" ask="Terracotta trough or self-watering planter for the basil?" options="Self-watering planter (recommended); Terracotta trough" ${KIND}/>`
    expect((await stopHook(`x\n\n${line}`)).decision).toBeUndefined()
    await questionAfter(await turnEnds(rows, `The self-watering one needs less care.\n\n${line}`))
    expect(of(await threads(), basil)).toMatchObject({ state: 'needs', ask: 'Terracotta trough or self-watering planter for the basil?' })
  }, 60_000)

  it('he writes on it; its line with no word on his message is sent back once, naming since and decision in the line\'s own words', async () => {
    await say('Actually forget the planter. Ask me instead whether I want one big pot or three small ones.', basil)
    const rows = await cliTakes()
    expect(filedUnder(rows[0])).toBe(basil)
    // His message took it off his Needs you.
    expect(of(await threads(), basil)?.state).not.toBe('needs')
    const held = await stopHook(`One big pot dries out more slowly.\n\n${POT_LINE()}`)
    expect(held.decision).toBe('block')
    const want = cardStopReason([CARD_STOP_LINES.returned(basil, ['since', 'decision'])])
    expect(held.reason).toBe(want)
    expect(held.reason).toContain('since="what you did about his message"')
    expect(held.reason).toContain('decision="same"')
    expect(held.reason).not.toMatch(/since_you_wrote|thread_update|walnut tools/)
    // Not written, and named for the next status question in case the corrected line fails too.
    expect(of(await threads(), basil)?.ask).toBe('Terracotta trough or self-watering planter for the basil?')
    expect(linesThatAsked(flow.taskId).has(basil)).toBe(true)

    // The line again, with what it lacked: the hook says nothing on a stop it caused, so the turn's end writes it.
    const endedAt = await turnEnds(rows, POT_LINE(` since="${SINCE}" decision="same"`))
    const q = await questionAfter(endedAt)
    const t = of(await threads(), basil)!
    expect(t).toMatchObject({ state: 'needs', ask: POT })
    expect(t.options?.map((o) => o.label)).toEqual(['One big pot', 'Three small pots'])
    // The card starts from the decision, then what was done since he wrote (the store's own order: thread-return.ts returnedReply).
    expect(t.reply).toMatch(new RegExp(`^${POT.replace(/[?]/g, '\\?')}\\n\\n\\*\\*Since your message at \\d\\d:\\d\\d UTC:\\*\\* ${SINCE}$`))
    expect(linesThatAsked(flow.taskId).has(basil)).toBe(false)
    expect((await waitingOnHim()).map((x) => x.id)).toEqual([basil])
    expect(q.prompt).toContain(`"${POT}"`)
  }, 60_000)

  it('the op\'s own name in a line reads the same: since_you_wrote is since', async () => {
    await say('Hmm, and if I go away for a week, does that change it?', basil)
    const rows = await cliTakes()
    const line = POT_LINE(` since_you_wrote="A week away is fine with the big pot." decision="same"`)
    expect((await stopHook(`x\n\n${line}`)).decision).toBeUndefined()
    await questionAfter(await turnEnds(rows, line))
    expect(of(await threads(), basil)?.reply).toContain('A week away is fine with the big pot.')
    expect((await waitingOnHim()).map((x) => x.id)).toEqual([basil])
  }, 60_000)

  it('decision="new" the store refuses leaves his message unanswered on its thread: no answered card with no decision behind it', async () => {
    await say('Or should I think about where it stands first?', basil)
    const rows = await cliTakes()
    // No kind on the line: thread_create's own door refuses the new thread.
    const line = `<walnut-card thread="${basil}" state="needs" title="Basil spot" ask="Windowsill or balcony rail for the basil?" options="Balcony rail (recommended); Windowsill" since="Noted that the spot may matter more." decision="new"/>`
    expect((await stopHook(`x\n\n${line}`)).decision).toBe('block')
    const after = await threads()
    expect(of(after, basil)?.state).not.toBe('answered')
    expect(of(after, basil)?.reply ?? '').not.toContain('Noted that the spot may matter more.')
    expect(after.filter((t) => t.id !== basil && !t.closed)).toHaveLength(0)
    // The turn goes on with the old decision asked again: the thread waits on him as before.
    await questionAfter(await turnEnds(rows, POT_LINE(` since="Noted that the spot may matter more." decision="same"`)))
    expect((await waitingOnHim()).map((x) => x.id)).toEqual([basil])
  }, 60_000)

  it('decision="new": his message is answered on its thread, and the new decision is its own card that supersedes it', async () => {
    await say('Forget pots. Ask me whether to grow it on the windowsill or the balcony rail.', basil)
    const rows = await cliTakes()
    const SPOT = 'Windowsill or balcony rail for the basil?'
    const line = `<walnut-card thread="${basil}" state="needs" title="Basil spot" ask="${SPOT}" options="Balcony rail (recommended); Windowsill" ${KIND} since="Set the pot question aside, as he asked." decision="new"/>`
    expect((await stopHook(`The rail gets more sun.\n\n${line}`)).decision).toBeUndefined()
    const after = await threads()
    expect(of(after, basil)).toMatchObject({ state: 'answered', reply: 'Set the pot question aside, as he asked.' })
    const opened = after.filter((t) => t.id !== basil && !t.closed)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ title: 'Basil spot', state: 'needs', ask: SPOT, opener: { from: 'node', by: `task:${flow.taskId}` } })
    expect(opened[0].options?.map((o) => [o.label, !!o.recommended])).toEqual([['Balcony rail', true], ['Windowsill', false]])
    expect(opened[0].askId).toMatch(/^ask-/)

    // The turn's end holds the line already written: nothing opens twice.
    const q = await questionAfter(await turnEnds(rows, `The rail gets more sun.\n\n${line}`))
    expect((await threads()).filter((t) => !t.closed && t.id !== basil)).toHaveLength(1)
    // One card for him, and the status question says it is up.
    expect((await waitingOnHim()).map((x) => x.id)).toEqual([opened[0].id])
    expect(q.prompt).toContain(`"${SPOT}"`)
    // Even with the hold lost (a restart between the check and the turn's end), the same line opens nothing more.
    const again = await applyReplyCards({ task: (await getTask(flow.taskId))!, sessionId: SID, reply: line })
    expect(again.opened).toEqual([])
    expect(again.refused).toEqual([])
    expect((await threads()).filter((t) => !t.closed && t.id !== basil)).toHaveLength(1)
  }, 60_000)

  it('decision="new" on a card still waiting on him, nothing of his since: the new card supersedes it, which leaves his Needs you', async () => {
    const [spot] = await waitingOnHim()
    const SOIL = 'Potting mix or garden soil for the basil?'
    const line = `<walnut-card thread="${spot.id}" state="needs" title="Basil soil" ask="${SOIL}" options="Potting mix (recommended); Garden soil" ${KIND} decision="new"/>`
    expect((await stopHook(`x\n\n${line}`)).decision).toBeUndefined()
    await questionAfter(await turnEnds([], `Potting mix drains better.\n\n${line}`))
    const cards = await waitingOnHim()
    expect(cards.map((t) => t.title)).toEqual(['Basil soil'])
    expect(cards[0]).toMatchObject({ ask: SOIL })
    // Replaced the store's way (thread-supersede.ts closeReplaced): closed, or pending while something of his is on it.
    const old = of(await threads(), spot.id)!
    expect(!!old.closed || old.state === 'pending', JSON.stringify(old)).toBe(true)
  }, 60_000)

  it('a decision line that cannot be read at the turn\'s end is named by the next status question', async () => {
    const [spot] = await waitingOnHim()
    await say('What about the kitchen window instead?', spot.id)
    const rows = await cliTakes()
    // No stop check ran (a hook from before it sent the last lines): the line is read at the turn's end only.
    const line = `<walnut-card thread="${spot.id}" state="needs" ask="Kitchen window or balcony rail?" options="Balcony rail; Kitchen window" ${KIND} colour="green"/>`
    const q = await questionAfter(await turnEnds(rows, `The kitchen window is shaded after noon.\n\n${line}`))
    expect(linesThatAsked(flow.taskId).has(spot.id)).toBe(true)
    expect(q.prompt).toContain(ASKED_MARK)
  }, 60_000)
})
