/**
 * The lock-screen work card (src/core/push/work-card.ts): the numbers it shows, when a card
 * begins and ends, which changes are sent, and that a card push can never ring the phone.
 *
 * The user's rule: the phone rings once, only when he must decide. A card update is a Live
 * Activity content update and must stay silent: no `alert`, `sound` or `badge` in any payload,
 * the `liveactivity` push type on the `.push-type.liveactivity` topic, and no other path to
 * the sender. The source checks at the end fail the day a card push could become a banner.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../src/constants.js', () => createMockConstants('work-card'))

import { withTestRun } from '../../src/core/test-run.js'
import {
  startWorkCard, stopWorkCard, workCardNow,
  CARD_LIFETIME_MS, DISMISS_AFTER_MS, END_EXPIRES_MS, END_GRACE_MS, HEARTBEAT_MS, MAX_RETRY_MS, MIN_GAP_MS, STALE_AFTER_MS, TITLE_MAX,
  WorkCardClock, WorkCardService, cardTargets, parseSavedCard, workCardPayload, workCardSnapshot,
  type SavedCard, type WorkCardDeps, type WorkCardState,
} from '../../src/core/push/work-card.js'
import { apnsTopicFor } from '../../src/core/push/apns.js'
import type { PushTokenEntry, Task } from '../../src/core/types.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const T0 = Date.parse('2026-11-04T09:00:00Z')
const MIN = 60_000

type T = Partial<Task> & { id: string }
function task(id: string, over: Partial<Task> = {}): T {
  return { id, title: `Task ${id}`, phase: 'IN_PROGRESS', updated_at: new Date(T0).toISOString(), ...over } as T
}
const status = (state: string, extra: Record<string, unknown> = {}) => ({ user_status: { state, ...extra } as Task['user_status'] })

describe('the numbers', () => {
  it('counts Working, Needs you (To read folded in) and Completed inside the stretch', () => {
    const tasks = [
      task('w1', status('working')),
      task('w2', status('working')),
      task('n1', { ...status('needs'), title: 'Review the release notes', updated_at: '2026-11-04T09:05:00Z' }),
      task('r1', status('read')),
      // An older server stored To read as Waiting with toRead set.
      task('r2', status('waiting', { toRead: 'result' })),
      task('wait', status('waiting')),
      task('c1', { phase: 'COMPLETE', completed_at: '2026-11-04T09:30:00Z' }),
      task('c-old', { phase: 'COMPLETE', completed_at: '2026-11-04T08:59:59Z' }),
    ]
    const { state, lists } = workCardSnapshot(tasks as Task[], T0, T0 + 60 * MIN)
    expect(state).toMatchObject({ working: 2, needs: 3, completed: 1, since: T0 / 1000, updatedAt: (T0 + 60 * MIN) / 1000 })
    expect(state.needsTitle).toBe('Review the release notes')
    expect(lists.working.sort()).toEqual(['w1', 'w2'])
    expect(lists.needs[0]).toBe('n1')
    expect(lists.needs.sort()).toEqual(['n1', 'r1', 'r2'])
    expect(lists.completed).toEqual(['c1'])
  })

  it('leaves out what the Org leaves out: org nodes, conversations, a plugin\'s own tasks', () => {
    const tasks = [
      task('main', { ...status('needs'), org_role: 'main' }),
      task('lead', { ...status('working'), org_role: 'lead' }),
      task('ask', { ...status('working'), walnut_agent: true }),
      task('askp', { ...status('needs'), project: 'Ask Walnut' }),
      task('plug', { ...status('needs'), plugin_only: 'mail' }),
      task('meta', { ...status('working'), title: '.metadata sentinel' }),
      task('mainDone', { phase: 'COMPLETE', completed_at: '2026-11-04T09:10:00Z', org_role: 'main' }),
      task('real', status('working')),
    ]
    const { state } = workCardSnapshot(tasks as Task[], T0, T0 + MIN)
    expect(state).toMatchObject({ working: 1, needs: 0, completed: 0 })
    expect(state.needsTitle).toBeUndefined()
  })

  it('a task with no stored status reads its phase, and a long title is cut to one line', () => {
    const long = `Fix   the\ncard ${'x'.repeat(200)}`
    const tasks = [task('a', { phase: 'NEED_ACTION', title: long }), task('b', { phase: 'IN_PROGRESS' })]
    const { state } = workCardSnapshot(tasks as Task[], T0, T0)
    expect(state).toMatchObject({ working: 1, needs: 1 })
    expect(Array.from(state.needsTitle!).length).toBe(TITLE_MAX)
    expect(state.needsTitle!.startsWith('Fix the card x')).toBe(true)
    expect(state.needsTitle!.endsWith('…')).toBe(true)
  })

  it('an empty board is all zeros', () => {
    expect(workCardSnapshot([], T0, T0).state).toEqual({ working: 0, needs: 0, completed: 0, since: T0 / 1000, updatedAt: T0 / 1000 })
  })
})

describe('the payload is silent', () => {
  const state: WorkCardState = { working: 3, needs: 1, completed: 2, since: T0 / 1000, updatedAt: T0 / 1000, needsTitle: 'x' }
  const forbidden = ['alert', 'sound', 'badge', 'content-available', 'mutable-content', 'interruption-level']

  for (const event of ['update', 'end'] as const) {
    it(`${event}: content only, no alert, sound or badge anywhere`, () => {
      const p = workCardPayload(event, state, T0)
      const json = JSON.stringify(p)
      for (const k of forbidden) expect(json.includes(`"${k}"`), k).toBe(false)
      expect(Object.keys(p)).toEqual(['aps'])
      const aps = p.aps as Record<string, unknown>
      expect(aps.event).toBe(event)
      expect(aps.timestamp).toBe(T0 / 1000)
      expect(aps['content-state']).toEqual(state)
    })
  }

  it('an update says when it goes stale, an end when it leaves the lock screen', () => {
    expect((workCardPayload('update', state, T0).aps as Record<string, unknown>)['stale-date']).toBe((T0 + STALE_AFTER_MS) / 1000)
    expect((workCardPayload('end', state, T0).aps as Record<string, unknown>)['dismissal-date']).toBe((T0 + DISMISS_AFTER_MS) / 1000)
  })

  it('a card push goes on the Live Activity topic', () => {
    expect(apnsTopicFor('dev.openwalnut.ios', 'liveactivity')).toBe('dev.openwalnut.ios.push-type.liveactivity')
    expect(apnsTopicFor('dev.openwalnut.ios', 'alert')).toBe('dev.openwalnut.ios')
  })
})

function st(working: number, needs = 0, completed = 0, at = T0): WorkCardState {
  return { working, needs, completed, since: T0 / 1000, updatedAt: at / 1000 }
}

/** A step whose push got through, as the service records it. */
function sent(c: WorkCardClock, state: WorkCardState, now: number) {
  const step = c.step(state, now)
  if (step.kind !== 'none') c.delivered(step, state, now)
  return step
}

