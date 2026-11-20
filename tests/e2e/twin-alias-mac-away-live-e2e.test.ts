/**
 * One machine's daemon reached by the Mac under TWO host aliases, and the Mac goes away three
 * ways: the phone still talks to that machine's session through the cloud companion.
 *
 *   primary (real Walnut server, child process) + its own local daemon
 *     ├──► devbox        (config row the person added and named)   ─┐ two links, two URLs
 *     └──► devbox-found  (row found in ~/.ssh/config, discovered)  ─┴► ONE daemon (session S)
 *   companion (real Walnut server, WALNUT_CLOUD_MODE=1) ◄── /bridge from both daemons
 *
 * 2026-11-20: `clouddev` (the person's row, every session) and `newdev` (discovered) reached one
 * daemon. Each link pushed bridge.configure under its own alias and token, so the daemon's bridge
 * to the companion took the name of whichever pushed last (about 230 swaps a day), and each pushed
 * a read copy of its own alias's sessions only. The Mac's lid closed right after `newdev` pushed:
 * for the whole outage the companion knew the machine only as `newdev`, and the phone opening a
 * `clouddev` session got "clouddev unreachable". Here the discovered alias links LAST on purpose.
 *
 * For each of the three ways the Mac goes away (sleep, network loss, shutdown; the world and the
 * ways: tests/helpers/live-twin-mac.ts), the phone (a device token on the companion's /api/v1)
 * reads S, opens its stream, sends a message and answers a tool prompt; then the Mac returns and
 * nothing reached the CLI twice. Only the Claude CLI is a mock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { liveWallsAvailable } from '../helpers/live-isolation.js'
import { inboxOf, respOf } from '../helpers/live-daemon.js'
import { LEADER_RESTART_GRACE_MS } from '../../src/core/leader/protocol.js'
import {
  KEEPER, S, T, WAYS, api, bridgeAliases, companionLeads, linkBothAliases, macGoes, macHoldsDevboxAgain, macIsUp, macReturns, phone,
  setupTwinMac, sleep, sliceSids, teardownTwinMac, waitFor, world, type Reply, type Way,
} from '../helpers/live-twin-mac.js'

const REPLY = 'The message reached the CLI.'
/** Every text the phone sent, for the check that nothing reached the CLI twice. */
const sentTexts: string[] = []
let answeredPrompts = 0

interface PhoneStream { events: Array<{ event: string; data: Record<string, any>; at: number }>; close: () => void }
/** The phone's conversation stream (GET /api/v1/sessions/:id/stream, SSE). */
async function openPhoneStream(sid: string): Promise<PhoneStream> {
  const controller = new AbortController()
  const res = await fetch(`http://127.0.0.1:${world.companion.port}/api/v1/sessions/${sid}/stream`, { signal: controller.signal, headers: { Authorization: `Bearer ${world.tokens.phone}` } })
  expect(res.status).toBe(200)
  const events: PhoneStream['events'] = []
  const reader = res.body!.getReader()
  void (async () => {
    let buf = ''
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) return
        buf += decoder.decode(part.value, { stream: true })
        let end: number
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, end)
          buf = buf.slice(end + 2)
          const event = /^event: (.+)$/m.exec(frame)?.[1]
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (event) events.push({ event, data: data ? JSON.parse(data) : {}, at: Date.now() })
        }
      }
    } catch { /* aborted */ }
  })()
  return { events, close: () => controller.abort() }
}

