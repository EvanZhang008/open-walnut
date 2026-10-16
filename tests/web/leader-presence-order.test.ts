/**
 * The away console trusts ONE presence signal (docs/plan/walnut-replica-servers-impl.md,
 * WP7 review fixes): web/src/api/leader-presence.ts orders every signal by the
 * replica's presence count, so a late answer never flips the console, a
 * "suspect" answer never sets the away line, the copies' age is said plainly when
 * it is not known, this host's name arrives with GET /api/config, and every
 * needs_leader reason has its words.
 *
 * The contract the replica keeps (src/replica/): every HTTP answer carries
 * `x-walnut-presence-seq` and `x-walnut-presence-boot`; an answer from the
 * copies adds `x-walnut-offline: <asOf ms>` (0 = unknown) and
 * `x-walnut-offline-why: away|suspect`; the `replica:presence` event carries the
 * same `seq` and `boot` and `asOf: null` when the age is unknown.
 *
 * Real modules throughout: the store, the API client over a stubbed fetch, the
 * hook and the away line mounted by react-dom on a linkedom document.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import {
  _resetLeaderPresenceForTesting, awayLineText, getLeaderPresence, getPresenceOrder, isLeaderWords, leaderErrorMessage,
  leaderReasonText, noteReplicaConfig, noteResponseHeaders, notePresenceEvent, noteWsClose, NEEDS_LEADER_REASONS,
  WS_LEADER_AWAY, WS_LEADER_BACK,
} from '../../web/src/api/leader-presence'
import { useMacSessionAway } from '../../web/src/hooks/useLeaderPresence'
import { AwayLine } from '../../web/src/components/layout/AwayLine'

const MIN = 60_000
/** A replica answer's presence headers. */
const R = (seq: number, extra: Record<string, string> = {}, boot = 'boot-a') => new Headers({
  'x-walnut-presence-seq': String(seq), 'x-walnut-presence-boot': boot, ...extra,
})
const away = (seq: number, asOf: number, boot = 'boot-a') => R(seq, { 'x-walnut-offline': String(asOf), 'x-walnut-offline-why': 'away', 'x-walnut-answered-via': 'replica' }, boot)
const viaLeader = (seq: number, boot = 'boot-a') => R(seq, { 'x-walnut-answered-via': 'leader' }, boot)

beforeEach(() => { _resetLeaderPresenceForTesting() })