describe('the clock', () => {
  it('nothing shows until something works', () => {
    const c = new WorkCardClock()
    expect(c.begin(0, T0)).toBe(T0)
    expect(sent(c, st(0), T0)).toEqual({ kind: 'none' })
    expect(c.active).toBe(false)
  })

  it('a stretch begins with the first working task and keeps its start', () => {
    const c = new WorkCardClock()
    expect(c.begin(2, T0)).toBe(T0)
    // The phone drew these numbers itself when it started the card: no hurry.
    expect(sent(c, st(2), T0)).toEqual({ kind: 'update', priority: 5 })
    expect(c.begin(3, T0 + 5 * MIN)).toBe(T0)
    expect(c.active).toBe(true)
  })

  it('the same numbers are not sent again, a change is, at most once per gap', () => {
    const c = new WorkCardClock()
    c.begin(2, T0); sent(c, st(2), T0)
    expect(sent(c, st(2, 0, 0, T0 + MIN), T0 + MIN)).toEqual({ kind: 'none' })
    const held = sent(c, st(1, 1), T0 + MIN + 1000)
    expect(held.kind).toBe('update')
    const tooSoon = sent(c, st(1, 2), T0 + MIN + 2000)
    expect(tooSoon).toEqual({ kind: 'none', retryInMs: MIN_GAP_MS - 1000 })
    expect(sent(c, st(1, 2), T0 + MIN + 1000 + MIN_GAP_MS)).toEqual({ kind: 'update', priority: 10 })
  })

  it('a new Needs you is sent at once (priority 10), anything else when it suits the phone (5)', () => {
    const c = new WorkCardClock()
    c.begin(1, T0); sent(c, st(1, 1), T0)
    expect(sent(c, st(2, 1), T0 + MIN)).toEqual({ kind: 'update', priority: 5 })
    expect(sent(c, st(2, 0, 1), T0 + 2 * MIN)).toEqual({ kind: 'update', priority: 5 })
    expect(sent(c, st(2, 1, 1), T0 + 3 * MIN)).toEqual({ kind: 'update', priority: 10 })
  })

  it('a card with no news is refreshed every heartbeat, so it does not read as stale', () => {
    const c = new WorkCardClock()
    c.begin(1, T0); sent(c, st(1), T0)
    expect(sent(c, st(1), T0 + HEARTBEAT_MS - 1).kind).toBe('none')
    expect(sent(c, st(1), T0 + HEARTBEAT_MS).kind).toBe('update')
  })

  it('ends after nothing worked for the whole grace; a turn that starts inside it keeps the card', () => {
    const c = new WorkCardClock()
    c.begin(1, T0); sent(c, st(1), T0)
    c.begin(0, T0 + MIN); expect(sent(c, st(0), T0 + MIN).kind).toBe('update')
    c.begin(0, T0 + MIN + END_GRACE_MS - 1); expect(sent(c, st(0), T0 + MIN + END_GRACE_MS - 1).kind).toBe('none')
    // Back to work inside the grace: the same stretch, the clock to the end starts over.
    expect(c.begin(1, T0 + MIN + END_GRACE_MS - 1)).toBe(T0)
    sent(c, st(1), T0 + MIN + END_GRACE_MS - 1)
    c.begin(0, T0 + 10 * MIN); sent(c, st(0), T0 + 10 * MIN)
    c.begin(0, T0 + 10 * MIN + END_GRACE_MS); expect(sent(c, st(0), T0 + 10 * MIN + END_GRACE_MS)).toEqual({ kind: 'end', state: { ...st(0), endedAt: (T0 + 10 * MIN + END_GRACE_MS) / 1000 } })
    expect(c.active).toBe(false)
    // The next work is a new stretch, counted from its own start.
    expect(c.begin(1, T0 + 30 * MIN)).toBe(T0 + 30 * MIN)
  })
})

