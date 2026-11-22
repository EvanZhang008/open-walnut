/**
 * The phone answers a letter while the Mac is away, with the experiment `replica_takeover` on and
 * the real servers: once the companion leads the session's host and the Mac has been silent long
 * enough, the reply and the option picked go straight to the letter's session on the dev box, and
 * the Mac, back, records them on their letters and delivers nothing twice (the decision of
 * 2026-11-21, core/replica-takeover.ts).
 *
 * For each of the three ways the Mac goes away (sleep, network loss, shutdown; the world and the
 * ways: tests/helpers/live-twin-mac.ts), with two letters the Mac wrote (sender: session S on the
 * dev box, action_required, two options) already in the companion's copy:
 *   1. the companion leads devbox, the Mac has been silent for the takeover window (AFTER here),
 *      and the companion dropped the Mac's silent bridge (75 to 105 s, well inside the product's
 *      five minutes), so a relay provably does not go;
 *   2. the phone replies to one letter and picks an option on the other: each is a 200 with
 *      `delivery: queued` in S, never a 503 or a held turn; a retry of the reply's clientId
 *      delivers nothing again; S's CLI has each once while the Mac is still away;
 *   3. the Mac back drains the records: both turns are on its own letters (queued in S, the letter
 *      answered), and S's CLI still has each exactly once.
 * The switch off keeps every turn held: tests/e2e/letter-reply-mac-away-live-e2e.test.ts.
 * Only the Claude CLI is a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { liveWallsAvailable } from '../helpers/live-isolation.js'
import { inboxOf } from '../helpers/live-daemon.js'
import {
  KEEPER, S, T, WAYS, api, companionLeads, linkBothAliases, macGoes, macHoldsDevboxAgain, macIsUp, macReturns, phone,
  setupTwinMac, sleep, teardownTwinMac, waitFor, world, type Way,
} from '../helpers/live-twin-mac.js'

/** The takeover window here (five minutes in the product); the Mac's restart grace here (five minutes too). */
const AFTER = 30_000
const RESTART_GRACE = 20_000
const tagOf = (way: Way): string => way.replace(' ', '-')
const shipLabel = (way: Way): string => `Ship the notes now (${tagOf(way)})`

const FIRST_BOOT = `
  const store = await import(src('src/core/human-inbox/store.ts'))
  const sender = { sessionId: ${JSON.stringify(S)}, host: 'devbox', taskId: task.id, taskTitle: task.title, project: 'Acme' }
  out.letters = {}
  for (const tag of ${JSON.stringify(WAYS.map(tagOf))}) {
    const actions = [{ id: 'ship', label: 'Ship the notes now (' + tag + ')' }, { id: 'hold', label: 'Hold the notes (' + tag + ')' }]
    const talk = await store.sendLetter({ subject: 'Changelog wording (' + tag + ')', type: 'action_required', markdown: 'Which wording should the changelog use?', actions, sender })
    const pick = await store.sendLetter({ subject: 'Changelog timing (' + tag + ')', type: 'action_required', markdown: 'Ship the changelog now or hold it?', actions, sender })
    out.letters[tag] = { talk: talk.id, pick: pick.id }
  }
`

const letters = (way: Way): { talk: string; pick: string } => world.primary.out.letters[tagOf(way)]
const replyOf = (way: Way) => ({ clientId: `cl-take-${tagOf(way)}`, text: `Straight to the session while the Mac is ${way}` })
const got = () => inboxOf(world.devbox, S)
const timesAtCli = (text: string) => got().filter((m) => m.includes(text)).length

/** Whether some file under `dir` holds `needle` (the companion's copies). */
function someFileHolds(dir: string, needle: string): boolean {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === '.git' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)])
  return walk(dir).some((f) => { try { return fs.statSync(f).size < 5_000_000 && fs.readFileSync(f, 'utf8').includes(needle) } catch { return false } })
}

type Entry = { from: string; text: string; clientId?: string; delivery?: { status: string; held?: true; sessionId?: string } }
async function humanTurnsOn(s: 'companion' | 'primary', id: string): Promise<{ turns: Entry[]; letter: Record<string, any> }> {
  const r = s === 'companion' ? await phone(`/api/v1/human-inbox/${id}`) : await api(world.primary, `/api/v1/human-inbox/${id}`)
  const letter = (r.json.letter ?? r.json) as { thread?: Entry[] } & Record<string, any>
  return { turns: (letter.thread ?? []).filter((t) => t.from === 'human'), letter }
}

