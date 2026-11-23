/**
 * The replica takeover of a letter turn (core/replica-takeover.ts, web/routes/human-inbox-takeover.ts):
 * with the experiment `replica_takeover` on, the Mac silent for five minutes and the companion
 * leading the letter's session's host, a reply or an answer on the companion goes straight to the
 * session on that host and is journaled as `inbox-reply-direct` (the Mac records it, delivers
 * nothing). Pinned (the decision of 2026-11-21: switch off by default, five minutes, once per
 * clientId, sessions on the Mac keep waiting):
 *
 *  - switch off, Mac silent too briefly, or a host this box does not lead: held for the Mac, as before;
 *  - on: one `send` to the host with the human's words, answered `200 {delivery: queued}`; a retry
 *    (the same clientId, the same option) sends nothing again and asks the Mac nothing;
 *  - never past an earlier turn of the same session still held for the Mac, never with pictures,
 *    never to a session on the Mac, never while the session waits on a permission prompt, never to a
 *    Mac that would not know the kind (it would deliver it again);
 *  - a send whose answer was lost: `pending`, journaled unconfirmed, never sent again;
 *  - a delivery still out at the route's deadline answers `pending`, keeps going, and a retry
 *    meanwhile neither relays nor sends.
 *
 * Real express app, router, journal, letter copy, send ledger and direct path. Mocked: the bridge
 * hops (the Mac relay and the host's daemon), where the session runs (the copy's projection), the
 * backup leader's view and the Mac's config copy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import type { AddressInfo, Server } from 'node:net'
import express from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-companion-takeover', { CLOUD_MODE: true }))

const { mac, host, world } = vi.hoisted(() => ({
  /** The Mac: away in every test here; every relay it was asked. */
  mac: { calls: [] as Array<{ action: string; params: Record<string, unknown> }>, online: false },
  /** The session's host daemon on this box's bridge. */
  host: {
    connected: new Set<string>(['devbox']),
    sends: [] as Array<{ host: string; sid: string; message: string; messageId?: string }>,
    prompt: false,
    /** 'ok' | 'lost' (the answer of the send never came back) */
    sendMode: 'ok' as 'ok' | 'lost',
    sendDelayMs: 0,
    statusDelayMs: 0,
    /** Sends that reached the daemon (counted before its delay), and status answers given. */
    sendsStarted: 0,
    statusAnswered: 0,
  },
  world: {
    switchOn: true,
    /** The Mac's last heartbeat. */
    lastSeen: 0,
    leads: new Set<string>(['devbox']),
    sessions: new Map<string, { host: string; cwd?: string }>(),
  },
}))

vi.mock('../../src/web/routes/v1-control-relay.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/routes/v1-control-relay.js')>()
  return {
    ...actual,
    tryControlRelay: async (action: string, _sid: string, params: Record<string, unknown> = {}) => {
      mac.calls.push({ action, params })
      // The Mac up: it records the turn and answers as its own route does.
      if (mac.online) return { ok: true as const, reply: { ok: true, result: { letter: { id: params.id }, delivery: { status: 'queued', sessionId: 'on-the-mac' } } } }
      return {
        ok: false as const, notSent: true,
        answer: (res: import('express').Response) => actual.sendV1Error(res, 503, 'bridge_offline', 'No live bridge to the primary box.'),
      }
    },
    callPrimaryControl: async (action: string, _sid: string, params: Record<string, unknown> = {}) => {
      mac.calls.push({ action, params })
      return { ok: false, failure: { kind: 'bridge_offline', message: 'Your primary box (Mac) is offline', notSent: true } }
    },
  }
})

