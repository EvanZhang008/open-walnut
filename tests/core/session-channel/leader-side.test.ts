/**
 * The leader side of a host that runs its sessions (src/core/session-channel/leader-side.ts),
 * against a real HostChannel behind a real WebSocket door, over a byte stream as the host's
 * daemon relays it: every record is applied exactly once and in order, across a link that drops
 * and dials again; rows and renames go to the batch apply with the position, facts to the bus
 * (late when read back long after), `live` records to the proxies; and the commands go as HTTP
 * requests on the same kind of stream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from '#ws'
import { FactLog } from '../../../src/core/session-channel/fact-log.js'
import { HostChannel, isChannelFrame, type ChannelCursor } from '../../../src/core/session-channel/channel.js'
import { createLeaderSide, reportJudges, type LeaderSide } from '../../../src/core/session-channel/leader-side.js'
import type { HostChannelBatch } from '../../../src/core/session-tracker.js'
import type { SessionRecord } from '../../../src/core/types.js'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await tick(5) }
}

let dir = ''
let server: http.Server | null = null
let sockets: net.Socket[] = []
let side: LeaderSide | null = null
let logs: FactLog[] = []
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'leader-side-')); sockets = []; logs = [] })
afterEach(async () => {
  side?.stop()
  side = null
  // Its pending writes (an ack's state) land before the folder goes.
  for (const l of logs) await l.close().catch(() => {})
  for (const s of sockets) s.destroy()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  await fsp.rm(dir, { recursive: true, force: true })
})

/** The host's door: the channel on its WebSocket route, the session calls as plain routes. */
async function hostDoor(channel: HostChannel, calls: Array<{ route: string; body: unknown }>) {
  const wss = new WebSocketServer({ noServer: true })
  server = http.createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}')
      calls.push({ route: req.url ?? '', body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/host-api/sessions/start') res.end(JSON.stringify({ ok: true, sessionId: 'new-sid', title: 'T' }))
      else if (req.url === '/host-api/sessions/call') res.end(JSON.stringify({ ok: true, value: { member: body.member } }))
      else res.end(JSON.stringify({ ok: true }))
    })
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/host-api/session-channel') { socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const h = channel.attach({ send: (f) => ws.send(JSON.stringify(f)), close: (why) => ws.close(1000, why) })
      ws.on('message', (d: Buffer) => { const f = JSON.parse(d.toString()); if (isChannelFrame(f)) h.onFrame(f) })
      ws.on('close', () => h.onClose())
    })
  })
  server.on('connection', (s) => sockets.push(s))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return (server.address() as net.AddressInfo).port
}

/** The leader's data, as the batch apply keeps it. */
function leaderStore() {
  const store = { batches: [] as HostChannelBatch[], cursor: null as ChannelCursor | null, emitted: [] as Array<{ name: string; late: boolean; at?: number; i?: number; data?: unknown }>, live: [] as Array<{ sid: string; turnGen?: number }>, renames: [] as string[], judged: [] as string[] }
  return store
}

function makeSide(port: number, store: ReturnType<typeof leaderStore>, opts: { opened?: string[]; flag?: { on: boolean }; refuse?: string[]; gone?: string[]; drops?: string[]; owned?: string[]; extra?: Partial<Parameters<typeof createLeaderSide>[0]> } = {}) {
  return createLeaderSide({
    walnutId: async () => 'w1',
    permit: () => ({ permitNumber: 0, epoch: 1 }),
    flagOn: async () => opts.flag?.on ?? true,
    openStream: async (_host, purpose) => { opts.opened?.push(purpose); return net.connect(port, '127.0.0.1') },
    applyBatch: async (b) => {
      store.batches.push(b)
      store.cursor = b.cursor
      const refused = new Set(opts.refuse ?? [])
      const gone = new Set(opts.gone ?? [])
      return {
        // As the real apply (session-tracker applyHostChannelBatch): a rename writes its new id.
        written: [...b.rows.map((r) => r.sid), ...b.renames.map((r) => r.to)].filter((s) => !refused.has(s) && !gone.has(s)), skipped: b.rows.map((r) => r.sid).filter((s) => refused.has(s)),
        gone: [...new Set([...b.rows.map((r) => r.sid), ...(b.check ?? [])])].filter((s) => gone.has(s)),
      }
    },
    ...(opts.drops ? { leaderDrops: async () => [...opts.drops!] } : {}),
    loadCursor: async () => store.cursor,
    emit: (name, data, o) => { store.emitted.push({ name, late: o.late, at: o.at, i: (data as { i?: number })?.i, data }) },
    noteLive: (sid, state) => { store.live.push({ sid, turnGen: state.turnGen }) },
    noteRename: (from, to) => { store.renames.push(`${from}->${to}`) },
    noteHostJudged: (sid) => { store.judged.push(sid) },
    // The host's own sessions here: the ones its rows wrote, and this test host's s1 family.
    ownerOf: (sid) => (store.judged.includes(sid) || (opts.owned ?? ['s1', 's1b', 's2']).includes(sid) ? 'devbox' : null),
    backoffMs: () => 20,
    log: () => {},
    ...(opts.extra ?? {}),
  })
}