describe.skipIf(!liveWallsAvailable())('letter turns reach their session while the Mac is away (replica_takeover on; real servers, real daemon)', () => {
  beforeAll(() => setupTwinMac('wlt-', FIRST_BOOT, {
    macConfig: ['experimental:', '  replica_takeover: true'],
    macEnv: { WALNUT_LEADER_RESTART_GRACE_MS: String(RESTART_GRACE) },
    companionEnv: { WALNUT_TAKEOVER_AFTER_MS: String(AFTER) },
  }), 400_000)
  afterAll(() => teardownTwinMac(), 600_000)

  it('the Mac is up, both aliases linked, and the companion holds its letters and its switch', async () => {
    await macIsUp()
    await linkBothAliases()
    const ids = WAYS.flatMap((w) => Object.values(letters(w)))
    expect(ids).toHaveLength(6)
    await waitFor(() => ids.every((id) => someFileHolds(world.companion.data, id)), 180_000, 'the letters in the companion\'s copy')
    await waitFor(() => someFileHolds(path.join(world.companion.data, 'cache'), 'replica_takeover'), 180_000, 'the switch in the companion\'s config copy')
  }, 400_000)

  for (const way of WAYS) {
    it(`the Mac is ${way}: the reply and the option picked reach S's CLI at once, once, a retry adds nothing`, async () => {
      const { talk, pick } = letters(way)
      const reply = replyOf(way)
      await macGoes(way)
      // A shutdown tells the companion "restarting": it leads only after that grace.
      await waitFor(async () => (await companionLeads()).some((l) => l.host === KEEPER), 120_000 + RESTART_GRACE, 'the companion to lead devbox')
      await waitFor(async () => Date.now() - Number((await api(world.companion, '/api/leader')).json.primaryLastSeenAt) >= AFTER, AFTER + 60_000, 'the takeover window')
      await waitFor(async () => !(((await api(world.companion, '/api/v1/status')).json.bridgeHosts ?? []) as Array<{ hostAlias: string }>).some((b) => b.hostAlias === '__local__'), 120_000, 'the companion to drop the Mac\'s silent bridge')

      const r = await phone(`/api/v1/human-inbox/${talk}/human-reply`, { method: 'POST', body: JSON.stringify(reply) })
      expect(r.status, r.text.slice(0, 400)).toBe(200)
      expect(r.json.delivery).toMatchObject({ status: 'queued', sessionId: S })
      expect(r.ms).toBeLessThan(10_000)
      const a = await phone(`/api/v1/human-inbox/${pick}/answer`, { method: 'POST', body: JSON.stringify({ actionId: 'ship' }) })
      expect(a.status, a.text.slice(0, 400)).toBe(200)
      expect(a.json.delivery).toMatchObject({ status: 'queued', sessionId: S })
      const retry = await phone(`/api/v1/human-inbox/${talk}/human-reply`, { method: 'POST', body: JSON.stringify(reply) })
      expect(retry.status, retry.text.slice(0, 400)).toBe(200)

      await waitFor(() => timesAtCli(reply.text) > 0 && timesAtCli(shipLabel(way)) > 0, 60_000, 'both turns at S\'s CLI while the Mac is away')
      await sleep(T)
      expect(timesAtCli(reply.text)).toBe(1)
      expect(timesAtCli(shipLabel(way))).toBe(1)
      // The companion's letters show them in the session, not held for the Mac.
      const thread = await humanTurnsOn('companion', talk)
      expect(thread.turns).toMatchObject([{ clientId: reply.clientId, delivery: { status: 'queued', sessionId: S } }])
      const picked = await humanTurnsOn('companion', pick)
      expect(picked.letter.answered).toMatchObject({ actionId: 'ship' })
      expect(picked.turns[0]?.delivery).toMatchObject({ status: 'queued' })
    }, 600_000)

    it(`the Mac is back after being ${way}: it records both on its letters and S's CLI still has each once`, async () => {
      const { talk, pick } = letters(way)
      const reply = replyOf(way)
      await macReturns(way)
      await macHoldsDevboxAgain()
      const onMac = await waitFor(async () => {
        const t = await humanTurnsOn('primary', talk)
        // Recorded first, then its delivery (the companion's) set on it.
        return t.turns.some((x) => x.clientId === reply.clientId && x.delivery?.status !== 'pending') ? t : null
      }, 180_000, 'the reply on the Mac\'s letter, with its delivery')
      expect(onMac.turns).toMatchObject([{ clientId: reply.clientId, delivery: { status: 'queued', sessionId: S } }])
      const pickedOnMac = await waitFor(async () => {
        const t = await humanTurnsOn('primary', pick)
        return t.letter.answered?.actionId === 'ship' && t.turns[0]?.delivery?.status !== 'pending' ? t : null
      }, 180_000, 'the answer on the Mac\'s letter, with its delivery')
      expect(pickedOnMac.turns).toHaveLength(1)
      expect(pickedOnMac.turns[0].delivery).toMatchObject({ status: 'queued', sessionId: S })
      // Long enough for a second drain or a redelivery to show.
      await sleep(3 * T)
      expect(timesAtCli(reply.text)).toBe(1)
      expect(timesAtCli(shipLabel(way))).toBe(1)
    }, 400_000)
  }
})
