/**
 * The console's view of whether the Mac answers, behind a host replica
 * (docs/plan/walnut-replica-servers-impl.md, WP7): web/src/api/leader-presence.ts
 * (the store and its words), web/src/hooks/useLeaderPresence.ts (the hook, the
 * fetch and socket wiring), the API client's messages, and the WS client's
 * reconnect on the replica's handover codes (4001 leader_away, 4002 leader_back).
 *
 * Real modules throughout: the store, the hook mounted by react-dom on a
 * linkedom document, the API client over a stubbed fetch, the WS client over a
 * stand-in WebSocket. Nothing of the thing under test is mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useEffect } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import {
  _resetLeaderPresenceForTesting, agoText, awayLineText, getLeaderPresence, isLeaderWords, isMacSessionAway, leaderErrorMessage,
  noteResponseHeaders, notePresenceEvent, noteWsClose, subscribeLeaderPresence, WS_LEADER_AWAY, WS_LEADER_BACK,
} from '../../web/src/api/leader-presence'
import { useAwayLine, useLeaderPresence, useMacSessionAway } from '../../web/src/hooks/useLeaderPresence'

const H = (m: Record<string, string>) => new Headers(m)
const MIN = 60_000

beforeEach(() => { _resetLeaderPresenceForTesting() })

describe('the store: who answered, from each source', () => {
  it('a console the Mac serves sees none of the sources: the Mac answers, no line', () => {
    expect(getLeaderPresence()).toMatchObject({ answers: true, asOf: null, host: null, source: 'none' })
    expect(awayLineText(getLeaderPresence(), Date.now())).toBeNull()
    // Plain answers (no replica headers) change nothing.
    noteResponseHeaders(H({ 'content-type': 'application/json' }))
    noteResponseHeaders(undefined)
    noteResponseHeaders(null)
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('the replica event says away with its host and when the Mac was last heard', () => {
    const asOf = Date.now() - 2 * MIN
    notePresenceEvent({ answers: false, asOf, host: 'devbox', hostKey: 'dev-key', why: 'quiet' })
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf, host: 'devbox', hostKey: 'dev-key', why: 'quiet', source: 'ws' })
    expect(awayLineText(getLeaderPresence(), Date.now())).toEqual({
      line: 'Your Mac is away. This is the copy on devbox from 2 min ago.',
      prompts: 'Prompts on devbox are not pushed to your phone.',
    })
    notePresenceEvent({ answers: true, asOf, host: 'devbox', why: 'answers' })
    expect(getLeaderPresence()).toMatchObject({ answers: true, why: null, host: 'devbox', hostKey: 'dev-key' })
    expect(awayLineText(getLeaderPresence(), Date.now())).toBeNull()
  })

  it('a malformed event is ignored', () => {
    for (const bad of [null, undefined, 'away', 3, {}, { answers: 'no' }]) notePresenceEvent(bad)
    expect(getLeaderPresence()).toMatchObject({ answers: true, source: 'none' })
  })

  it('x-walnut-offline says away; asOf never moves back; answered-via leader or companion says back', () => {
    const t = Date.now()
    noteResponseHeaders(H({ 'x-walnut-offline': String(t - 5 * MIN) }))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: t - 5 * MIN, source: 'http' })
    // An answer that left earlier but arrived later carries an older time: kept the newer.
    noteResponseHeaders(H({ 'x-walnut-offline': String(t - 9 * MIN) }))
    expect(getLeaderPresence().asOf).toBe(t - 5 * MIN)
    noteResponseHeaders(H({ 'x-walnut-offline': String(t - 1 * MIN) }))
    expect(getLeaderPresence().asOf).toBe(t - MIN)
    // Without a host name the line still reads.
    expect(awayLineText(getLeaderPresence(), t)!.line).toBe('Your Mac is away. This is the copy on this host from 1 min ago.')
    noteResponseHeaders(H({ 'x-walnut-answered-via': 'replica' }))
    expect(getLeaderPresence().answers).toBe(false)
    noteResponseHeaders(H({ 'x-walnut-answered-via': 'leader' }))
    expect(getLeaderPresence().answers).toBe(true)
    noteResponseHeaders(H({ 'x-walnut-offline': String(t) }))
    noteResponseHeaders(H({ 'x-walnut-answered-via': 'companion' }))
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('a garbage x-walnut-offline still means away, with no time, and the line says the age is not known', () => {
    noteResponseHeaders(H({ 'x-walnut-offline': 'soon' }))
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf: null })
    expect(awayLineText(getLeaderPresence(), Date.now())!.line).toBe('Your Mac is away. This is the copy on this host; its age is not known.')
  })

  it('/ws close codes: 4001 away, 4002 back, every other code changes nothing', () => {
    for (const code of [1000, 1001, 1006, 1011, 4000, 4003]) noteWsClose(code)
    expect(getLeaderPresence()).toMatchObject({ answers: true, source: 'none' })
    noteWsClose(WS_LEADER_AWAY)
    expect(getLeaderPresence()).toMatchObject({ answers: false, why: 'leader_away', source: 'close' })
    noteWsClose(1006)
    expect(getLeaderPresence().answers).toBe(false)
    noteWsClose(WS_LEADER_BACK)
    expect(getLeaderPresence()).toMatchObject({ answers: true, why: null, source: 'close' })
  })

  it('listeners hear a change once, not a repeat of the same facts', () => {
    const seen: boolean[] = []
    const off = subscribeLeaderPresence(() => seen.push(getLeaderPresence().answers))
    const t = Date.now()
    noteResponseHeaders(H({ 'x-walnut-offline': String(t) }))
    noteResponseHeaders(H({ 'x-walnut-offline': String(t) }))
    noteResponseHeaders(H({ 'x-walnut-offline': String(t) }))
    noteWsClose(WS_LEADER_BACK)
    noteWsClose(WS_LEADER_BACK)
    off()
    noteWsClose(WS_LEADER_AWAY)
    expect(seen).toEqual([false, true])
  })
})

describe('the words', () => {
  it('the age of the copy', () => {
    const now = 1_800_000_000_000
    // Not known: no made-up age (the line says so instead).
    expect(agoText(null, now)).toBeNull()
    expect(agoText(0, now)).toBeNull()
    expect(agoText(now, now)).toBe('just now')
    expect(agoText(now + 5_000, now)).toBe('just now') // a host clock a little ahead
    expect(agoText(now - 44_000, now)).toBe('just now')
    expect(agoText(now - 50_000, now)).toBe('1 min ago')
    expect(agoText(now - 2 * MIN, now)).toBe('2 min ago')
    expect(agoText(now - 59 * MIN, now)).toBe('59 min ago')
    expect(agoText(now - 60 * MIN, now)).toBe('1 h ago')
    expect(agoText(now - 23 * 60 * MIN, now)).toBe('23 h ago')
    expect(agoText(now - 24 * 60 * MIN, now)).toBe('1 day ago')
    expect(agoText(now - 3 * 24 * 60 * MIN, now)).toBe('3 days ago')
  })

  it('a session needs the Mac while it is away unless it runs on this host', () => {
    const away = { answers: false, asOf: 1, host: 'devbox', hostKey: 'devbox', why: 'quiet', source: 'ws' as const }
    expect(isMacSessionAway(away, { host: undefined })).toBe(true)
    expect(isMacSessionAway(away, { host: null })).toBe(true)
    expect(isMacSessionAway(away, { host: '' })).toBe(true)
    expect(isMacSessionAway(away, { host: '__local__' })).toBe(true)
    expect(isMacSessionAway(away, { host: 'otherbox' })).toBe(true)
    expect(isMacSessionAway(away, { host: 'devbox' })).toBe(false)
    expect(isMacSessionAway(away, { host: ' devbox ' })).toBe(false)
    // This host's name not known yet: no session is taken for this host's.
    expect(isMacSessionAway({ ...away, hostKey: null }, { host: 'devbox' })).toBe(true)
    // The Mac answers, or no session yet: never.
    expect(isMacSessionAway({ ...away, answers: true }, { host: undefined })).toBe(false)
    expect(isMacSessionAway(away, null)).toBe(false)
  })

  it('a replica error body gets plain words: "Needs your Mac" with the reason', () => {
    const e = (error: Record<string, unknown>) => leaderErrorMessage({ error })
    expect(e({ code: 'needs_leader', why: 'task_writes_need_mac' })).toBe('Needs your Mac. Changing a task needs your Mac for now.')
    expect(e({ code: 'needs_leader', why: 'session_writes_need_mac' })).toBe('Needs your Mac. Sending to a session needs your Mac for now.')
    expect(e({ code: 'needs_leader', why: 'terminal_needs_mac' })).toBe('Needs your Mac. The terminal runs through your Mac.')
    expect(e({ code: 'needs_leader', why: 'session_on_mac' })).toBe('Needs your Mac. This session runs through your Mac; its conversation is there.')
    expect(e({ code: 'needs_leader', why: 'daemon_unreachable' })).toBe('Needs your Mac. This host\'s Walnut daemon did not answer.')
    // This host's session: its files, and an older page of its conversation (away-session-reads.ts); an ask (ws-rpc-table.ts).
    expect(e({ code: 'needs_leader', why: 'session_files_need_mac' })).toBe('Needs your Mac. Reading this session\'s files needs your Mac for now.')
    expect(e({ code: 'needs_leader', why: 'history_pages_need_mac' })).toBe('Needs your Mac. Older messages load when your Mac is back.')
    expect(e({ code: 'needs_leader', why: 'ask_needs_mac' })).toBe('Needs your Mac. Asking Walnut needs your Mac for now.')
    expect(e({ code: 'needs_leader', why: 'something_new' })).toBe('Needs your Mac. Your Mac is not answering right now.')
    expect(e({ code: 'needs_leader' })).toBe('Needs your Mac. Your Mac is not answering right now.')
    expect(e({ code: 'leader_unsure', retryAfter: 5 })).toBe('Your Mac just came back; try again in a few seconds.')
    expect(e({ code: 'leader_unsure', why: 'lost_answer' })).toBe('Your Mac just came back. This host may have kept the change; check it before you try again.')
    expect(e({ code: 'primary_timeout', sent: true })).toBe('Your Mac did not answer in time, and it may have kept the change; check it before you try again.')
    expect(e({ code: 'primary_timeout', sent: false })).toBe('Your Mac did not answer in time. Nothing was saved; try again.')
    // A host journal that did not take the write (row R20): full, or not writable.
    expect(leaderErrorMessage({ error: { code: 'queue_full', message: 'this host already holds 1000 records for the Walnut server; wait for it to reconnect', retryAfter: 5 } }, 503))
      .toBe('This host already keeps as many changes as it can until your Mac is back; this one was not kept. Try it again once your Mac is back.')
    expect(leaderErrorMessage({ error: { code: 'queue_full', why: 'blobs' } }, 503)).toMatch(/^This host already keeps as many changes/)
    expect(e({ code: 'journal_unwritable', why: 'disk_full', message: 'this host could not save the change: ENOSPC' }))
      .toBe('This host could not keep this change: its disk is full. The changes it kept before are safe.')
    for (const why of ['permission', 'io', 'locked', 'not_owner', 'state_unreadable', 'migrating', undefined]) {
      expect(e({ code: 'journal_unwritable', ...(why ? { why } : {}) }), String(why)).toBe('This host could not keep this change. The changes it kept before are safe; try again in a moment.')
    }
    // The dispatcher's: every try went unanswered, so it may be kept.
    expect(e({ code: 'journal_unwritable', why: 'no_answer' })).toBe('This host did not answer, and it may have kept the change; check it before you try again.')
    // A busy session's queue on the Mac (429) keeps its own words: it is no host journal.
    expect(leaderErrorMessage({ error: { code: 'queue_full', message: 'session abc already has 50 queued messages' } }, 429)).toBeNull()
    expect(e({ code: 'queue_full' })).toBeNull()
    // Not a replica's: left to the caller.
    expect(e({ code: 'not_found' })).toBeNull()
    expect(leaderErrorMessage({ error: 'Task not found' })).toBeNull()
    expect(leaderErrorMessage(null)).toBeNull()
    expect(leaderErrorMessage('x')).toBeNull()
  })

  it('its words are told from any other message, so a surface shows them with no "Failed to ..." in front', () => {
    for (const error of [{ code: 'needs_leader', why: 'session_on_mac' }, { code: 'needs_leader' }, { code: 'leader_unsure' },
      { code: 'leader_unsure', why: 'lost_answer' }, { code: 'primary_timeout', sent: true }, { code: 'primary_timeout', sent: false },
      { code: 'queue_full' }, { code: 'journal_unwritable', why: 'disk_full' }, { code: 'journal_unwritable', why: 'io' }, { code: 'journal_unwritable', why: 'no_answer' }]) {
      expect(isLeaderWords(leaderErrorMessage({ error }, 503)), JSON.stringify(error)).toBe(true)
    }
    for (const other of ['Task not found', 'Needs your Mac', 'Your Mac is away.', 'HTTP 503', '', null, undefined, 42]) {
      expect(isLeaderWords(other)).toBe(false)
    }
  })
})

describe('the API client reads every answer', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('an away read marks the copy; an away write throws "Needs your Mac"; a forwarded answer clears the mark', async () => {
    const { apiGet, apiPatch, ApiError } = await import('../../web/src/api/client')
    const asOf = Date.now() - 3 * MIN
    const answers: Response[] = [
      new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-walnut-offline': String(asOf), 'x-walnut-answered-via': 'replica' } }),
      new Response(JSON.stringify({ error: { code: 'needs_leader', why: 'task_writes_need_mac', retryAfter: 5, message: 'This needs your Mac, which is not answering right now.' } }), {
        status: 503, headers: { 'content-type': 'application/json', 'x-walnut-offline': String(asOf), 'retry-after': '5' },
      }),
      new Response(JSON.stringify({ tasks: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-walnut-answered-via': 'leader' } }),
    ]
    vi.stubGlobal('fetch', vi.fn(async () => answers.shift()!))
    await apiGet('/api/tasks', undefined, { quietStatuses: [] })
    expect(getLeaderPresence()).toMatchObject({ answers: false, asOf })
    const err = await apiPatch('/api/tasks/t1', { title: 'x' }, { quietStatuses: [503] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as InstanceType<typeof ApiError>).status).toBe(503)
    expect((err as Error).message).toBe('Needs your Mac. Changing a task needs your Mac for now.')
    expect((err as InstanceType<typeof ApiError>).body).toMatchObject({ error: { code: 'needs_leader', why: 'task_writes_need_mac' } })
    await apiGet('/api/tasks')
    expect(getLeaderPresence().answers).toBe(true)
  })

  it('a non-replica error keeps the server\'s own message', async () => {
    const { apiPatch } = await import('../../web/src/api/client')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Task not found' }), { status: 404, headers: { 'content-type': 'application/json' } })))
    await expect(apiPatch('/api/tasks/nope', {}, { quietStatuses: [404] })).rejects.toThrow('Task not found')
    expect(getLeaderPresence().answers).toBe(true)
  })
})

describe('the hook in a mounted tree', () => {
  let doc: Document
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })

  function Probe({ host }: { host?: string }) {
    const p = useLeaderPresence()
    const line = useAwayLine()
    const macAway = useMacSessionAway({ host })
    return createElement('p', null, `${p.answers ? 'answers' : 'away'}|${line?.line ?? ''}|${line?.prompts ?? ''}|${macAway ? 'mac-away' : 'controls'}`)
  }

  it('renders the line while away and nothing once the Mac is back, with no remount', async () => {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    const root = createRoot(el as unknown as Element)
    let mounts = 0
    const Tracked = (props: { host?: string }) => {
      // A remount (what a reload would do) runs this effect again.
      useEffect(() => { mounts++ }, [])
      return createElement(Probe, props)
    }
    await act(async () => { root.render(createElement('div', null, createElement(Tracked, { host: undefined }), createElement(Tracked, { host: 'devbox' }))) })
    expect(el.textContent).toBe('answers|||controls' + 'answers|||controls')
    await act(async () => { notePresenceEvent({ answers: false, asOf: Date.now() - 2 * MIN, host: 'devbox', hostKey: 'devbox', why: 'quiet' }) })
    const awayText = 'away|Your Mac is away. This is the copy on devbox from 2 min ago.|Prompts on devbox are not pushed to your phone.|'
    expect(el.textContent).toBe(awayText + 'mac-away' + awayText + 'controls')
    await act(async () => { noteWsClose(WS_LEADER_BACK) })
    expect(el.textContent).toBe('answers|||controls' + 'answers|||controls')
    expect(mounts).toBe(2)
    await act(async () => { root.unmount() })
  })

  it('the age ticks while away without any new word from the replica', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const el = doc.createElement('div')
      doc.body.appendChild(el)
      const root = createRoot(el as unknown as Element)
      notePresenceEvent({ answers: false, asOf: Date.now(), host: 'devbox', why: 'quiet' })
      await act(async () => { root.render(createElement(Probe, {})) })
      expect(el.textContent).toContain('from just now.')
      await act(async () => { vi.advanceTimersByTime(5 * MIN) })
      expect(el.textContent).toContain('from 5 min ago.')
      await act(async () => { root.unmount() })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the WS client on the replica\'s handover codes', () => {
  interface FakeSocket { readyState: number; url: string; send(b: string): void; close(): void; onopen: (() => void) | null; onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: (() => void) | null; onmessage: ((ev: { data: string }) => void) | null }
  let sockets: FakeSocket[]
  let reload: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    sockets = []
    reload = vi.fn()
    const Fake = function (this: unknown, url: string) {
      const s: FakeSocket = { readyState: 0, url, send: () => {}, close: () => {}, onopen: null, onclose: null, onerror: null, onmessage: null }
      sockets.push(s)
      return s
    } as unknown as typeof WebSocket
    ;(Fake as unknown as { OPEN: number }).OPEN = 1
    vi.stubGlobal('WebSocket', Fake)
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:3999', href: 'http://127.0.0.1:3999/', origin: 'http://127.0.0.1:3999', reload } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function load() {
    const { wsClient } = await import('@/api/ws')
    const presence = await import('@/api/leader-presence')
    const { installLeaderPresence } = await import('@/hooks/useLeaderPresence')
    installLeaderPresence()
    const reconnected: number[] = []
    wsClient.onEvent('_ws:reconnected', () => reconnected.push(sockets.length))
    wsClient.connect()
    open(0)
    return { wsClient, presence, reconnected }
  }
  function open(i: number) { sockets[i]!.readyState = 1; sockets[i]!.onopen?.() }
  function close(i: number, code: number) { sockets[i]!.readyState = 3; sockets[i]!.onclose?.({ code, reason: '' }) }

  it('4001 moves the console off a quiet Mac at once, 4002 back, with no reload and a refetch each time', async () => {
    const { presence, reconnected, wsClient } = await load()
    // The replica's own socket tells whose copy this is, at connect.
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'event', name: 'replica:presence', data: { answers: true, asOf: 1, host: 'devbox', hostKey: 'devbox', why: 'answers' }, seq: 1 }) })
    expect(presence.getLeaderPresence()).toMatchObject({ answers: true, host: 'devbox' })
    close(0, 4001)
    expect(presence.getLeaderPresence()).toMatchObject({ answers: false, host: 'devbox', why: 'leader_away' })
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(2)
    open(1)
    expect(reconnected).toEqual([2])
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: 'event', name: 'replica:presence', data: { answers: false, asOf: 2, host: 'devbox', why: 'quiet' }, seq: 1 }) })
    expect(presence.getLeaderPresence()).toMatchObject({ answers: false, asOf: 2, why: 'quiet' })
    close(1, 4002)
    expect(presence.getLeaderPresence().answers).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(3)
    open(2)
    expect(reconnected).toEqual([2, 3])
    expect(reload).not.toHaveBeenCalled()
    expect(wsClient.lastClose).toMatchObject({ code: 4002, codeDesc: 'leader back (host replica)' })
  })

  it('any other close keeps the backoff, and a handover never makes a 0 ms loop of it', async () => {
    await load()
    close(0, 1006)
    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
    // A handover, then a socket that cannot open: the retry after it waits the reset backoff (1 s), not 0 ms.
    open(1)
    close(1, 4001)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(3)
    close(2, 1006)
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(4)
  })

  it('a WS write the replica refuses away says "Needs your Mac" with the reason', async () => {
    const { wsClient } = await load()
    const sent: string[] = []
    sockets[0]!.send = (b: string) => { sent.push(b) }
    const p = wsClient.sendRpc('session:send', { sessionId: 's1', text: 'hi' })
    const id = (JSON.parse(sent[0]!) as { id: string }).id
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: false, error: 'needs_leader: session_writes_need_mac' }) })
    await expect(p).rejects.toThrow('Needs your Mac. Sending to a session needs your Mac for now.')
    // Any other refusal is passed on as it was.
    const q = wsClient.sendRpc('tasks:list', {})
    const id2 = (JSON.parse(sent[1]!) as { id: string }).id
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'res', id: id2, ok: false, error: 'Unknown method: tasks:list' }) })
    await expect(q).rejects.toThrow('Unknown method: tasks:list')
  })

  it('a raw fetch through window.fetch is read too (the installed wrapper), another origin\'s never', async () => {
    ;(window as unknown as { fetch: unknown }).fetch = vi.fn(async () => new Response('{}', { status: 200, headers: { 'x-walnut-offline': '1700000000000' } }))
    const { presence } = await load()
    await window.fetch('https://elsewhere.example/api/x')
    expect(presence.getLeaderPresence().answers).toBe(true)
    await window.fetch('/api/notes/tree')
    expect(presence.getLeaderPresence()).toMatchObject({ answers: false, asOf: 1700000000000 })
  })
})