function row(key: string, card?: string, env?: 'sandbox' | 'production'): PushTokenEntry {
  return {
    token: key.repeat(64).slice(0, 64), platform: 'ios', key_name: key, registered_at: new Date(T0).toISOString(),
    ...(env ? { environment: env } : {}),
    ...(card ? { work_card: { token: card, activity_id: `act-${key}`, registered_at: new Date(T0).toISOString() } } : {}),
  }
}

type Sent = { targets: unknown; payload: Record<string, unknown>; priority: number; expiration?: number }
function fakeDeps(over: Partial<WorkCardDeps> & { tasks: WorkCardDeps['tasks'] }): { deps: WorkCardDeps; sends: Sent[]; cleared: string[][]; clock: { t: number }; saved: SavedCard[] } {
  const sends: Sent[] = []
  const cleared: string[][] = []
  const saved: SavedCard[] = []
  const clock = { t: T0 }
  const deps: WorkCardDeps = {
    // The rows as the store keeps them: a cleared card token is gone from them.
    rows: async () => [row('a', 'c'.repeat(64), 'sandbox'), row('b', 'c'.repeat(64)), row('d', 'd'.repeat(64)), row('e')]
      .map((r) => (r.work_card && cleared.flat().includes(r.work_card.token) ? row(r.key_name) : r)),
    send: async (targets, payload, priority, expiration) => { sends.push({ targets, payload, priority, expiration }); return { attempted: true, sent: targets.length, failed: 0, deadTokens: [], delivered: targets.map((t) => t.token) } },
    clearTokens: async (tokens) => { cleared.push(tokens); return tokens.length },
    now: () => clock.t,
    saveStretch: async (s) => { saved.push(s) },
    ...over,
  }
  return { deps, sends, cleared, clock, saved }
}

async function settle(svc: WorkCardService) { await svc.tick(); await svc.idle() }