async function hostOf(o: { gone?: string[]; onLeaderLinked?: () => void } = {}) {
  const log = await FactLog.open({ dir, walnutId: 'w1', flushMs: 1, durable: false })
  logs.push(log)
  const own: SessionRecord[] = [{ claudeSessionId: 's1', taskId: 't', project: 'P', process_status: 'running', mode: 'default', host: 'devbox', judge: 'host' } as SessionRecord]
  return { log, channel: new HostChannel({ log, walnutId: 'w1', hostId: 'devbox', ownRows: async () => own, ...(o.gone ? { goneRows: () => o.gone! } : {}), ...(o.onLeaderLinked ? { onLeaderLinked: o.onLeaderLinked } : {}) }) }
}

const factIs = (store: ReturnType<typeof leaderStore>) => store.emitted.filter((e) => e.name === 'session:tool-use').map((e) => e.i)

describe('the leader side of a host that runs its sessions', () => {
  it('dials only while the switch is on and the host names the capability and is connected', async () => {
    const { channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    side = makeSide(port, store)
    await side.noteHost('devbox', { connected: true, judges: false })
    await tick(60)
    expect(side.linked('devbox')).toBe(false)
    expect(side.hostJudges('devbox')).toBe(false)
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    expect(side.hostJudges('devbox')).toBe(true)
    await side.noteHost('devbox', { connected: false, judges: true })
    expect(side.linked('devbox')).toBe(false)
    expect(side.hostJudges('devbox')).toBe(false)
  })

  it('the switch going off keeps the link for the sessions the host already runs; only the next start stays here', async () => {
    const { channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    const flag = { on: true }
    side = makeSide(port, store, { flag })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    expect(side.hostJudges('devbox')).toBe(true)
    flag.on = false
    await side.refreshFlag()
    expect(side.hostJudges('devbox')).toBe(false)
    await tick(60)
    expect(side.linked('devbox')).toBe(true)
    flag.on = true
    await side.refreshFlag()
    expect(side.hostJudges('devbox')).toBe(true)
  })

  it('applies every record once, in order, across a drop and a dial again; rows, renames, live and facts each go their way', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    side = makeSide(port, store)
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    log.append('s1', 'row', { born: true, patch: { claudeSessionId: 's1', host: 'devbox', judge: 'host' } })
    for (let i = 1; i <= 5; i++) log.append('s1', 'session:tool-use', { sessionId: 's1', i })
    log.append('s1', 'live', { state: { turnGen: 3 } })
    log.append('s1', 'rename', { from: 's1', to: 's1b' })
    log.append('s1', 'session:text-delta', { sessionId: 's1' }) // not a fact: never re-emitted from the log
    await log.flush()
    await until(() => factIs(store).length === 5)
    // The link drops; more happens on the host meanwhile.
    for (const s of sockets) s.destroy()
    await until(() => !side!.linked('devbox'))
    for (let i = 6; i <= 9; i++) log.append('s1', 'session:tool-use', { sessionId: 's1', i })
    await log.flush()
    await until(() => factIs(store).length === 9)
    await tick(50)
    await side.idle('devbox')
    expect(factIs(store)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(store.emitted.some((e) => e.name === 'session:text-delta')).toBe(false)
    expect(store.live).toEqual([{ sid: 's1', turnGen: 3 }])
    expect(store.renames).toEqual(['s1->s1b'])
    const rows = store.batches.flatMap((b) => b.rows)
    expect(rows.filter((r) => r.sid === 's1' && r.born)).toHaveLength(1)
    expect(store.batches.flatMap((b) => b.renames)).toEqual([expect.objectContaining({ from: 's1', to: 's1b' })])
    expect(store.cursor?.seq).toBe(log.head)
    expect(store.judged).toContain('s1')
  })

  it('a record read back long after it happened is late; a live one never is', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const happened = Date.now() - 10 * 60_000
    log.append('s1', 'session:tool-use', { sessionId: 's1', i: 1 }, { at: happened })
    await log.flush()
    const store = leaderStore()
    side = makeSide(port, store)
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => factIs(store).length === 1)
    log.append('s1', 'session:tool-use', { sessionId: 's1', i: 2 })
    await log.flush()
    await until(() => factIs(store).length === 2)
    expect(store.emitted.filter((e) => e.name === 'session:tool-use').map((e) => e.late)).toEqual([true, false])
    // Each is said with the time it happened (the same clock here): the late one ten minutes ago.
    const [lateOne, liveOne] = store.emitted.filter((e) => e.name === 'session:tool-use')
    expect(Math.abs((lateOne.at ?? 0) - happened)).toBeLessThan(1_000)
    expect(Date.now() - (liveOne.at ?? 0)).toBeLessThan(30_000)
  })

  it('sends the commands as requests on a stream of their own', async () => {
    const { channel } = await hostOf()
    const calls: Array<{ route: string; body: unknown }> = []
    const port = await hostDoor(channel, calls)
    const opened: string[] = []
    side = makeSide(port, leaderStore(), { opened })
    await expect(side.startOnHost('devbox', { taskId: 't', message: 'hi' })).resolves.toMatchObject({ ok: true, sessionId: 'new-sid' })
    await side.sendToHost('devbox', { sessionId: 's1', message: 'm' })
    await side.interruptOnHost('devbox', { sessionId: 's1' })
    await expect(side.callHost('devbox', { sid: 's1', target: 'session', member: 'getUsage', args: [] })).resolves.toEqual({ member: 'getUsage' })
    expect(calls.map((c) => c.route)).toEqual(['/host-api/sessions/start', '/host-api/sessions/send', '/host-api/sessions/interrupt', '/host-api/sessions/call'])
    expect(opened).toEqual(['session-call', 'session-call', 'session-call', 'session-call'])
  })

  it('a session born on the host is said as started at its row\'s place, once; a refused row or a resync of the rows says none', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    side = makeSide(port, store, { refuse: ['s3'] })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    log.append('s2', 'row', { born: true, patch: { claudeSessionId: 's2', taskId: 'task-h', project: 'Marina', host: 'devbox', judge: 'host', mode: 'plan' } })
    log.append('s2', 'session:tool-use', { sessionId: 's2', i: 1 })
    log.append('s2', 'row', { patch: { process_status: 'idle' } })
    log.append('s3', 'row', { born: true, patch: { claudeSessionId: 's3', taskId: 'task-x', host: 'devbox', judge: 'host' } })
    log.append('s3', 'session:tool-use', { sessionId: 's3', i: 2 })
    log.append('s2', 'session:tool-use', { sessionId: 's2', i: 3 })
    await log.flush()
    await until(() => factIs(store).length === 2)
    await side.idle('devbox')
    // The refused row's session is not this host's here: its fact is not said either (M1).
    expect(factIs(store)).toEqual([1, 3])
    const started = store.emitted.filter((e) => e.name === 'session:started')
    expect(started.map((e) => e.data)).toEqual([{ sessionId: 's2', claudeSessionId: 's2', taskId: 'task-h', project: 'Marina', host: 'devbox' }])
    expect(started[0]!.late).toBe(false)
    // At its row's place: before the session's first fact.
    expect(store.emitted.filter((e) => (e.data as { sessionId?: string })?.sessionId === 's2').map((e) => e.name)).toEqual(['session:started', 'session:tool-use', 'session:tool-use'])
    // The rows frame of the first link (s1, a resync) said no start.
    expect(store.emitted.some((e) => e.name === 'session:started' && (e.data as { sessionId?: string }).sessionId === 's1')).toBe(false)
  })

  it('says nothing a host sends of a session it does not own, nor of another session than its record names; a rename it did not apply moves nothing', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    // 'theirs' is another host's session, 'leaders' the leader's own (no host): neither is devbox's.
    side = makeSide(port, store, { owned: ['s1'], refuse: ['leaders'] })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    log.append('theirs', 'session:result', { sessionId: 'theirs', i: 1 })
    log.append('theirs', 'live', { state: { turnGen: 9 } })
    log.append('s1', 'session:tool-use', { sessionId: 'leaders', i: 2 })
    log.append('leaders', 'rename', { from: 'gone-old', to: 'leaders' })
    log.append('s1', 'session:tool-use', { sessionId: 's1', i: 3 })
    log.append('s1', 'live', { state: { turnGen: 4 } })
    await log.flush()
    await until(() => factIs(store).length === 1)
    await side.idle('devbox')
    expect(factIs(store)).toEqual([3])
    expect(store.emitted.some((e) => e.name === 'session:result')).toBe(false)
    expect(store.live).toEqual([{ sid: 's1', turnGen: 4 }])
    expect(store.renames).toEqual([])
  })

  it('a record an earlier link applied is said once; a step after the apply that throws never closes the link', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    let throws = 1
    side = createLeaderSide({
      walnutId: async () => 'w1', permit: () => ({ permitNumber: 0, epoch: 1 }), flagOn: async () => true,
      openStream: async () => net.connect(port, '127.0.0.1'),
      // The store had applied up to seq 2 already (a link before this one): the transaction says so.
      applyBatch: async (b) => { store.cursor = b.cursor; return { written: [], skipped: [], after: 2 } },
      loadCursor: async () => null,
      emit: (name, data) => {
        if (throws-- > 0) throw new Error('a subscriber threw')
        store.emitted.push({ name, late: false, i: (data as { i?: number })?.i })
      },
      noteLive: () => { throw new Error('no proxy') },
      noteRename: () => {}, noteHostJudged: () => {}, ownerOf: () => 'devbox', backoffMs: () => 20, log: () => {},
    })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    for (let i = 1; i <= 5; i++) log.append('s1', 'session:tool-use', { sessionId: 's1', i })
    log.append('s1', 'live', { state: { turnGen: 1 } })
    log.append('s1', 'session:tool-use', { sessionId: 's1', i: 6 })
    await log.flush()
    await until(() => factIs(store).length === 3)
    await side.idle('devbox')
    // 1 and 2 were said by the earlier link; 3's emit threw (logged), and the link went on.
    expect(factIs(store)).toEqual([4, 5, 6])
    expect(side.linked('devbox')).toBe(true)
  })

  it('a delete this leader made goes to the host at each link until its drop record answers; nothing of the deleted session is said meanwhile', async () => {
    const { log, channel } = await hostOf()
    const calls: Array<{ route: string; body: unknown }> = []
    const port = await hostDoor(channel, calls)
    const store = leaderStore()
    const drops = ['gone-1']
    side = makeSide(port, store, { gone: ['gone-1'], drops })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => calls.some((c) => c.route === '/host-api/sessions/drop'))
    expect(calls.find((c) => c.route === '/host-api/sessions/drop')!.body).toEqual({ sids: ['gone-1'] })
    // What the host wrote of it before it heard: neither its facts nor its live state are said.
    log.append('gone-1', 'session:tool-use', { sessionId: 'gone-1', i: 1 })
    log.append('gone-1', 'live', { state: { turnGen: 4 } })
    log.append('gone-1', 'drop', { sid: 'gone-1' })
    log.append('s1', 'session:tool-use', { sessionId: 's1', i: 2 })
    await log.flush()
    await until(() => factIs(store).length === 1)
    await side.idle('devbox')
    expect(factIs(store)).toEqual([2])
    expect(store.live).toEqual([])
    // The drop record went to the batch: its mark is cleared there.
    expect(store.batches.flatMap((b) => b.drops ?? [])).toEqual(['gone-1'])
    expect(store.batches.flatMap((b) => b.check ?? [])).toContain('gone-1')
    // A new delete goes at once while linked; and again at the next link.
    const before = calls.filter((c) => c.route === '/host-api/sessions/drop').length
    drops.push('gone-2')
    await side.dropOnHost('devbox')
    expect(calls.filter((c) => c.route === '/host-api/sessions/drop')).toHaveLength(before + 1)
    for (const sock of sockets) sock.destroy()
    await until(() => calls.filter((c) => c.route === '/host-api/sessions/drop').length === before + 2)
    expect(calls.filter((c) => c.route === '/host-api/sessions/drop').at(-1)!.body).toEqual({ sids: ['gone-1', 'gone-2'] })
  })

  it('R2-H1: a born row that a rename of the same batch moves a session into is that session\'s, never a start', async () => {
    const { log, channel } = await hostOf()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    side = makeSide(port, store, { owned: ['s1', 'old-a'] })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => side!.linked('devbox'))
    // An older host: the new id's row went out as born, then the rename.
    log.append('new-b', 'row', { born: true, patch: { claudeSessionId: 'new-b', taskId: 'task-done', host: 'devbox', judge: 'host' } })
    log.append('new-b', 'rename', { from: 'old-a', to: 'new-b' })
    log.append('new-b', 'session:tool-use', { sessionId: 'new-b', i: 1 })
    await log.flush()
    await until(() => factIs(store).length === 1)
    await side.idle('devbox')
    expect(store.emitted.filter((e) => e.name === 'session:started')).toEqual([])
    expect(store.renames).toEqual(['old-a->new-b'])
  })

  it('R2-H3: a rows frame carries its position and the rows the host removed', async () => {
    const { log, channel } = await hostOf({ gone: ['renamed-away'] })
    for (let i = 0; i < 3; i++) log.append('s1', 'session:tool-use', { sessionId: 's1', i })
    await log.flush()
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    // A leader that knew this host under another log: rows first.
    store.cursor = { logId: 'an-older-log', seq: 40 }
    side = makeSide(port, store)
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => store.batches.some((b) => !!b.snapshot))
    await side.idle('devbox')
    const snap = store.batches.find((b) => !!b.snapshot)!
    expect(snap.snapshot!.at).toBe(log.head)
    expect(snap.snapshot!.gone).toEqual(['renamed-away'])
  })

  it('R2-M1: each link asks the host for its live state again; a link down past the bound marks the host\'s sessions unknown, a quick one does not; a drop clears its state', async () => {
    let linked = 0
    const { log, channel } = await hostOf({ onLeaderLinked: () => { linked++ } })
    const port = await hostDoor(channel, [])
    const store = leaderStore()
    const lost: string[] = []
    const gone: string[] = []
    side = makeSide(port, store, {
      extra: {
        liveUnknownMs: 150, onLinkLost: (h) => { lost.push(h) },
        noteLive: (sid, state) => { if (state.gone) gone.push(sid); else store.live.push({ sid, turnGen: state.turnGen }) },
      },
    })
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => linked === 1)
    // A quick drop: the link is back before the bound.
    for (const sk of sockets) sk.destroy()
    await until(() => linked === 2)
    await tick(250)
    expect(lost).toEqual([])
    // The host goes away and stays away.
    await side.noteHost('devbox', { connected: false, judges: true })
    await until(() => lost.length === 1, 3000)
    expect(lost).toEqual(['devbox'])
    // Back: linked again, its live state asked for again.
    await side.noteHost('devbox', { connected: true, judges: true })
    await until(() => linked === 3)
    log.append('s1', 'drop', { sid: 's1' })
    await log.flush()
    await until(() => gone.length === 1)
    expect(gone).toEqual(['s1'])
  })

  it('reads the capability from a host\'s report', () => {
    expect(reportJudges({ capabilities: ['session-judge-v1'] })).toBe(true)
    expect(reportJudges({ capabilities: [] })).toBe(false)
    expect(reportJudges(null)).toBe(false)
  })
})
