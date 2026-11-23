/**
 * The phone answers a letter while the Mac is away, with the real servers: the companion takes
 * the turn at once and keeps it for the Mac, and the Mac, back, hands it to the letter's session
 * in order and once.
 *
 * 2026-11-20: two replies on the phone's Action needed page sat on "Sending" with
 * `bridge request timed out: session.control → __local__` while the Mac slept: the companion
 * relayed each turn to the sleeping Mac for its whole budget, and an answer came back as the raw
 * relay timeout (a 503). Here, for each of the three ways the Mac goes away (sleep, network loss,
 * shutdown; the world and the ways: tests/helpers/live-twin-mac.ts), with two letters the Mac
 * wrote (sender: session S on the dev box, action_required, two options) already in the
 * companion's copy:
 *   1. the phone replies twice to one letter (two clientIds, in order) and picks an option on the
 *      other: each answer is a 202 within 4 s with `delivery.held`, never a 503, never the raw
 *      relay error; a retry of the first reply's clientId adds no turn;
 *   2. the companion's letter shows the turns held;
 *   3. the Mac back drains them: S's CLI gets both replies in order and the answer, each once, and
 *      the companion's letter, once its copy has the Mac's, shows them delivered, no longer held;
 *      no read of the letter meanwhile comes back without them (2026-11-22: the companion forwarded
 *      the read to the Mac before it drained, and the phone dropped the turns for 15 s).
 * Only the Claude CLI is a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { liveWallsAvailable } from '../helpers/live-isolation.js'
import { inboxOf } from '../helpers/live-daemon.js'
import {
  S, T, WAYS, companionHearsMac, linkBothAliases, macGoes, macHoldsDevboxAgain, macIsUp, macReturns, phone,
  setupTwinMac, sleep, teardownTwinMac, waitFor, world, type Reply, type Way,
} from '../helpers/live-twin-mac.js'

const tagOf = (way: Way): string => way.replace(' ', '-')
/** The label of the option the phone picks, as the first boot writes it. */
const shipLabel = (way: Way): string => `Ship the notes (${tagOf(way)})`

/** The first boot writes two letters per way, from S, as a session's human_inbox_send does. */
const FIRST_BOOT = `
  const store = await import(src('src/core/human-inbox/store.ts'))
  const sender = { sessionId: ${JSON.stringify(S)}, host: 'devbox', taskId: task.id, taskTitle: task.title, project: 'Acme' }
  out.letters = {}
  for (const tag of ${JSON.stringify(WAYS.map(tagOf))}) {
    const actions = [{ id: 'ship', label: 'Ship the notes (' + tag + ')' }, { id: 'hold', label: 'Hold the notes (' + tag + ')' }]
    const talk = await store.sendLetter({ subject: 'Release notes wording (' + tag + ')', type: 'action_required', markdown: 'Which wording should the notes use?', actions, sender })
    const pick = await store.sendLetter({ subject: 'Release notes timing (' + tag + ')', type: 'action_required', markdown: 'Ship the notes now or hold them?', actions, sender })
    out.letters[tag] = { talk: talk.id, pick: pick.id }
  }
`

const letters = (way: Way): { talk: string; pick: string } => world.primary.out.letters[tagOf(way)]
const replies = (way: Way) => [1, 2].map((n) => ({ clientId: `cl-${tagOf(way)}-${n}`, text: `Reply ${n} from the phone while the Mac is ${way}` }))
const RAW_RELAY = /bridge request timed out|session\.control/

/** Every letter id named in some copy of the inbox index the companion holds. */
function companionHolds(ids: string[]): boolean {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === '.git' ? [] : walk(path.join(dir, e.name))) : e.name === 'index.json' ? [path.join(dir, e.name)] : [])
  const texts = walk(world.companion.data).map((f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } })
  return ids.every((id) => texts.some((t) => t.includes(id)))
}

/** What is wrong with the answer to a turn the phone sent while the Mac is away (none: held at once). */
function heldProblems(what: string, r: Reply): string[] {
  const out: string[] = []
  if (RAW_RELAY.test(r.text)) out.push(`${what}: the raw relay error reached the phone: ${r.text.slice(0, 300)}`)
  if (r.status !== 202) out.push(`${what}: ${r.status}, not 202: ${r.text.slice(0, 300)}`)
  else if (r.json.delivery?.status !== 'pending' || r.json.delivery?.held !== true) out.push(`${what}: delivery ${JSON.stringify(r.json.delivery)}, not held`)
  if (r.ms >= 4_000) out.push(`${what}: answered in ${r.ms} ms, not within 4 s`)
  return out
}

type Entry = { from: string; text: string; clientId?: string; delivery?: { status: string; held?: true } }
const humanTurns = async (id: string): Promise<{ status: number; turns: Entry[]; json: Record<string, any>; text: string }> => {
  const r = await phone(`/api/v1/human-inbox/${id}`)
  const letter = (r.json.letter ?? r.json) as { thread?: Entry[] }
  return { status: r.status, turns: (letter.thread ?? []).filter((t) => t.from === 'human'), json: r.json, text: r.text }
}