describe('the service', () => {
  it('one target per card token, in its row\'s APNs environment; a row with no card gets nothing', () => {
    expect(cardTargets([row('a', 'c'.repeat(64), 'sandbox'), row('b', 'c'.repeat(64)), row('d', 'd'.repeat(64)), row('e')])).toEqual([
      { token: 'c'.repeat(64), environment: 'sandbox' },
      { token: 'd'.repeat(64) },
    ])
  })

  it('pushes the change, ends the card after the grace and takes the ended tokens off the rows', async () => {
    let tasks: T[] = [task('w', status('working'))]
    const f = fakeDeps({ tasks: async () => tasks as Task[] })
    const svc = new WorkCardService(f.deps)
    const v1 = await svc.tick(); await svc.idle()
    expect(v1).toMatchObject({ active: true, stretch: new Date(T0).toISOString(), state: { working: 1 } })
    expect(f.saved[0]).toEqual({ stretchSince: T0 })
    expect(f.sends).toHaveLength(1)
    expect(f.sends[0].priority).toBe(5)
    expect((f.sends[0].payload.aps as Record<string, unknown>).event).toBe('update')
    // Apple keeps an update for an offline phone until the card would go stale anyway.
    expect(f.sends[0].expiration).toBe(Math.floor((T0 + STALE_AFTER_MS) / 1000))

    // It finishes: Completed counts it, Working is 0, the card stays through the grace.
    tasks = [task('w', { phase: 'COMPLETE', completed_at: new Date(T0 + MIN).toISOString() })]
    f.clock.t = T0 + MIN
    const v2 = await svc.tick(); await svc.idle()
    expect(v2).toMatchObject({ active: true, state: { working: 0, completed: 1 }, lists: { completed: ['w'] } })
    expect(f.sends).toHaveLength(2)

    f.clock.t = T0 + MIN + END_GRACE_MS
    const v3 = await svc.tick(); await svc.idle()
    expect(v3).toMatchObject({ active: false, stretch: null })
    expect(f.sends).toHaveLength(3)
    expect((f.sends[2].payload.aps as Record<string, unknown>).event).toBe('end')
    expect(((f.sends[2].payload.aps as Record<string, unknown>)['content-state'] as WorkCardState).completed).toBe(1)
    expect(f.cleared).toEqual([['c'.repeat(64), 'd'.repeat(64)]])
    // ...and an end, as long as a card can live.
    expect(f.sends[2].expiration).toBe(Math.floor((T0 + MIN + END_GRACE_MS + END_EXPIRES_MS) / 1000))
    expect(f.saved.map((x) => x.stretchSince)).toContain(T0)
    expect(f.saved.at(-1)).toEqual({ stretchSince: null })
  })

  it('a token Apple calls dead leaves the rows; the others stay', async () => {
    const f = fakeDeps({
      tasks: async () => [task('w', status('working'))] as Task[],
      send: async (targets) => ({ attempted: true, sent: targets.length - 1, failed: 1, deadTokens: ['d'.repeat(64)], delivered: ['c'.repeat(64)] }),
    })
    const svc = new WorkCardService(f.deps)
    await settle(svc)
    expect(f.cleared).toEqual([['d'.repeat(64)]])
  })

  it('with no card registered nothing is sent, and the numbers are still answered', async () => {
    const f = fakeDeps({ tasks: async () => [task('w', status('working'))] as Task[], rows: async () => [row('e')] })
    const svc = new WorkCardService(f.deps)
    const v = await svc.tick(); await svc.idle()
    expect(f.sends).toHaveLength(0)
    expect(v.state.working).toBe(1)
  })

  it('a stretch read back after a restart keeps its start, so Completed keeps counting', async () => {
    const f = fakeDeps({ tasks: async () => [task('w', status('working')), task('c', { phase: 'COMPLETE', completed_at: new Date(T0 + MIN).toISOString() })] as Task[] })
    f.clock.t = T0 + 10 * MIN
    const v = await new WorkCardService(f.deps, T0).tick()
    expect(v.stretch).toBe(new Date(T0).toISOString())
    expect(v.state).toMatchObject({ since: T0 / 1000, completed: 1 })
    expect(f.saved.every((x) => x.stretchSince === T0)).toBe(true)
  })

  it('a restart carries on: an end still owed is sent, and numbers the cards already took are not', async () => {
    // Stopped right after the stretch ended, before every card took the end.
    const owed = fakeDeps({ tasks: async () => [] })
    owed.clock.t = T0 + 30 * MIN
    const last = { ...st(0, 1, 3), endedAt: (T0 + 20 * MIN) / 1000 }
    await settle(new WorkCardService(owed.deps, parseSavedCard(JSON.stringify({ stretchSince: null, endOwed: true, endState: last }))))
    expect(owed.sends.map((x) => (x.payload.aps as Record<string, unknown>).event)).toEqual(['end'])
    // The end it owed, with the stretch's own numbers: not a fresh read's zeros.
    expect((owed.sends[0].payload.aps as Record<string, unknown>)['content-state']).toEqual(last)
    expect(owed.saved.at(-1)).toEqual({ stretchSince: null })

    // Stopped mid-stretch: the cards show 2 working; the same 2 after the restart are no news.
    const state = st(2)
    const mid = fakeDeps({ tasks: async () => [task('a', status('working')), task('b', status('working'))] as Task[] })
    mid.clock.t = T0 + 5 * MIN
    const svc = new WorkCardService(mid.deps, parseSavedCard(JSON.stringify({ stretchSince: T0, lastSent: { at: T0 + 4 * MIN, state } })))
    await settle(svc)
    expect(mid.sends).toHaveLength(0)
    // A Needs you since: sent at once.
    mid.deps.tasks = async () => [task('a', status('working')), task('b', status('needs'))] as Task[]
    mid.clock.t = T0 + 6 * MIN
    await settle(svc)
    expect(mid.sends.map((x) => x.priority)).toEqual([10])
  })

  it('a saved file that is not ours reads as a fresh start', () => {
    expect(parseSavedCard('nope')).toEqual({ stretchSince: null })
    expect(parseSavedCard(JSON.stringify({ stretchSince: 'x', endOwed: 'yes', lastSent: { at: 1, state: { working: 'a' } } }))).toEqual({ stretchSince: null })
  })

  it('the phone\'s read never waits on Apple, not even behind a push still timing out', async () => {
    let release!: () => void
    const hung = new Promise<void>((r) => { release = r })
    let first = true
    const f = fakeDeps({
      tasks: async () => [task('w', status('working'))] as Task[],
      send: async (targets) => {
        if (first) { first = false; await hung }
        return { attempted: true, sent: targets.length, failed: 0, deadTokens: [], delivered: targets.map((t) => t.token) }
      },
      canPush: async () => true,
    })
    const svc = new WorkCardService(f.deps)
    await svc.tick()
    f.clock.t = T0 + MIN
    const second = await Promise.race([svc.tick(), new Promise((r) => setTimeout(() => r('waited'), 200))])
    expect(second).toMatchObject({ state: { working: 1 }, pushes: true })
    release()
    await svc.idle()
  })

  it('a push Apple did not take is sent again after the gap, not lost until the next change', async () => {
    let fail = true
    const retries: number[] = []
    const f = fakeDeps({
      tasks: async () => [task('w', status('working'))] as Task[],
      send: async (targets, payload, priority) => {
        f.sends.push({ targets, payload, priority })
        return fail
          ? { attempted: true, sent: 0, failed: targets.length, deadTokens: [], delivered: [] }
          : { attempted: true, sent: targets.length, failed: 0, deadTokens: [], delivered: targets.map((t) => t.token) }
      },
      retryIn: (ms) => { retries.push(ms) },
    })
    const svc = new WorkCardService(f.deps)
    await settle(svc)
    expect(f.sends).toHaveLength(1)
    expect(retries).toEqual([2 * MIN_GAP_MS])
    fail = false
    // Not before the longer wait.
    f.clock.t = T0 + MIN_GAP_MS
    await settle(svc)
    expect(f.sends).toHaveLength(1)
    f.clock.t = T0 + 2 * MIN_GAP_MS
    await settle(svc)
    expect(f.sends).toHaveLength(2)
    // Delivered now: the same numbers are not sent again.
    f.clock.t = T0 + 4 * MIN_GAP_MS
    await settle(svc)
    expect(f.sends).toHaveLength(2)
  })

  it('an end that did not reach a card keeps its token and is sent again; the card that took it is cleared', async () => {
    let tasks: T[] = [task('w', status('working'))]
    let delivered = ['c'.repeat(64)]
    const f = fakeDeps({
      tasks: async () => tasks as Task[],
      send: async (targets, payload, priority) => {
        f.sends.push({ targets, payload, priority })
        return { attempted: true, sent: delivered.length, failed: targets.length - delivered.length, deadTokens: [], delivered }
      },
    })
    const svc = new WorkCardService(f.deps)
    await settle(svc)
    tasks = []
    f.clock.t = T0 + END_GRACE_MS + MIN
    await settle(svc)
    f.clock.t = T0 + 2 * END_GRACE_MS + MIN
    await settle(svc)
    const ends = f.sends.filter((x) => (x.payload.aps as Record<string, unknown>).event === 'end')
    expect(ends).toHaveLength(1)
    expect(f.cleared).toEqual([['c'.repeat(64)]])
    // The other card takes it on the retry.
    delivered = ['d'.repeat(64)]
    // After the first refusal the next try waits twice the gap.
    f.clock.t += MIN_GAP_MS
    await settle(svc)
    expect(f.sends.filter((x) => (x.payload.aps as Record<string, unknown>).event === 'end')).toHaveLength(1)
    f.clock.t += MIN_GAP_MS
    await settle(svc)
    expect(f.sends.filter((x) => (x.payload.aps as Record<string, unknown>).event === 'end')).toHaveLength(2)
    f.clock.t += MIN_GAP_MS
    await settle(svc)
    expect(f.sends.filter((x) => (x.payload.aps as Record<string, unknown>).event === 'end')).toHaveLength(2)
  })

  it('a push that keeps failing (no APNs key, a refusal) is tried ever more slowly, never every few seconds', async () => {
    const at: number[] = []
    const f = fakeDeps({
      tasks: async () => [task('w', status('working'))] as Task[],
      send: async () => { at.push(f.clock.t); return { attempted: false, reason: 'no key', sent: 0, failed: 0, deadTokens: [] } },
    })
    const svc = new WorkCardService(f.deps)
    // A day of reads every 10 s.
    for (let t = T0; t < T0 + 24 * 60 * MIN; t += MIN_GAP_MS) {
      f.clock.t = t
      await settle(svc)
    }
    const gaps = at.slice(1).map((t, i) => t - at[i])
    expect(gaps.slice(0, 4)).toEqual([2, 4, 8, 16].map((k) => k * MIN_GAP_MS))
    expect(gaps.every((g, i) => i === 0 || g >= gaps[i - 1])).toBe(true)
    expect(Math.max(...gaps)).toBe(MAX_RETRY_MS)
    // About 150 tries a day once backed off, not 8,640.
    expect(at.length).toBeLessThan(160)
  })

  it('a test run reads the numbers alone: no tick, no push, no stretch of the user\'s', async () => {
    const f = fakeDeps({ tasks: async () => [task('w', status('working'))] as Task[] })
    try {
      await startWorkCard(f.deps)
      await new Promise((r) => setTimeout(r, 2500))
      const before = f.sends.length
      const view = await withTestRun('spec-1', () => workCardNow())
      expect(view.active).toBe(false)
      expect(view.stretch).toBeNull()
      await new Promise((r) => setTimeout(r, 20))
      expect(f.sends.length).toBe(before)
    } finally {
      stopWorkCard()
    }
  })

  it('the grace runs on across a restart: idle 14 minutes, restarted, the card ends a minute later', async () => {
    const f = fakeDeps({ tasks: async () => [task('w', status('working'))] as Task[] })
    const svc = new WorkCardService(f.deps)
    await settle(svc)
    f.deps.tasks = async () => []
    f.clock.t = T0 + MIN
    await settle(svc)
    expect(f.saved.at(-1)).toMatchObject({ stretchSince: T0, idleSince: T0 + MIN })
    // A restart: a new service from what was saved.
    const g = fakeDeps({ tasks: async () => [] })
    g.clock.t = T0 + MIN + END_GRACE_MS
    await settle(new WorkCardService(g.deps, parseSavedCard(JSON.stringify(f.saved.at(-1)))))
    expect(g.sends.map((x) => (x.payload.aps as Record<string, unknown>).event)).toEqual(['end'])
  })

  it('an end sent again carries the stretch\'s own numbers and its end time, not a fresh read', async () => {
    let fail = true
    const f = fakeDeps({
      tasks: async () => [task('c', { phase: 'COMPLETE', completed_at: new Date(T0 + MIN).toISOString() })] as Task[],
      send: async (targets, payload, priority) => {
        f.sends.push({ targets, payload, priority })
        return fail ? { attempted: true, sent: 0, failed: targets.length, deadTokens: [], delivered: [] } : { attempted: true, sent: targets.length, failed: 0, deadTokens: [], delivered: targets.map((t) => t.token) }
      },
    })
    const svc = new WorkCardService(f.deps, T0)
    f.clock.t = T0 + 2 * MIN
    await settle(svc)
    f.clock.t = T0 + 2 * MIN + END_GRACE_MS
    await settle(svc)
    fail = false
    f.clock.t += 5 * MIN
    await settle(svc)
    const ends = f.sends.filter((x) => (x.payload.aps as Record<string, unknown>).event === 'end').map((x) => (x.payload.aps as Record<string, unknown>)['content-state'])
    expect(ends).toHaveLength(2)
    expect(ends[1]).toEqual(ends[0])
    expect(ends[0]).toMatchObject({ completed: 1, since: T0 / 1000, endedAt: (T0 + 2 * MIN + END_GRACE_MS) / 1000 })
  })

  it('an end still waiting its turn is dropped when work began again: the card takes the new stretch', async () => {
    let release!: () => void
    const hung = new Promise<void>((r) => { release = r })
    let hold = true
    const f = fakeDeps({ tasks: async () => [] })
    f.deps.send = async (targets, payload, priority) => {
      f.sends.push({ targets, payload, priority })
      if (hold) { hold = false; await hung }
      return { attempted: true, sent: targets.length, failed: 0, deadTokens: [], delivered: targets.map((t) => t.token) }
    }
    const svc = new WorkCardService(f.deps, parseSavedCard(JSON.stringify({ stretchSince: T0, idleSince: T0 })))
    // A heartbeat update is in flight (and hangs); the grace runs out behind it; work starts again.
    f.clock.t = T0 + 1000
    await svc.tick()
    f.clock.t = T0 + END_GRACE_MS
    await svc.tick()
    f.deps.tasks = async () => [task('w', status('working'))] as Task[]
    f.clock.t = T0 + END_GRACE_MS + 1000
    await svc.tick()
    release()
    await svc.idle()
    expect(f.sends.map((x) => (x.payload.aps as Record<string, unknown>).event)).not.toContain('end')
    expect(f.cleared).toEqual([])
  })

  it('a box with no APNs key sends nothing and owes nothing', async () => {
    const retries: number[] = []
    const f = fakeDeps({ tasks: async () => [task('w', status('working'))] as Task[], canPush: async () => false, retryIn: (ms) => { retries.push(ms) } })
    const svc = new WorkCardService(f.deps)
    const v = await svc.tick(); await svc.idle()
    expect(v.pushes).toBe(false)
    f.clock.t = T0 + 5 * MIN
    await settle(svc)
    expect(f.sends).toHaveLength(0)
    expect(retries).toEqual([])
  })

  it('the title under the counts stays on its task; one that newly needs the user takes it, at priority 10', async () => {
    const a = task('a', { ...status('needs'), title: 'Approve the release', updated_at: '2026-11-04T09:01:00Z' })
    const b = task('b', { ...status('needs'), title: 'Pick a headline', updated_at: '2026-11-04T09:00:00Z' })
    let tasks: T[] = [task('w', status('working')), a, b]
    const f = fakeDeps({ tasks: async () => tasks as Task[] })
    const svc = new WorkCardService(f.deps)
    expect((await svc.tick()).state.needsTitle).toBe('Approve the release')
    await svc.idle()
    // b is written to again (a status sync): it is newer now, yet the title stays, and nothing is pushed.
    tasks = [task('w', status('working')), a, { ...b, updated_at: '2026-11-04T09:05:00Z' }]
    f.clock.t = T0 + MIN
    expect((await svc.tick()).state.needsTitle).toBe('Approve the release')
    await svc.idle()
    expect(f.sends).toHaveLength(1)
    // a is answered and c comes to need the user: same count, a new headline, sent at once.
    const c = task('c', { ...status('needs'), title: 'Decide on the API', updated_at: '2026-11-04T08:00:00Z' })
    tasks = [task('w', status('working')), { ...b, updated_at: '2026-11-04T09:05:00Z' }, c]
    f.clock.t = T0 + 2 * MIN
    expect((await svc.tick()).state.needsTitle).toBe('Decide on the API')
    await svc.idle()
    expect(f.sends.at(-1)!.priority).toBe(10)
  })

  it('the title survives a restart: the same title after it is no news, not a priority 10 push', async () => {
    const a = task('a', { ...status('needs'), title: 'Approve the release', updated_at: '2026-11-04T09:01:00Z' })
    const b = task('b', { ...status('needs'), title: 'Pick a headline', updated_at: '2026-11-04T09:00:00Z' })
    const f = fakeDeps({ tasks: async () => [task('w', status('working')), a, b] as Task[] })
    await settle(new WorkCardService(f.deps))
    // b is written to while the server is down: newest by its write, yet the cards show a.
    const later = fakeDeps({ tasks: async () => [task('w', status('working')), a, { ...b, updated_at: '2026-11-04T09:05:00Z' }] as Task[] })
    later.clock.t = T0 + MIN
    const svc = new WorkCardService(later.deps, parseSavedCard(JSON.stringify(f.saved.at(-1))))
    expect((await svc.tick()).state.needsTitle).toBe('Approve the release')
    await svc.idle()
    expect(later.sends).toHaveLength(0)
    expect(f.saved.at(-1)!.headline).toEqual({ id: 'a', needs: ['a', 'b'] })
    // A headline outside a stretch, or one not ours, is not read back.
    expect(parseSavedCard(JSON.stringify({ stretchSince: null, headline: { id: 'a', needs: ['a'] } })).headline).toBeUndefined()
    expect(parseSavedCard(JSON.stringify({ stretchSince: T0, headline: { id: 3, needs: 'a' } })).headline).toBeUndefined()
  })

  it('a card past iOS\'s 8 hours is not sent to; its token leaves the rows', async () => {
    const f = fakeDeps({ tasks: async () => [task('w', status('working'))] as Task[] })
    f.clock.t = T0 + CARD_LIFETIME_MS + MIN
    await settle(new WorkCardService(f.deps))
    // Every card in the fake rows was registered at T0: all of them are over.
    expect(f.sends).toHaveLength(0)
    expect(f.cleared.flat().sort()).toEqual(['c'.repeat(64), 'd'.repeat(64)])
    // Within the 8 hours they are targets.
    expect(cardTargets([row('a', 'c'.repeat(64))], T0 + CARD_LIFETIME_MS - MIN)).toEqual([{ token: 'c'.repeat(64) }])
  })

  it('a card that missed an update gets it again alone, at priority 5; the cards that took it are not rung again', async () => {
    let down = true
    const f = fakeDeps({ tasks: async () => [task('w', status('working')), task('n', status('needs'))] as Task[] })
    const retries: number[] = []
    f.deps.retryIn = (ms) => { retries.push(ms) }
    f.deps.send = async (targets, payload, priority, expiration) => {
      f.sends.push({ targets, payload, priority, expiration })
      const took = targets.map((t) => t.token).filter((t) => !(down && t === 'd'.repeat(64)))
      return { attempted: true, sent: took.length, failed: targets.length - took.length, deadTokens: [], delivered: took }
    }
    const svc = new WorkCardService(f.deps)
    await settle(svc)
    expect(f.sends[0].targets).toEqual([{ token: 'c'.repeat(64), environment: 'sandbox' }, { token: 'd'.repeat(64) }])
    expect(retries).toEqual([MIN_GAP_MS * 2])
    // Within the wait: nothing.
    f.clock.t = T0 + MIN_GAP_MS
    await settle(svc)
    expect(f.sends).toHaveLength(1)
    // After it: only the card that missed it, at priority 5.
    down = false
    f.clock.t = T0 + MIN_GAP_MS * 2
    await settle(svc)
    expect(f.sends).toHaveLength(2)
    expect(f.sends[1].targets).toEqual([{ token: 'd'.repeat(64) }])
    expect(f.sends[1].priority).toBe(5)
    // It took it: nothing more is owed.
    f.clock.t = T0 + MIN_GAP_MS * 10
    await settle(svc)
    expect(f.sends).toHaveLength(2)
  })

  it('ticks run one at a time', async () => {
    let inFlight = 0
    let most = 0
    const f = fakeDeps({ tasks: async () => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return [] } })
    const svc = new WorkCardService(f.deps)
    await Promise.all([svc.tick(), svc.tick(), svc.tick()])
    expect(most).toBe(1)
  })
})