vi.mock('../../src/web/ws/bridge-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/ws/bridge-registry.js')>()
  return {
    ...actual,
    bridgeForHost: (alias: string) => ({ connected: host.connected.has(alias) }),
    bridgeRequest: async (alias: string, cmd: string, params: Record<string, unknown> = {}) => {
      if (!host.connected.has(alias)) throw new actual.BridgeOfflineError(alias)
      if (cmd === 'status') {
        if (host.statusDelayMs) await new Promise((r) => setTimeout(r, host.statusDelayMs))
        host.statusAnswered++
        return { ok: true, exists: true, alive: true, sendMarkers: true, ...(host.prompt ? { pendingCtrl: { reqId: 'req-1', toolName: 'Bash', request: { subtype: 'can_use_tool' }, receivedAt: Date.now() } } : {}) }
      }
      if (cmd === 'send') {
        host.sendsStarted++
        if (host.sendDelayMs) await new Promise((r) => setTimeout(r, host.sendDelayMs))
        const markers = params.markers as Array<{ messageId: string }> | undefined
        host.sends.push({ host: alias, sid: String(params.sid), message: String(params.message), messageId: markers?.[0]?.messageId })
        if (host.sendMode === 'lost') throw new Error('bridge request timed out')
        return { ok: true }
      }
      if (cmd === 'appendUserMarker') return { ok: true }
      throw new Error(`unexpected host command ${cmd}`)
    },
  }
})

vi.mock('../../src/core/leader/backup-leader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/leader/backup-leader.js')>()),
  getBackupLeader: async () => ({
    status: () => ({ primaryLastSeenAt: world.lastSeen }),
    leadFor: (alias: string) => (world.leads.has(alias) ? { walnutId: 'walnut-test', epoch: 3 } : null),
  }),
}))

vi.mock('../../src/core/replication/kinds/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/replication/kinds/config.js')>()),
  readConfigCopy: async () => ({ experimental: { replica_takeover: world.switchOn } }),
}))

vi.mock('../../src/core/sessions/cloud-session-host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/cloud-session-host.js')>()),
  resolveCloudSessionHost: async (sid: string) => world.sessions.get(sid) ?? null,
}))

import { WALNUT_HOME, HUMAN_INBOX_QUEUE_DIR, IMAGES_DIR } from '../../src/constants.js'
import { humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import {
  _resetCompanionJournalForTesting, companionJournalDir, companionJournalRecords, drainCompanionJournal,
} from '../../src/core/companion-journal.js'
import { humanInboxV1Router, setDeliveryWaitForTests } from '../../src/web/routes/human-inbox-v1.js'
import { _letterTurnsSettledForTesting } from '../../src/web/routes/human-inbox-takeover.js'
import { inboxReplyOpId } from '../../src/core/companion-journal.js'
import { markSendOutcome } from '../../src/core/send-outcomes.js'
import type { LetterSender, ThreadEntry } from '../../src/core/human-inbox/types.js'

const SID = 'dddddddd-4444-4444-8444-dddddddddddd'
const MAC_SID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee'
const SENDER: LetterSender = { sessionId: SID, host: 'devbox' }
const MAC_KINDS = ['inbox-state', 'inbox-reply', 'inbox-reply-pictures', 'inbox-reply-direct']
const AWAY = 6 * 60_000

let server: Server
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json({ limit: '20mb' }))
  app.use('/api/v1', humanInboxV1Router)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})

afterAll(async () => {
  setDeliveryWaitForTests(undefined)
  _resetCompanionJournalForTesting()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
})

beforeEach(async () => {
  // A delivery a test left running (it answered pending at its deadline) ends before the reset:
  // its record must not land in the next test's journal.
  await _letterTurnsSettledForTesting()
  _resetCompanionJournalForTesting()
  fs.rmSync(companionJournalDir(), { recursive: true, force: true })
  fs.rmSync(humanInboxPaths.dir, { recursive: true, force: true })
  fs.rmSync(HUMAN_INBOX_QUEUE_DIR, { recursive: true, force: true })
  fs.rmSync(IMAGES_DIR, { recursive: true, force: true })
  mac.calls.length = 0
  host.sends.length = 0
  host.prompt = false
  host.sendMode = 'ok'
  host.sendDelayMs = 0
  host.statusDelayMs = 0
  host.sendsStarted = 0
  host.statusAnswered = 0
  mac.online = false
  host.connected = new Set(['devbox'])
  world.switchOn = true
  world.lastSeen = Date.now() - AWAY
  world.leads = new Set(['devbox'])
  world.sessions = new Map([[SID, { host: 'devbox', cwd: '/work/marina' }], [MAC_SID, { host: '__local__' }]])
  setDeliveryWaitForTests(undefined)
  await drainCompanionJournal(MAC_KINDS)
})

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