/** While the Mac is away: the phone reads S, streams it, sends to it and answers its prompt, all through the companion. */
async function phoneTalksToS(way: Way): Promise<void> {
  const tag = way.replace(' ', '-')
  const offline: string[] = []
  const note = (what: string, r: Reply) => { if (r.status === 503 || r.json?.error?.code === 'bridge_offline') offline.push(`${what}: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`) }
  // A graceful stop announced a restart: the companion waits that out first (backup-leader.ts).
  const leadWithin = way === 'shut down' ? LEADER_RESTART_GRACE_MS + 6 * T : 6 * T
  // The takeover, under whichever name the companion knows the daemon by: what the phone then
  // meets is the check (2026-11-20: it led `newdev`, and the phone read `clouddev` unreachable).
  await waitFor(async () => (await companionLeads()).length > 0, leadWithin, 'the companion to take the lead')

  const detail = await phone(`/api/v1/sessions/${S}`)
  note('read', detail)
  expect(detail.status, JSON.stringify(detail.json).slice(0, 400)).toBe(200)
  const stream = await openPhoneStream(S)
  try {
    await waitFor(() => stream.events.length > 0, 15_000, 'the stream\'s first event')
    expect(stream.events[0].event, `${KEEPER} must not read unreachable: ${JSON.stringify(stream.events.slice(0, 3))}`).toBe('bridge-online')

    const text = `From the phone while the Mac is ${way}`
    const sentAt = Date.now()
    const sent = await phone(`/api/v1/sessions/${S}/messages`, { method: 'POST', body: JSON.stringify({ text, messageId: `qm-${tag}-say` }) })
    note('send', sent)
    expect(sent.status, JSON.stringify(sent.json).slice(0, 400)).toBe(202)
    sentTexts.push(text)
    await waitFor(() => inboxOf(world.devbox, S).some((m) => m.includes(text)), 30_000, 'the message at the CLI')
    await waitFor(() => stream.events.some((e) => e.at >= sentAt && e.event === 'text-delta' && e.data.delta === REPLY), 30_000, 'the streamed reply')
    await waitFor(() => stream.events.some((e) => e.at >= sentAt && e.event === 'turn-end'), 30_000, 'the turn\'s end on the stream')

    const answersBefore = respOf(world.devbox, S).length
    const ask = `ASK: list the docs while the Mac is ${way}`
    const asked = await phone(`/api/v1/sessions/${S}/messages`, { method: 'POST', body: JSON.stringify({ text: ask, messageId: `qm-${tag}-ask` }) })
    note('ask', asked)
    expect(asked.status, JSON.stringify(asked.json).slice(0, 400)).toBe(202)
    sentTexts.push(ask)
    const prompt = await waitFor(async () => {
      const r = await phone(`/api/v1/sessions/${S}`)
      note('read prompt', r)
      return r.json.pendingPermissions?.length === 1 ? r.json.pendingPermissions[0] as { requestId: string; toolName: string } : null
    }, 30_000, 'S\'s prompt on the phone')
    expect(prompt.toolName).toBe('Bash')
    const answered = await phone(`/api/v1/sessions/${S}/permission`, { method: 'POST', body: JSON.stringify({ requestId: prompt.requestId, allow: true }) })
    note('answer', answered)
    expect(answered.status, JSON.stringify(answered.json).slice(0, 400)).toBe(200)
    expect(answered.json).toMatchObject({ status: 'resolved', requestId: prompt.requestId, allow: true })
    await waitFor(() => respOf(world.devbox, S).length === answersBefore + 1, 20_000, 'the CLI to get the answer')
    expect(respOf(world.devbox, S).at(-1)?.response).toMatchObject({ request_id: prompt.requestId, response: { behavior: 'allow' } })
    answeredPrompts++

    expect(stream.events.filter((e) => e.event === 'bridge-offline')).toEqual([])
    expect(offline, 'the companion answered bridge_offline for devbox').toEqual([])
    expect(await bridgeAliases()).toEqual([KEEPER])
    expect((await companionLeads()).map((l) => l.host)).toEqual([KEEPER])
  } finally { stream.close() }
}

/** The Mac back: it holds devbox again, and every phone line reached the CLI once. */
async function macHasItBack(): Promise<void> {
  await macHoldsDevboxAgain()
  // Long enough for a handover's replay or a queue's redelivery to show.
  await sleep(2 * T)
  for (const text of sentTexts) expect(inboxOf(world.devbox, S).filter((m) => m.includes(text)), text).toHaveLength(1)
  expect(respOf(world.devbox, S)).toHaveLength(answeredPrompts)
}

describe.skipIf(!liveWallsAvailable())('one daemon under two aliases while the Mac is away (real servers, real daemon)', () => {
  beforeAll(() => setupTwinMac('wta-'), 400_000)
  afterAll(() => teardownTwinMac(), 600_000)

  it('the Mac is up: it leads devbox and the companion hears it and holds S', () => macIsUp(), 300_000)

  it('the discovered alias links last: the daemon keeps one bridge under devbox, and one read copy holding S', async () => {
    await linkBothAliases()
    // Settled: the same bridges for 10 s in a row, at least 10 s after the second link.
    let seen = ''
    let since = Date.now()
    await waitFor(async () => {
      const now = JSON.stringify(await bridgeAliases())
      if (now !== seen) { seen = now; since = Date.now() }
      return Date.now() - since >= 10_000
    }, 90_000, 'the companion\'s bridges to settle')
    expect(await bridgeAliases(), 'the companion must know the daemon by the alias the person uses').toEqual([KEEPER])
    expect(sliceSids(world.devbox), 'the daemon\'s read copy must hold every alias\'s sessions').toContain(S)
  }, 300_000)

  for (const way of WAYS) {
    it(`the Mac is ${way}: the phone reads, streams, sends to and answers S on devbox through the companion`, async () => {
      await macGoes(way)
      await phoneTalksToS(way)
      // The Mac kept running while offline: it still answers here, where its network was never in the way.
      if (way === 'offline') expect((await api(world.primary, '/api/leader')).status).toBe(200)
    }, 300_000 + LEADER_RESTART_GRACE_MS)

    it(`the Mac is back after being ${way}: it takes devbox back and nothing reached the CLI twice`, async () => {
      await macReturns(way)
      await macHasItBack()
    }, 400_000)
  }
})