describe.skipIf(!liveWallsAvailable())('the phone answers letters while the Mac is away (real servers, real daemon)', () => {
  beforeAll(() => setupTwinMac('wlr-', FIRST_BOOT), 400_000)
  afterAll(() => teardownTwinMac(), 600_000)

  it('the Mac is up, both aliases linked, and the companion holds every letter the Mac wrote', async () => {
    await macIsUp()
    await linkBothAliases()
    const ids = WAYS.flatMap((w) => Object.values(letters(w)))
    expect(ids).toHaveLength(6)
    await waitFor(() => companionHolds(ids), 180_000, 'the letters in the companion\'s copy')
  }, 400_000)

  for (const way of WAYS) {
    it(`the Mac is ${way}: the phone's replies and answer are held by the companion at once, a retry adds nothing`, async () => {
      const { talk, pick } = letters(way)
      await macGoes(way)
      // The companion's one view of the Mac: what the fix keys on, and what a real outage gives.
      await waitFor(async () => !(await companionHearsMac()), 120_000, 'the companion to know the Mac does not answer')
      const problems: string[] = []
      for (const r of replies(way)) {
        problems.push(...heldProblems(`reply ${r.clientId}`, await phone(`/api/v1/human-inbox/${talk}/human-reply`, { method: 'POST', body: JSON.stringify(r) })))
      }
      problems.push(...heldProblems('answer', await phone(`/api/v1/human-inbox/${pick}/answer`, { method: 'POST', body: JSON.stringify({ actionId: 'ship' }) })))
      // The phone retries the first reply (a lost response): the same turn, not a second one.
      const retry = await phone(`/api/v1/human-inbox/${talk}/human-reply`, { method: 'POST', body: JSON.stringify(replies(way)[0]) })
      problems.push(...heldProblems('retry of the first reply', retry))
      expect(problems).toEqual([])

      const thread = await humanTurns(talk)
      expect(thread.status, thread.text.slice(0, 300)).toBe(200)
      expect(thread.turns.map((t) => t.clientId)).toEqual(replies(way).map((r) => r.clientId))
      for (const t of thread.turns) expect(t.delivery, t.clientId).toMatchObject({ status: 'pending', held: true })
      const picked = await humanTurns(pick)
      expect(picked.json.letter?.answered ?? picked.json.answered).toMatchObject({ actionId: 'ship' })
      expect(picked.turns).toHaveLength(1)
      expect(picked.turns[0].delivery).toMatchObject({ status: 'pending', held: true })
    }, 300_000)

    it(`the Mac is back after being ${way}: S's CLI gets both replies in order and the answer, each once, and the turns read delivered`, async () => {
      const { talk, pick } = letters(way)
      const [first, second] = replies(way)
      const label = shipLabel(way)
      // Every read of the letter from the moment the Mac is back shows both replies. 2026-11-22: for
      // 15 s after the Mac woke the companion forwarded the phone's read to the Mac, whose letter did
      // not hold them yet; the phone dropped the turns, and its page jumped.
      const lost: string[] = []
      let watching = true
      const watch = (async () => {
        while (watching) {
          const t = await humanTurns(talk).catch(() => null)
          const ids = t?.status === 200 ? t.turns.map((x) => x.clientId) : null
          if (ids && !(ids.includes(first.clientId) && ids.includes(second.clientId))) lost.push(`${Date.now()}: ${JSON.stringify(ids)}`)
          await sleep(200)
        }
      })()
      try {
        await macReturns(way)
        await macHoldsDevboxAgain()
        const got = () => inboxOf(world.devbox, S)
        await waitFor(() => got().some((m) => m.includes(second.text)) && got().some((m) => m.includes(label)), 180_000, 'the turns at S\'s CLI')
        // Long enough for a second drain or a redelivery to show.
        await sleep(2 * T)
        const lines = got()
        for (const text of [first.text, second.text, label]) expect(lines.filter((m) => m.includes(text)), text).toHaveLength(1)
        // In order: the session's queue may hand both to the CLI as one message, first then second.
        const all = lines.join('\n')
        expect(all.indexOf(first.text)).toBeLessThan(all.indexOf(second.text))
        // The companion's letter, once its copy holds the Mac's turns: delivered, no longer held.
        const settled = (turns: Entry[]) => turns.length > 0 && turns.every((t) => t.delivery && t.delivery.status !== 'pending' && t.delivery.held === undefined)
        const thread = await waitFor(async () => { const t = await humanTurns(talk); return settled(t.turns) ? t : null }, 180_000, 'the companion to read the replies delivered')
        expect(thread.turns.map((t) => t.clientId)).toEqual([first.clientId, second.clientId])
        const picked = await waitFor(async () => { const t = await humanTurns(pick); return settled(t.turns) ? t : null }, 180_000, 'the companion to read the answer delivered')
        expect(picked.turns).toHaveLength(1)
      } finally {
        watching = false
        await watch
      }
      expect(lost, 'reads of the letter that lost the held replies after the Mac was back').toEqual([])
    }, 400_000)
  }
})