async function seedLetter(sender: LetterSender = SENDER): Promise<string> {
  return (await sendLetter({
    subject: 'Pick a layout for the marina page', type: 'action_required', markdown: '# Two layouts',
    actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }], sender,
  })).id
}

const records = (kind?: string) => companionJournalRecords().filter((r) => (kind ? r.kind === kind : String(r.kind).startsWith('inbox-reply')))
const humanTurns = (letter: { thread: ThreadEntry[] }) => letter.thread.filter((t) => t.from === 'human')
const relays = () => mac.calls.filter((c) => c.action.startsWith('server.human-inbox.'))
const reply = (id: string, text: string, clientId: string, extra: Record<string, unknown> = {}) =>
  api('POST', `/human-inbox/${id}/human-reply`, { text, clientId, ...extra })

/** What the route does when it holds the turn for the Mac (the behaviour before the switch). */
function expectHeld(r: { status: number; json: Record<string, any> }, kind = 'inbox-reply'): void {
  expect(r.status).toBe(202)
  expect(r.json).toMatchObject({ queued: true, delivery: { status: 'pending', held: true } })
  expect(records().map((x) => x.kind)).toContain(kind)
  expect(records('inbox-reply-direct')).toEqual([])
}

describe('held for the Mac, as before', () => {
  it('with the switch off (its default)', async () => {
    world.switchOn = false
    const id = await seedLetter()
    expectHeld(await reply(id, 'Layout A', 'ios-off-1'))
    expect(host.sends).toEqual([])
  })

  it('while the Mac has been silent for less than five minutes', async () => {
    world.lastSeen = Date.now() - 60_000
    const id = await seedLetter()
    expectHeld(await reply(id, 'Layout A', 'ios-soon-1'))
    expect(host.sends).toEqual([])
  })

  it('while this box does not lead the session\'s host (its daemon still hears the Mac)', async () => {
    world.leads = new Set()
    const id = await seedLetter()
    expectHeld(await reply(id, 'Layout A', 'ios-nolead-1'))
    expect(host.sends).toEqual([])
  })

  it('for a session on the Mac itself', async () => {
    const id = await seedLetter({ sessionId: MAC_SID, host: '__local__' })
    world.leads = new Set(['devbox', '__local__'])
    host.connected = new Set(['devbox', '__local__'])
    expectHeld(await reply(id, 'Layout A', 'ios-mac-1'))
    expect(host.sends).toEqual([])
  })

  it('with pictures (they go with the Mac, which saves them first)', async () => {
    const id = await seedLetter()
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5170000000049454e44ae426082', 'hex').toString('base64')
    const r = await reply(id, 'Like this', 'ios-pic-1', { images: [{ data: png, mediaType: 'image/png' }] })
    expectHeld(r, 'inbox-reply-pictures')
    expect(host.sends).toEqual([])
  })

  it('while the session waits on a permission prompt', async () => {
    host.prompt = true
    const id = await seedLetter()
    expectHeld(await reply(id, 'Layout A', 'ios-prompt-1'))
    expect(host.sends).toEqual([])
  })

  it('for a Mac that does not drain inbox-reply-direct (it would deliver the turn again)', async () => {
    await drainCompanionJournal(['inbox-state', 'inbox-reply', 'inbox-reply-pictures'])
    const id = await seedLetter()
    expectHeld(await reply(id, 'Layout A', 'ios-oldmac-1'))
    expect(host.sends).toEqual([])
  })

  it('behind an earlier turn of the same session still held for the Mac', async () => {
    const first = await seedLetter()
    world.lastSeen = Date.now() - 60_000
    expectHeld(await reply(first, 'First words', 'ios-order-1'))
    // Five minutes later the switch would take over: the second must not pass the first.
    world.lastSeen = Date.now() - AWAY
    const second = await seedLetter()
    const r = await reply(second, 'Second words', 'ios-order-2')
    expect(r.status).toBe(202)
    expect(r.json.delivery).toMatchObject({ status: 'pending', held: true })
    expect(host.sends).toEqual([])
    expect(records('inbox-reply').map((x) => x.clientId)).toEqual(['ios-order-1', 'ios-order-2'])
  })
})