describe('W1: one state machine, ordered by the replica\'s presence count', () => {
  it('a suspect answer from the copies never sets the away line, and changes nothing while away either', () => {
    const t = Date.now()
    noteResponseHeaders(R(4, { 'x-walnut-offline': String(t - MIN), 'x-walnut-offline-why': 'suspect', 'x-walnut-answered-via': 'replica' }))
    expect(getLeaderPresence()).toMatchObject({ answers: true, asOf: null, source: 'none' })
    // It is still the newest count: an older away answer after it is old news.
    expect(getPresenceOrder().seq).toBe(4)
    noteResponseHeaders(away(3, t - 2 * MIN))
    expect(getLeaderPresence().answers).toBe(true)
    // A real away answer, then a suspect one: the line and its age stay as they were.
    noteResponseHeaders(away(5, t - 3 * MIN))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t - 3 * MIN })
    noteResponseHeaders(R(5, { 'x-walnut-offline': String(t), 'x-walnut-offline-why': 'suspect' }))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t - 3 * MIN })
  })

  it('an away answer that left before the Mac came back never brings the line back (event, header or 4002)', () => {
    const t = Date.now()
    noteResponseHeaders(away(3, t - MIN))
    expect(getLeaderPresence().answers).toBe(false)
    // Back by the event, with the next count.
    notePresenceEvent({ answers: true, asOf: t, host: 'devbox', hostKey: 'devbox', why: 'answers', seq: 4, boot: 'boot-a' })
    expect(getLeaderPresence().answers).toBe(true)
    noteResponseHeaders(away(3, t - MIN))
    expect(getLeaderPresence().answers).toBe(true)
    // An event of the same lower count (a slow socket's frame) is old news too.
    notePresenceEvent({ answers: false, asOf: t - MIN, why: 'mac-away', seq: 3, boot: 'boot-a' })
    expect(getLeaderPresence().answers).toBe(true)
    // Away again at count 5, back at 6 by a forwarded answer, a late count-5 answer: still back.
    noteResponseHeaders(away(5, t))
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(viaLeader(6))
    expect(getLeaderPresence().answers).toBe(true)
    noteResponseHeaders(away(5, t))
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('back by a 4002 close (no count of its own): a late answer still at the last count cannot flip it', () => {
    const t = Date.now()
    noteResponseHeaders(away(7, t - MIN))
    noteWsClose(WS_LEADER_BACK)
    expect(getLeaderPresence().answers).toBe(true)
    noteResponseHeaders(away(7, t - MIN))
    expect(getLeaderPresence().answers).toBe(true)
    // The replica's next count is news again.
    noteResponseHeaders(away(8, t))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t })
    // And the same for 4001: a forwarded answer still at the last count does not clear it.
    notePresenceEvent({ answers: true, asOf: t, seq: 9, boot: 'boot-a' })
    noteWsClose(WS_LEADER_AWAY)
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(viaLeader(9))
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(viaLeader(10))
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('a forwarded answer that left before the Mac went away never clears the line', () => {
    const t = Date.now()
    noteResponseHeaders(viaLeader(2))
    notePresenceEvent({ answers: false, asOf: t - MIN, host: 'devbox', why: 'mac-away', seq: 3, boot: 'boot-a' })
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(viaLeader(2))
    expect(getLeaderPresence()).toMatchObject({ answers: false, why: 'mac-away' })
  })

  it('a new boot starts the count again, and the run before it is never heard again', () => {
    const t = Date.now()
    noteResponseHeaders(away(9, t - MIN, 'boot-a'))
    expect(getLeaderPresence().answers).toBe(false)
    // The replica restarted: count 1 of a new boot is news although 1 < 9.
    noteResponseHeaders(viaLeader(1, 'boot-b'))
    expect(getLeaderPresence().answers).toBe(true)
    expect(getPresenceOrder()).toMatchObject({ boot: 'boot-b', seq: 1 })
    // A late answer from the old run (its count is higher) changes nothing.
    noteResponseHeaders(away(9, t, 'boot-a'))
    expect(getLeaderPresence().answers).toBe(true)
    noteResponseHeaders(away(10, t, 'boot-a'))
    expect(getLeaderPresence().answers).toBe(true)
    // The new run goes on counting.
    noteResponseHeaders(away(2, t, 'boot-b'))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t })
  })

  it('header-only presence works for a browser that never got the WS event', () => {
    const t = Date.now()
    // No event at all: the headers alone set and clear the line.
    noteResponseHeaders(away(1, t - 4 * MIN))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t - 4 * MIN, source: 'http' })
    expect(awayLineText(getLeaderPresence(), t)!.line).toBe('Your Mac is away. This is the copy on this host from 4 min ago.')
    noteResponseHeaders(away(1, t - MIN))
    expect(getLeaderPresence().asOf).toBe(t - MIN)
    noteResponseHeaders(viaLeader(2))
    expect(getLeaderPresence()).toMatchObject({ answers: true, source: 'http' })
    // An older replica with no count at all is still read as it comes.
    _resetLeaderPresenceForTesting()
    noteResponseHeaders(new Headers({ 'x-walnut-offline': String(t) }))
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(new Headers({ 'x-walnut-answered-via': 'leader' }))
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('through the API client: a late away answer arriving after the Mac is back is ignored', async () => {
    const { apiGet } = await import('../../web/src/api/client')
    const t = Date.now()
    const json = (headers: Headers) => {
      headers.set('content-type', 'application/json')
      return new Response(JSON.stringify({ tasks: [] }), { status: 200, headers })
    }
    let release!: (r: Response) => void
    const late = new Promise<Response>((r) => { release = r })
    const answers: Array<Response | Promise<Response>> = [late, json(viaLeader(5))]
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift()!))
    try {
      const slow = apiGet('/api/tasks', undefined, { quietStatuses: [] })
      await apiGet('/api/sessions', undefined, { quietStatuses: [] })
      expect(getLeaderPresence().answers).toBe(true)
      release(json(away(4, t - MIN)))
      await slow
      expect(getLeaderPresence().answers).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('W5: the copies\' age, said plainly when it is not known', () => {
  it('asOf null in the event, 0 in the header, or away known only from a 4001 close: "its age is not known"', () => {
    const t = Date.now()
    notePresenceEvent({ answers: false, asOf: null, host: 'devbox', why: 'mac-away', seq: 1, boot: 'b' })
    expect(awayLineText(getLeaderPresence(), t)!.line).toBe('Your Mac is away. This is the copy on devbox; its age is not known.')
    _resetLeaderPresenceForTesting()
    noteResponseHeaders(R(1, { 'x-walnut-offline': '0', 'x-walnut-offline-why': 'away' }))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: null })
    expect(awayLineText(getLeaderPresence(), t)!.line).not.toContain('from')
    // The age arrives later: the line says it; an answer that knows none keeps it.
    noteResponseHeaders(R(1, { 'x-walnut-offline': String(t - 2 * MIN), 'x-walnut-offline-why': 'away' }))
    expect(getLeaderPresence().asOf).toBe(t - 2 * MIN)
    noteResponseHeaders(R(1, { 'x-walnut-offline': '0', 'x-walnut-offline-why': 'away' }))
    expect(getLeaderPresence().asOf).toBe(t - 2 * MIN)
    // A 4001 from a socket that knew the Mac answered: the event's asOf was "now", not the copies' age.
    _resetLeaderPresenceForTesting()
    notePresenceEvent({ answers: true, asOf: t, host: 'devbox', hostKey: 'devbox', why: 'answers', seq: 1, boot: 'b' })
    noteWsClose(WS_LEADER_AWAY)
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: null, why: 'leader_away' })
    expect(awayLineText(getLeaderPresence(), t + 10 * MIN)!.line).toBe('Your Mac is away. This is the copy on devbox; its age is not known.')
  })
})