describe('the source: a card push has one silent way out', () => {
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

  it('work-card.ts sends with the liveactivity push type and never through the alert path', () => {
    const src = read('src/core/push/work-card.ts')
    expect(src).toMatch(/sendApns\(targets, payload, \{ pushType: 'liveactivity', priority, expiration \}\)/)
    expect(src).not.toMatch(/deliverPush|apnsPayload|['"]alert['"]\s*:/)
  })

  it('only the letter delivery and the card call the APNs sender', () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name)
        if (e.isDirectory()) walk(rel)
        else if (/\.tsx?$/.test(e.name) && rel !== 'src/core/push/apns.ts' && /\bsendApns\(/.test(read(rel))) callers.push(rel)
      }
    }
    walk('src')
    expect(callers.sort()).toEqual(['src/core/push/deliver.ts', 'src/core/push/work-card.ts'])
  })
})

describe('the phone reads the same fields', () => {
  it('ContentState in the iOS card model has exactly the fields the server pushes', () => {
    const swift = fs.readFileSync(path.join(ROOT, 'ios-native/Shared/WorkCard.swift'), 'utf8')
    const block = swift.slice(swift.indexOf('struct ContentState'), swift.indexOf('var sinceDate'))
    const fields = [...block.matchAll(/^\s*var (\w+): (\w+)(\?)?$/gm)].map((m) => `${m[1]}:${m[2]}${m[3] ?? ''}`)
    expect(fields).toEqual(['working:Int', 'needs:Int', 'completed:Int', 'since:Double', 'updatedAt:Double', 'needsTitle:String?', 'needsTaskId:String?', 'endedAt:Double?'])
    const sample = workCardSnapshot([task('n', { ...status('needs') })] as Task[], T0, T0).state
    expect(Object.keys({ ...sample, needsTitle: 'x', needsTaskId: 'a', endedAt: 1 })).toEqual(fields.map((f) => f.split(':')[0]))
  })

  it('project.yml keeps one build-number line, which the TestFlight bump rewrites', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'ios-native/project.yml'), 'utf8')
    expect(yml.split('\n').filter((l) => l.includes('CFBundleVersion:'))).toEqual(['        CFBundleVersion: "157"'.replace('157', /CFBundleVersion: "(\d+)"/.exec(yml)![1])])
    // The widget extension takes the app's number at build time instead.
    expect(yml).toMatch(/Take the app's build number[\s\S]*PlistBuddy -c 'Print :CFBundleVersion' "\$\{SRCROOT\}\/Walnut\/Support\/Info.plist"/)
  })

  it('a read of the numbers runs in its own task, so a caller going away never cancels it', () => {
    // Launch calls appBecameActive twice and the second replaced the ticker, cancelling the first
    // read: the card started only on the next tick, 20 s later (seen on the simulator 2026-11-04).
    const swift = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/Core/WorkCardController.swift'), 'utf8')
    expect(swift).toMatch(/func refresh\(\) async \{\s*await Task \{ await self\.refreshNow\(\) \}\.value\s*\}/)
    expect(swift.match(/\brefreshNow\(\)/g)).toHaveLength(2)
  })
})