describe('taken over: straight to the session on its host', () => {
  it('a reply goes once, answered queued; a retry sends nothing again and asks the Mac nothing', async () => {
    const id = await seedLetter()
    const r = await reply(id, 'Layout A, keep the map', 'ios-take-1')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ delivery: { status: 'queued', sessionId: SID }, clientId: 'ios-take-1' })
    expect(r.json.queued).toBeUndefined()
    expect(host.sends).toHaveLength(1)
    expect(host.sends[0]).toMatchObject({ host: 'devbox', sid: SID })
    expect(host.sends[0].message).toContain('Layout A, keep the map')
    const [rec, ...rest] = records()
    expect(rest).toEqual([])
    expect(rec).toMatchObject({ kind: 'inbox-reply-direct', letterId: id, op: 'reply', clientId: 'ios-take-1', direct: { sessionId: SID, messageId: host.sends[0].messageId } })
    // The letter here shows the turn as in its session.
    expect(humanTurns(r.json.letter)).toMatchObject([{ clientId: 'ios-take-1', delivery: { status: 'queued', sessionId: SID } }])

    const relaysBefore = relays().length
    const again = await reply(id, 'Layout A, keep the map', 'ios-take-1')
    expect(again.status).toBe(200)
    expect(again.json.delivery).toMatchObject({ status: 'queued', sessionId: SID })
    expect(host.sends).toHaveLength(1)
    expect(relays().length).toBe(relaysBefore)
    expect(records()).toHaveLength(1)
  })

  it('an option picked goes once with its label, and the letter reads answered', async () => {
    const id = await seedLetter()
    const r = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b', freeText: 'with the links' })
    expect(r.status).toBe(200)
    expect(r.json.delivery).toMatchObject({ status: 'queued', sessionId: SID })
    expect(host.sends).toHaveLength(1)
    expect(host.sends[0].message).toContain('Layout B')
    expect(host.sends[0].message).toContain('with the links')
    expect(r.json.letter.answered).toMatchObject({ actionId: 'b' })
    expect(records('inbox-reply-direct')).toMatchObject([{ op: 'answer', actionId: 'b', freeText: 'with the links' }])

    const again = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b', freeText: 'with the links' })
    expect([200, 202]).toContain(again.status)
    expect(host.sends).toHaveLength(1)
    expect(records()).toHaveLength(1)
  })

  it('two taps at once deliver once', async () => {
    const id = await seedLetter()
    const [a, b] = await Promise.all([reply(id, 'Ship it', 'ios-double-1'), reply(id, 'Ship it', 'ios-double-1')])
    // The second reads the first: in its session (200), or still being handed over (202 pending).
    expect([a.status, b.status]).toContain(200)
    for (const r of [a, b]) expect([200, 202]).toContain(r.status)
    expect(host.sends).toHaveLength(1)
    expect(records()).toHaveLength(1)
  })

  it('a send whose answer was lost reads pending, is journaled unconfirmed, and is never sent again', async () => {
    host.sendMode = 'lost'
    const id = await seedLetter()
    const r = await reply(id, 'Layout B', 'ios-lost-1')
    expect(r.status).toBe(202)
    expect(r.json.delivery).toEqual({ status: 'pending' })
    expect(records()).toMatchObject([{ kind: 'inbox-reply-direct', direct: { sessionId: SID, unconfirmed: true } }])
    host.sendMode = 'ok'
    const again = await reply(id, 'Layout B', 'ios-lost-1')
    expect(again.status).toBe(202)
    expect(host.sends).toHaveLength(1)
  })

  it('a delivery still out at the deadline answers pending and keeps going; a retry meanwhile neither relays nor sends', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const id = await seedLetter()
    const started = Date.now()
    const r = await reply(id, 'Layout A', 'ios-slow-1')
    expect(Date.now() - started).toBeLessThan(3_600)
    expect(r.status).toBe(202)
    expect(r.json.delivery).toEqual({ status: 'pending' })
    expect(r.json.queued).toBeUndefined()
    const relaysBefore = relays().length
    const again = await reply(id, 'Layout A', 'ios-slow-1')
    expect(again.status).toBe(202)
    expect(relays().length).toBe(relaysBefore)
    // The delivery ends: one send, journaled as delivered.
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
    expect(host.sends).toHaveLength(1)
    expect(records()[0]).toMatchObject({ direct: { sessionId: SID } })
    expect(records()[0].direct.unconfirmed).toBeUndefined()
  }, 20_000)

  it('a turn this box delivered before a restart (its record never written) is recorded, never sent again', async () => {
    const id = await seedLetter()
    const opOf = (clientId: string) => inboxReplyOpId({ letterId: id, op: 'reply', text: '', clientId, madeAt: 0 })
    await markSendOutcome(SID, `ltr-${opOf('ios-crash-1')}`, 'delivered-direct')
    const done = await reply(id, 'Layout A', 'ios-crash-1')
    expect(done.status).toBe(200)
    expect(done.json.delivery).toMatchObject({ status: 'queued', sessionId: SID })
    // Its answer lost before the restart: it may have run, so it is only recorded, as not confirmed.
    await markSendOutcome(SID, `ltr-${opOf('ios-crash-2')}`, 'maybe-direct', { code: 'delivery_unknown' })
    const maybe = await reply(id, 'Layout B', 'ios-crash-2')
    expect(maybe.status).toBe(202)
    expect(maybe.json.delivery).toEqual({ status: 'pending' })
    expect(host.sends).toEqual([])
    expect(records('inbox-reply-direct').map((r) => [r.clientId, (r.direct as { unconfirmed?: true }).unconfirmed ?? false])).toEqual([['ios-crash-1', false], ['ios-crash-2', true]])
  })
})