describe('W6: this host\'s name from GET /api/config', () => {
  it('replica.hostKey names this host; a config without it changes nothing', () => {
    noteReplicaConfig({ config: {} })
    noteReplicaConfig(null)
    noteReplicaConfig({ replica: 'devbox' })
    expect(getLeaderPresence()).toMatchObject({ hostKey: null, source: 'none' })
    noteReplicaConfig({ config: {}, replica: { hostKey: ' devbox ' } })
    expect(getLeaderPresence().hostKey).toBe('devbox')
  })

  it('through the shared config fetch: no extra request, and the hostKey lands', async () => {
    const { fetchConfig } = await import('../../web/src/api/config')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ config: { version: 1 }, replica: { hostKey: 'devbox' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    try {
      await fetchConfig()
      await fetchConfig()
      expect(calls.filter((u) => u.includes('/api/config'))).toHaveLength(1)
      expect(getLeaderPresence().hostKey).toBe('devbox')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('W4: every needs_leader why has words; the server\'s own message comes before the generic one', () => {
  it('the codes the replica and the daemon answer with', () => {
    const e = (why: string) => leaderErrorMessage({ error: { code: 'needs_leader', why } })
    for (const why of ['files_need_mac', 'board_not_here', 'copy_unreadable', 'not_queueable', 'mac_too_old', 'needs_mac', 'unreachable',
      'task_writes_need_mac', 'session_writes_need_mac', 'session_on_mac', 'session_files_need_mac', 'mac-away', 'no-daemon', 'nobody-answers', 'draining', 'fields']) {
      expect(NEEDS_LEADER_REASONS[why], why).toBeTruthy()
      expect(e(why)).toBe(`Needs your Mac. ${NEEDS_LEADER_REASONS[why]}`)
      expect(isLeaderWords(e(why))).toBe(true)
    }
    expect(e('files_need_mac')).toBe('Needs your Mac. Opening files needs your Mac for now.')
    expect(e('board_not_here')).toBe('Needs your Mac. This Board is not kept on this host.')
  })

  it('an unknown why: the server\'s message as a sentence, then the generic words', () => {
    expect(leaderErrorMessage({ error: { code: 'needs_leader', why: 'brand_new', message: 'that Board is kept elsewhere' } }))
      .toBe('Needs your Mac. That Board is kept elsewhere.')
    expect(leaderErrorMessage({ error: { code: 'needs_leader', why: 'brand_new', message: '  ' } }))
      .toBe('Needs your Mac. Your Mac is not answering right now.')
    // A known why keeps its own words over the server's generic message.
    expect(leaderErrorMessage({ error: { code: 'needs_leader', why: 'copy_unreadable', message: 'This needs your Mac, which is not answering right now.' } }))
      .toBe('Needs your Mac. The copy on this host could not be read.')
    // The console's flat shape (notes-routes.ts): {error: '<message>', code, why}.
    expect(leaderErrorMessage({ error: 'The notes copy on this host could not be read', code: 'needs_leader', why: 'copy_unreadable' }))
      .toBe('Needs your Mac. The copy on this host could not be read.')
    expect(leaderErrorMessage({ error: 'Task not found', code: 'not_found' })).toBeNull()
    // A prototype key is no reason.
    expect(leaderErrorMessage({ error: { code: 'needs_leader', why: 'constructor' } })).toBe('Needs your Mac. Your Mac is not answering right now.')
    expect(leaderReasonText('constructor')).toBeNull()
    expect(leaderReasonText('history_pages_need_mac')).toBe('Older messages load when your Mac is back.')
  })
})

describe('a console with no replica headers: no away line, the composer as it was', () => {
  let doc: Document
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('plain answers, other close codes and a plain config never render the line or block a send', async () => {
    const { apiGet, apiPatch } = await import('../../web/src/api/client')
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    const Composer = ({ host }: { host?: string }) => {
      const blocked = useMacSessionAway({ host })
      return createElement('div', { 'data-composer': host ?? 'mac', 'data-send-blocked': blocked ? 'true' : undefined })
    }
    await act(async () => {
      root.render(createElement('div', null, createElement(AwayLine), createElement(Composer, {}), createElement(Composer, { host: 'devbox' })))
    })
    const before = el.innerHTML
    expect(before).toBe('<div><div data-composer="mac"></div><div data-composer="devbox"></div></div>')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, config: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await act(async () => {
      await apiGet('/api/tasks')
      await apiPatch('/api/tasks/t1', { title: 'x' })
      for (const code of [1000, 1001, 1006, 1011, 1012, 4000, 4003]) noteWsClose(code)
      noteReplicaConfig({ config: {} })
      noteResponseHeaders(new Headers({ 'content-type': 'application/json', 'x-walnut-answered-via': 'leader' }))
    })
    expect(el.innerHTML).toBe(before)
    expect(el.querySelector('[data-testid="away-line"]')).toBeNull()
    expect(getLeaderPresence()).toMatchObject({ answers: true, asOf: null, host: null, hostKey: null, why: null })
    await act(async () => { root.unmount() })
  })

  it('this host\'s session keeps its composer when presence is known only from a header and the config', async () => {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    const Composer = ({ host }: { host?: string }) => {
      const blocked = useMacSessionAway({ host })
      return createElement('i', null, `${host ?? 'mac'}:${blocked ? 'blocked' : 'sends'};`)
    }
    await act(async () => { root.render(createElement('div', null, createElement(Composer, {}), createElement(Composer, { host: 'devbox' }))) })
    await act(async () => {
      noteReplicaConfig({ config: {}, replica: { hostKey: 'devbox' } })
      noteResponseHeaders(away(1, Date.now() - MIN))
    })
    expect(el.textContent).toBe('mac:blocked;devbox:sends;')
    await act(async () => { root.unmount() })
  })
})