describe('never twice, never out of order (review, 2026-11-21)', () => {
  it('a retry of a reply the Mac took by relay is held, never handed to the session', async () => {
    const id = await seedLetter()
    mac.online = true
    const first = await reply(id, 'Layout A', 'ios-relayed-1')
    expect(first.status).toBe(200)
    // The phone lost that answer; the Mac sleeps; the person taps Retry.
    mac.online = false
    expectHeld(await reply(id, 'Layout A', 'ios-relayed-1'))
    expect(host.sends).toEqual([])
  })

  it('a reply already on the letter in the copy (the Mac recorded it) is held, never handed to the session', async () => {
    const id = await seedLetter()
    const raw = JSON.parse(fs.readFileSync(humanInboxPaths.indexFile, 'utf-8')) as { letters: Array<{ id: string; thread: ThreadEntry[] }> }
    raw.letters.find((l) => l.id === id)!.thread.push({ from: 'human', text: 'Layout A', at: Date.now(), clientId: 'ios-copy-1', delivery: { status: 'queued', at: Date.now() } } as ThreadEntry)
    fs.writeFileSync(humanInboxPaths.indexFile, JSON.stringify(raw))
    const r = await reply(id, 'Layout A', 'ios-copy-1')
    expect(r.status).toBe(202)
    expect(host.sends).toEqual([])
  })

  it('two different options on one letter at once: only one reaches the session', async () => {
    const id = await seedLetter()
    const [a, b] = await Promise.all([
      api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' }),
      api('POST', `/human-inbox/${id}/answer`, { actionId: 'b' }),
    ])
    expect(host.sends).toHaveLength(1)
    expect([a.status, b.status]).toContain(200)
    expect(records('inbox-reply-direct')).toHaveLength(1)
  })

  it('a delivery that has not started by the deadline is held at once, and nothing is sent after', async () => {
    setDeliveryWaitForTests(3_600)
    host.statusDelayMs = 4_500
    const id = await seedLetter()
    const r = await reply(id, 'Layout B', 'ios-nostart-1')
    expectHeld(r)
    // The host answers the status the run was waiting on: the run then sends nothing.
    await vi.waitFor(() => expect(host.statusAnswered).toBe(1), { timeout: 8_000, interval: 50 })
    expect(host.sendsStarted).toBe(0)
    expect(records('inbox-reply').map((x) => x.clientId)).toEqual(['ios-nostart-1'])
  }, 20_000)

  it('a later turn of the session waits behind a slow earlier one, and is held rather than passing it', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const first = await seedLetter()
    const second = await seedLetter()
    const one = reply(first, 'First words', 'ios-line-1')
    await vi.waitFor(() => expect(host.sendsStarted).toBe(1), { timeout: 5_000, interval: 20 })
    const two = await reply(second, 'Second words', 'ios-line-2')
    expect((await one).json.delivery).toEqual({ status: 'pending' })
    expect(two.status).toBe(202)
    expect(two.json.delivery).toMatchObject({ status: 'pending', held: true })
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
    expect(host.sends.map((x) => x.message.includes('First words'))).toEqual([true])
    expect(records('inbox-reply').map((x) => x.clientId)).toEqual(['ios-line-2'])
  }, 20_000)

  it('another option picked while the first is still out: refused as the Mac would, never a second answer', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const id = await seedLetter()
    const first = api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })
    await vi.waitFor(() => expect(host.sendsStarted).toBe(1), { timeout: 5_000, interval: 20 })
    const second = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b' })
    expect((await first).json.delivery).toEqual({ status: 'pending' })
    expect(second.status).toBe(409)
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
    expect(host.sends).toHaveLength(1)
    expect(records()).toHaveLength(1)
  }, 20_000)

  it('two options waiting behind a slow turn of the session: both held in order, the first never refused for the later one', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const first = await seedLetter()
    const second = await seedLetter()
    const one = reply(first, 'Slow words', 'ios-wait-1')
    await vi.waitFor(() => expect(host.sendsStarted).toBe(1), { timeout: 5_000, interval: 20 })
    const [a, b] = await Promise.all([
      api('POST', `/human-inbox/${second}/answer`, { actionId: 'a' }),
      api('POST', `/human-inbox/${second}/answer`, { actionId: 'b' }),
    ])
    expect([a.status, b.status]).toEqual([202, 202])
    for (const r of [a, b]) expect(r.json.delivery).toMatchObject({ status: 'pending', held: true })
    expect(records('inbox-reply').map((x) => x.actionId).sort()).toEqual(['a', 'b'])
    await one
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
    expect(host.sends).toHaveLength(1)
  }, 20_000)

  it('the same reply again while the first is still out: in flight, sent once, never held beside it', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const id = await seedLetter()
    const first = reply(id, 'Twice?', 'ios-twice-1')
    await vi.waitFor(() => expect(host.sendsStarted).toBe(1), { timeout: 5_000, interval: 20 })
    const again = await reply(id, 'Twice?', 'ios-twice-1')
    expect(again.status).toBe(202)
    expect(again.json.delivery).toEqual({ status: 'pending' })
    expect((await first).status).toBe(202)
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
    expect(host.sends).toHaveLength(1)
    expect(records()).toHaveLength(1)
  }, 20_000)

  it('a reply with a picture behind a slow delivery of the session is held in time, never left to the route\'s 504', async () => {
    setDeliveryWaitForTests(3_600)
    host.sendDelayMs = 4_000
    const first = await seedLetter()
    const second = await seedLetter()
    const one = reply(first, 'Words first', 'ios-pic-line-1')
    await vi.waitFor(() => expect(host.sendsStarted).toBe(1), { timeout: 5_000, interval: 20 })
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5170000000049454e44ae426082', 'hex').toString('base64')
    const started = Date.now()
    const two = await reply(second, 'Then a picture', 'ios-pic-line-2', { images: [{ data: png, mediaType: 'image/png' }] })
    expect(Date.now() - started).toBeLessThan(3_600)
    expect(two.status).toBe(202)
    expect(two.json.delivery).toMatchObject({ status: 'pending', held: true })
    expect(records('inbox-reply-pictures').map((x) => x.clientId)).toEqual(['ios-pic-line-2'])
    await one
    await vi.waitFor(() => expect(records('inbox-reply-direct')).toHaveLength(1), { timeout: 8_000, interval: 100 })
  }, 20_000)

  it('another option after one the Mac took by relay is held, never handed to the session', async () => {
    const id = await seedLetter()
    mac.online = true
    expect((await api('POST', `/human-inbox/${id}/answer`, { actionId: 'a' })).status).toBe(200)
    mac.online = false
    const r = await api('POST', `/human-inbox/${id}/answer`, { actionId: 'b' })
    expectHeld(r)
    expect(host.sends).toEqual([])
  })
})
