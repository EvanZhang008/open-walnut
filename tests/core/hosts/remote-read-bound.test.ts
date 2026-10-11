/**
 * Request-path reads against a remote host answer within a deadline
 * (core/hosts/remote-read-bound.ts): a host that is still connecting never
 * pins a request for the length of its dial, and a connected host is judged by
 * PROGRESS: a read whose bytes keep arriving is never cut, one that stopped
 * receiving anything is.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-read-bound'))

import {
  HOST_LIVENESS_PROBE_MS, HOST_READ_DIAL_CAP_MS, HOST_READ_IDLE_MS, HOST_READ_KEPT_MAX, HOST_READ_QUIET_MS,
  HOST_READ_RESULT_TTL_MS, HOST_READ_STREAM_CAP_MS, HOST_RECONNECTING, HOST_SILENT_MEMO_MS, HostReconnectingError,
  HostStillLoadingError, boundByProgress, boundHostRead, boundSharedHostRead, forgetSharedHostRead, keptHostReadCount,
  resetSharedHostReadsForTest,
} from '../../../src/core/hosts/remote-read-bound.js'
import { creditCurrentRead, currentReadProgress, type ReadProgress } from '../../../src/core/hosts/read-progress.js'
import { hostDisplayName, inHostTerms } from '../../../src/core/hosts/host-display-name.js'
import { SessionControlError } from '../../../src/core/sessions/session-controls.js'
import { daemonConnectWouldWait } from '../../../src/providers/daemon-connection.js'
import { markLinkFailure } from '../../../src/providers/link-failure.js'
import { log } from '../../../src/logging/index.js'

/** What a degraded answer must never carry: an errno, a URL, the dial's own words (gate links F1). */
const RAW = /\bE[A-Z]{3,}\b|wss?:\/\/|https?:\/\/|url=|host=|\bssh[: ]|Command failed|WebSocket|tunnel failed|refused/

const label = async (h: string) => (h === '__cloudbox__' ? 'Cloud' : h)
const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms))

describe('boundHostRead', () => {
  it('a local session reads as is, however long it takes', async () => {
    for (const host of [undefined, null, '', '__local__']) {
      let asked = false
      const v = await boundHostRead(host, () => later(60, 'local'), { wouldWait: () => { asked = true; return 'dialing' }, capMs: 10 })
      expect(v).toBe('local')
      expect(asked).toBe(false)
    }
  })

  it('a connected host that answers before the quiet point is an ordinary read: no probe', async () => {
    let probed = 0
    const probe = async () => { probed++; return true }
    expect(await boundHostRead('__cloudbox__', () => later(80, 'read'), { wouldWait: () => 'connected', capMs: 10, quietMs: 500, probe, label })).toBe('read')
    expect(probed).toBe(0)
  })

  it('connected but silent: the quiet read asks the link once, and answers degraded the moment it is silent', async () => {
    const asked: Array<[string, number]> = []
    // The cloud box's silent link is closed by the probe: the pool re-dials it.
    let state: 'connected' | 'dialing' = 'connected'
    const probe = async (h: string, ms: number) => { asked.push([h, ms]); await later(60, null); state = 'dialing'; return false }
    let rejectLate!: (e: Error) => void
    const read = () => new Promise<string>((_r, reject) => { rejectLate = reject })
    const t0 = Date.now()
    const err = await boundHostRead('__cloudbox__', read, { wouldWait: () => state, quietMs: 100, probeMs: 777, probe, label }).catch((e) => e)
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err).toMatchObject({ message: 'Reconnecting to Cloud', statusCode: 503, extra: { code: HOST_RECONNECTING } })
    expect(asked).toEqual([['__cloudbox__', 777]])
    expect(took).toBeGreaterThanOrEqual(150)
    expect(took).toBeLessThan(1_000)
    // The abandoned read failing later is not an unhandled rejection.
    rejectLate(new Error('daemon command timeout: fs.ls (30000ms)'))
    await later(20, null)
  })

  it('connected and answering pings but sending the read nothing: it keeps its slot until the idle bound, then says the host did not answer in time', async () => {
    const probe = async () => true
    const heard = () => 0
    expect(await boundHostRead('__cloudbox__', () => later(300, 'slow but here'), { wouldWait: () => 'connected', quietMs: 50, probe, heard, idleMs: 2_000, label })).toBe('slow but here')
    const t0 = Date.now()
    const err = await boundHostRead('__cloudbox__', () => later(5_000, 'too late'), { wouldWait: () => 'connected', quietMs: 50, probe, heard, idleMs: 400, label }).catch((e) => e)
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err.message).toBe('Cloud did not answer in time')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390)
    expect(Date.now() - t0).toBeLessThan(1_500)
  })

  it('the idle bound is a few round trips of the link when that is longer: a slow link is not cut before its reply can come', async () => {
    const probe = async () => true
    const heard = () => 0
    // A 300ms round trip: four of them (1.2s) outlast the 400ms bound, and a reply at 800ms is in time.
    expect(await boundHostRead('__cloudbox__', () => later(800, 'slow link, in time'), {
      wouldWait: () => 'connected', quietMs: 50, probe, heard, idleMs: 400, roundTrip: () => 300, label,
    })).toBe('slow link, in time')
    // Still bounded: nothing for four round trips is the end of it.
    const t0 = Date.now()
    const err = await boundHostRead('__cloudbox__', () => later(5_000, 'too late'), {
      wouldWait: () => 'connected', quietMs: 50, probe, heard, idleMs: 400, roundTrip: () => 300, label,
    }).catch((e) => e)
    expect(err.message).toBe('Cloud did not answer in time')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4 * 300 - 10)
    expect(Date.now() - t0).toBeLessThan(2_500)
    // A quick link (or none measured) keeps the bound as it is.
    const t1 = Date.now()
    const quick = await boundHostRead('__cloudbox__', () => later(5_000, 'too late'), {
      wouldWait: () => 'connected', quietMs: 50, probe, heard, idleMs: 400, roundTrip: () => 20, label,
    }).catch((e) => e)
    expect(quick.message).toBe('Cloud did not answer in time')
    expect(Date.now() - t1).toBeLessThan(1_000)
  })

  it('a read whose bytes keep arriving is never cut by the idle bound, and asks the link nothing', async () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 10_000 }, 20)
    let probed = 0
    try {
      const v = await boundHostRead('devbox', () => later(900, 'all of it'), {
        wouldWait: () => 'connected', quietMs: 50, idleMs: 200, streamCapMs: 10_000, heard: () => bytes, probe: async () => { probed++; return true }, label,
      })
      expect(v).toBe('all of it')
      expect(probed).toBe(0)
    } finally { clearInterval(feed) }
  })

  it('bytes that stop: the idle bound counts from the last of them; a pong is not progress', async () => {
    let bytes = 0
    const t0 = Date.now()
    // Real bytes for 300ms, then only a few bytes a window (pongs).
    const feed = setInterval(() => { bytes += Date.now() - t0 < 300 ? 10_000 : 6 }, 20)
    try {
      const err = await boundHostRead('devbox', () => later(5_000, 'never'), {
        wouldWait: () => 'connected', quietMs: 50, idleMs: 400, streamCapMs: 10_000, heard: () => bytes, probe: async () => true, label,
      }).catch((e) => e)
      const took = Date.now() - t0
      expect(err).toBeInstanceOf(HostReconnectingError)
      expect(err.message).toBe('devbox did not answer in time')
      expect(took).toBeGreaterThanOrEqual(650)
      expect(took).toBeLessThan(1_500)
    } finally { clearInterval(feed) }
  })

  it('still arriving at the stream cap: the request answers, the read goes on', async () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 10_000 }, 20)
    let finished = false
    const read = () => later(700, 'late but whole').then((v) => { finished = true; return v })
    try {
      const t0 = Date.now()
      const err = await boundHostRead('__cloudbox__', read, {
        wouldWait: () => 'connected', quietMs: 50, idleMs: 5_000, streamCapMs: 300, heard: () => bytes, probe: async () => true, label,
      }).catch((e) => e)
      expect(err).toBeInstanceOf(HostReconnectingError)
      expect(err.message).toBe('Still loading from Cloud. Try again in a moment.')
      expect(Date.now() - t0).toBeLessThan(600)
      expect(finished).toBe(false)
      await later(700, null)
      expect(finished).toBe(true)
    } finally { clearInterval(feed) }
  })

  it('any other host keeps its link when silent: the answer says it is not answering, never that it reconnects', async () => {
    const t0 = Date.now()
    const err = await boundHostRead('devbox', () => later(5_000, 'never'), {
      wouldWait: () => 'connected', quietMs: 50, probe: async () => { await later(30, null); return false }, label,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err).toMatchObject({ message: 'devbox is not answering', statusCode: 503, extra: { code: HOST_RECONNECTING } })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('a link a probe found silent moments ago: the next read asks it at once, and a link that came back since is answered', async () => {
    let started = false
    const t0 = Date.now()
    const stillSilent = await boundHostRead('devbox', async () => { started = true; return later(5_000, 'x') }, {
      wouldWait: () => 'connected', silent: () => true, quietMs: 2_000, probe: async () => { await later(40, null); return false }, label,
    }).catch((e) => e)
    expect(stillSilent).toBeInstanceOf(HostReconnectingError)
    expect(stillSilent.message).toBe('devbox is not answering')
    // At the probe, not after its own 2s quiet window.
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(started).toBe(true)
    // The link is back: the old verdict is not repeated (the gate saw it 46ms after the link returned).
    const back = await boundHostRead('devbox', () => later(80, 'back'), {
      wouldWait: () => 'connected', silent: () => true, quietMs: 2_000, probe: async () => true, label,
    })
    expect(back).toBe('back')
  })

  it("progress is the read's own: another read's bytes on the same host do not keep it waiting", async () => {
    let hostBytes = 0
    const feed = setInterval(() => { hostBytes += 10_000 }, 20)
    try {
      const t0 = Date.now()
      // The read's one command hears nothing; something else on the host streams.
      const err = await boundHostRead('devbox', async () => { creditCurrentRead(() => 0); return later(5_000, 'never') }, {
        wouldWait: () => 'connected', quietMs: 50, idleMs: 400, streamCapMs: 10_000, heard: () => hostBytes, probe: async () => true, label,
      }).catch((e) => e)
      expect(err).toBeInstanceOf(HostReconnectingError)
      expect(err.message).toBe('devbox did not answer in time')
      expect(Date.now() - t0).toBeLessThan(1_500)
    } finally { clearInterval(feed) }
  })

  it('a settled read counts nothing more: a timer it left behind adds no command to it', async () => {
    let seen: ReadProgress | undefined
    const v = await boundHostRead('devbox', async () => {
      seen = currentReadProgress()
      creditCurrentRead(() => 5)
      // A dial or a loop started inside the read keeps its context for good.
      setTimeout(() => creditCurrentRead(() => 7), 50)
      return 'done'
    }, { wouldWait: () => 'connected', quietMs: 500, label })
    expect(v).toBe('done')
    await later(120, null)
    expect(seen?.open).toBe(false)
    expect(seen?.commands).toBe(0)
  })

  it("bytes that reach the read's own command are its progress, whatever the host's count says", async () => {
    let own = 0
    const feed = setInterval(() => { own += 10_000 }, 20)
    let probed = 0
    try {
      const v = await boundHostRead('devbox', async () => { creditCurrentRead(() => own); return later(900, 'mine') }, {
        wouldWait: () => 'connected', quietMs: 50, idleMs: 200, streamCapMs: 10_000, heard: () => 0, probe: async () => { probed++; return true }, label,
      })
      expect(v).toBe('mine')
      expect(probed).toBe(0)
    } finally { clearInterval(feed) }
  })

  it('a read that answers while its probe is out is the answer', async () => {
    const probe = () => later(2_000, false)
    expect(await boundHostRead('devbox', () => later(120, 'just in time'), { wouldWait: () => 'connected', quietMs: 50, probe, label })).toBe('just in time')
  })

  it('a failure the pool already knows is the degraded answer: a plain sentence in the host\'s name; the cause goes to the log only', async () => {
    const info = vi.spyOn(log.web, 'info')
    try {
      const why = 'Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET (host=__cloudbox__, url=ws://127.0.0.1:53389/daemon-tunnel)'
      const err = await boundHostRead('__cloudbox__', () => Promise.reject(new Error(`Connection to __cloudbox__ failed 3s ago: ${why}`)), {
        wouldWait: () => 'fails-fast', capMs: 10, label, reason: async () => why,
      }).catch((e) => e)
      expect(err).toBeInstanceOf(HostReconnectingError)
      expect(err).toMatchObject({ statusCode: 503, message: "Can't reach Cloud right now." })
      expect(err.message).not.toMatch(RAW)
      expect(err.message).not.toContain('__cloudbox__')
      // The dial's own words are kept, for whoever reads the log.
      expect(info.mock.calls.some(([msg, data]) => /last dial failed/.test(String(msg)) && (data as { why?: string })?.why === why)).toBe(true)
      // An ssh host's cached refusal reads the same way.
      const ssh = await boundHostRead('devbox', () => Promise.reject(new Error('x')), {
        wouldWait: () => 'fails-fast', capMs: 10, label, reason: async () => 'ssh: connect to host devbox.example.test port 22: Connection refused',
      }).catch((e) => e)
      expect(ssh.message).toBe(`Can't reach ${await label('devbox')} right now.`)
      expect(ssh.message).not.toMatch(RAW)
      // No cause known: the same sentence.
      const none = await boundHostRead('__cloudbox__', () => Promise.reject(new Error('x')), {
        wouldWait: () => 'fails-fast', capMs: 10, label, reason: async () => undefined,
      }).catch((e) => e)
      expect(none.message).toBe("Can't reach Cloud right now.")
    } finally { info.mockRestore() }
  })

  it('a connected link that drops during the read answers degraded; the request\'s own 4xx and a read that never dialled keep their errors', async () => {
    let state: 'connected' | 'dialing' | 'cold' = 'connected'
    const dropped = await boundHostRead('__cloudbox__', async () => { state = 'dialing'; throw new Error('DaemonConnection not connected to __cloudbox__') }, { wouldWait: () => state, label }).catch((e) => e)
    expect(dropped).toBeInstanceOf(HostReconnectingError)
    expect(dropped.message).toBe('Reconnecting to Cloud')

    const own = await boundHostRead('__cloudbox__', () => Promise.reject(new SessionControlError('Session not found', 404)), { wouldWait: () => 'fails-fast', label }).catch((e) => e)
    expect(own).toMatchObject({ statusCode: 404, message: 'Session not found' })
    expect(own).not.toBeInstanceOf(HostReconnectingError)

    state = 'cold'
    const neverDialled = await boundHostRead('devbox', () => Promise.reject(new Error('Unknown host: devbox')), { wouldWait: () => state, label }).catch((e) => e)
    expect(neverDialled).not.toBeInstanceOf(HostReconnectingError)
    expect(neverDialled.message).toBe('Unknown host: devbox')
  })

  it('a read that began disconnected answers a failed dial as reconnecting, whatever state the pool is in after it', async () => {
    // The gate's R1 shape: cold, the read dials, ssh is refused at once, and the
    // pool has no backoff standing yet (a non-standing cause waits as cold).
    const refused = () => markLinkFailure(new Error('Command failed: ssh 127.0.0.1 sh -s\nssh: refused'), 'no-link')
    for (const after of ['cold', 'dialing', 'connected'] as const) {
      let state: 'cold' | 'dialing' | 'connected' = 'cold'
      const err = await boundHostRead('__cloudbox__', async () => { state = after; throw refused() }, { wouldWait: () => state, label }).catch((e) => e)
      expect(err, after).toBeInstanceOf(HostReconnectingError)
      expect(err.message, after).toBe('Reconnecting to Cloud')
      expect(err.statusCode, after).toBe(503)
    }
    // A pool that now fails fast: the plain sentence, never its cause.
    const named = await boundHostRead('__cloudbox__', async () => { throw refused() }, {
      wouldWait: (() => { let n = 0; return () => (n++ === 0 ? 'cold' : 'fails-fast') })(), label, reason: async () => 'ssh to __cloudbox__ was refused',
    }).catch((e) => e)
    expect(named.message).toBe("Can't reach Cloud right now.")
    // A link lost mid-read, or a command the link never answered, is the same answer.
    for (const kind of ['lost', 'no-answer'] as const) {
      const err = await boundHostRead('devbox', () => Promise.reject(markLinkFailure(new Error('connection closed'), kind)), { wouldWait: () => 'cold', label }).catch((e) => e)
      expect(err, kind).toBeInstanceOf(HostReconnectingError)
    }
    // The same text with no link failure behind it keeps its own error.
    const plain = await boundHostRead('devbox', () => Promise.reject(new Error('Command failed: ssh 127.0.0.1 sh -s\nssh: refused')), { wouldWait: () => 'cold', label }).catch((e) => e)
    expect(plain).not.toBeInstanceOf(HostReconnectingError)
  })

  it('a dial already running: answers at once, without starting the read', async () => {
    let started = false
    const t0 = Date.now()
    const err = await boundHostRead('__cloudbox__', async () => { started = true; return 'x' }, { wouldWait: () => 'dialing', capMs: 5_000, label }).catch((e) => e)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(started).toBe(false)
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err).toBeInstanceOf(SessionControlError)
    expect(err).toMatchObject({ message: 'Reconnecting to Cloud', statusCode: 503, extra: { code: HOST_RECONNECTING, host: '__cloudbox__' } })
  })

  it('a cold host: the request starts the dial and waits at most the cap; the dial goes on', async () => {
    let settled = false
    let rejectLate!: (e: Error) => void
    const read = () => new Promise<string>((_resolve, reject) => { rejectLate = (e) => { settled = true; reject(e) } })
    const t0 = Date.now()
    const err = await boundHostRead('devbox', read, { wouldWait: () => 'cold', capMs: 150, label }).catch((e) => e)
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err.message).toBe('Reconnecting to devbox')
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(1_000)
    // The dial ending later (as a failure) is swallowed, not an unhandled rejection.
    rejectLate(new Error('upgrade timed out'))
    await later(20, null)
    expect(settled).toBe(true)
  })

  it('a cold host that answers inside the cap is an ordinary read', async () => {
    expect(await boundHostRead('devbox', () => later(20, 'fast'), { wouldWait: () => 'cold', capMs: 500, label })).toBe('fast')
  })

  it('the bounds: a dial 5s, a progress window 3s, the probe 3s, an answering host with no bytes 20s, a stream 60s, a silent verdict 15s', () => {
    expect(HOST_READ_DIAL_CAP_MS).toBe(5_000)
    expect(HOST_READ_QUIET_MS).toBe(3_000)
    expect(HOST_LIVENESS_PROBE_MS).toBe(3_000)
    expect(HOST_READ_IDLE_MS).toBe(20_000)
    expect(HOST_READ_STREAM_CAP_MS).toBe(60_000)
    expect(HOST_SILENT_MEMO_MS).toBe(15_000)
  })

  it('reads the real pool: a host nothing ever dialled is cold', () => {
    expect(daemonConnectWouldWait('never-dialled-host')).toBe('cold')
  })
})

describe('a command the pool gave up on, on a link that stayed up', () => {
  it("answers in the host's words, a 503 the console handles: never the pool's timeout text", async () => {
    const read = async () => { throw new Error('daemon command timeout: fs.ls (30000ms) [traceId=1a50dfd8]') }
    const err = await boundHostRead('__cloudbox__', read, { wouldWait: () => 'connected', quietMs: 500, label }).catch((e) => e)
    expect(err).toBeInstanceOf(HostReconnectingError)
    expect(err).toMatchObject({ message: 'Cloud did not answer in time', statusCode: 503, extra: { code: HOST_RECONNECTING } })
    // Any other failure of the read is still its own.
    const other = await boundHostRead('__cloudbox__', async () => { throw new Error('EACCES: permission denied') }, { wouldWait: () => 'connected', quietMs: 500, label }).catch((e) => e)
    expect(other).not.toBeInstanceOf(HostReconnectingError)
    expect(other.message).toBe('EACCES: permission denied')
  })
})

describe('boundByProgress: a read that goes on after its request, cut only when it stops arriving', () => {
  it('a read whose host keeps sending outlives the idle span many times over', async () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 10_000 }, 20)
    try {
      const v = await boundByProgress('devbox', later(800, 'whole'), { idleMs: 150, ceilingMs: 10_000, windowMs: 50, message: 'idle', heard: () => bytes })
      expect(v).toBe('whole')
    } finally { clearInterval(feed) }
  })

  it('a host that sends nothing (or only pongs) fails it at the idle span, with the given words', async () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 6 }, 20)
    try {
      const t0 = Date.now()
      const err = await boundByProgress('devbox', later(5_000, 'never'), { idleMs: 300, ceilingMs: 10_000, windowMs: 50, message: 'Session file read timeout (no data for 0.3s)', heard: () => bytes }).catch((e) => e)
      expect(err.message).toBe('Session file read timeout (no data for 0.3s)')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(290)
      expect(Date.now() - t0).toBeLessThan(1_000)
    } finally { clearInterval(feed) }
  })

  it('the ceiling holds even while bytes arrive; a pool that cannot say what it heard makes the idle span a total', async () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 10_000 }, 20)
    try {
      const capped = await boundByProgress('devbox', later(5_000, 'never'), { idleMs: 5_000, ceilingMs: 300, windowMs: 50, message: 'ceiling', heard: () => bytes }).catch((e) => e)
      expect(capped.message).toBe('ceiling')
    } finally { clearInterval(feed) }
    const t0 = Date.now()
    const blind = await boundByProgress('devbox', later(5_000, 'never'), { idleMs: 300, ceilingMs: 10_000, windowMs: 50, message: 'total', heard: () => -1 }).catch((e) => e)
    expect(blind.message).toBe('total')
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('boundSharedHostRead: one read per thing, and a cut read is not wasted', () => {
  const streaming = () => {
    let bytes = 0
    const feed = setInterval(() => { bytes += 10_000 }, 20)
    return { heard: () => bytes, stop: () => clearInterval(feed) }
  }

  it('requests for the same thing at once share ONE read', async () => {
    resetSharedHostReadsForTest()
    let reads = 0
    const read = async () => { reads++; await later(80, null); return 'shared' }
    const deps = { wouldWait: () => 'connected' as const, quietMs: 500, label }
    const [a, b, c] = await Promise.all([
      boundSharedHostRead('devbox', 'file:/a', read, deps),
      boundSharedHostRead('devbox', 'file:/a', read, deps),
      boundSharedHostRead('devbox', 'file:/a', read, deps),
    ])
    expect([a, b, c]).toEqual(['shared', 'shared', 'shared'])
    expect(reads).toBe(1)
    // Another thing, or another host, is another read.
    await boundSharedHostRead('devbox', 'file:/b', read, deps)
    await boundSharedHostRead('otherbox', 'file:/a', read, deps)
    expect(reads).toBe(3)
  })

  it('a read cut by the deadline hands its result to the next request, once; a retry before it ends joins it', async () => {
    resetSharedHostReadsForTest()
    const link = streaming()
    let reads = 0
    const read = async () => { reads++; await later(600, null); return `bytes #${reads}` }
    const deps = { wouldWait: () => 'connected' as const, quietMs: 50, idleMs: 5_000, streamCapMs: 200, heard: link.heard, probe: async () => true, label }
    try {
      const cut = await boundSharedHostRead('devbox', 'file:/big', read, deps).catch((e) => e)
      expect(cut).toBeInstanceOf(HostReconnectingError)
      // A retry while the read still runs joins it (no second read)...
      const retry = await boundSharedHostRead('devbox', 'file:/big', read, { ...deps, streamCapMs: 5_000 })
      expect(retry).toBe('bytes #1')
      expect(reads).toBe(1)
      // ...and having been received, nothing is kept for later.
      expect(await boundSharedHostRead('devbox', 'file:/big', read, { ...deps, streamCapMs: 5_000 })).toBe('bytes #2')

      // Cut, and the read ends before anyone asks again: the next request gets it at once.
      const cut2 = await boundSharedHostRead('devbox', 'file:/big2', read, deps).catch((e) => e)
      expect(cut2).toBeInstanceOf(HostReconnectingError)
      await later(700, null)
      const t0 = Date.now()
      expect(await boundSharedHostRead('devbox', 'file:/big2', read, deps)).toBe('bytes #3')
      expect(Date.now() - t0).toBeLessThan(50)
      expect(reads).toBe(3)
      // Once: the request after that reads again.
      const again = await boundSharedHostRead('devbox', 'file:/big2', read, { ...deps, streamCapMs: 5_000 })
      expect(again).toBe('bytes #4')
    } finally { link.stop() }
  })

  it("a request that joins a read judges it by that read's own commands", async () => {
    resetSharedHostReadsForTest()
    let own = 0
    const feed = setInterval(() => { own += 10_000 }, 20)
    let reads = 0
    const read = async () => { reads++; creditCurrentRead(() => own); await later(700, null); return 'joined' }
    const base = { wouldWait: () => 'connected' as const, quietMs: 50, heard: () => 0, probe: async () => true, label }
    try {
      const cut = await boundSharedHostRead('devbox', 'file:/own', read, { ...base, idleMs: 5_000, streamCapMs: 150 }).catch((e) => e)
      expect(cut).toBeInstanceOf(HostStillLoadingError)
      expect(cut.from).toBe('devbox')
      // The joiner sent no command of its own: the read it joined is still arriving.
      expect(await boundSharedHostRead('devbox', 'file:/own', read, { ...base, idleMs: 200, streamCapMs: 5_000 })).toBe('joined')
      expect(reads).toBe(1)
    } finally { clearInterval(feed) }
  })

  it('kept results are bounded: at most HOST_READ_KEPT_MAX, and one nobody comes back for goes when its time is up', async () => {
    resetSharedHostReadsForTest()
    vi.useFakeTimers()
    try {
      let bytes = 0
      const heard = () => (bytes += 10_000)
      const deps = { wouldWait: () => 'connected' as const, silent: () => false, quietMs: 50, idleMs: 5_000, streamCapMs: 100, heard, probe: async () => true, label }
      const cuts: Array<Promise<unknown>> = []
      for (let i = 0; i < HOST_READ_KEPT_MAX + 4; i++) {
        cuts.push(boundSharedHostRead('devbox', `file:/kept-${i}`, () => later(300, `v${i}`), deps).catch((e) => e))
      }
      await vi.advanceTimersByTimeAsync(200)
      for (const c of await Promise.all(cuts)) expect(c).toBeInstanceOf(HostStillLoadingError)
      // The reads end with nobody waiting: their results are kept, the oldest past the bound go.
      await vi.advanceTimersByTimeAsync(300)
      expect(keptHostReadCount()).toBe(HOST_READ_KEPT_MAX)
      // Nobody came back: each goes when its time is up, with no request to sweep it.
      await vi.advanceTimersByTimeAsync(HOST_READ_RESULT_TTL_MS + 100)
      expect(keptHostReadCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      resetSharedHostReadsForTest()
    }
  })

  it('a kept result past its time is never served, even when its sweep has not run yet', async () => {
    resetSharedHostReadsForTest()
    vi.useFakeTimers()
    try {
      let bytes = 0
      const heard = () => (bytes += 10_000)
      let reads = 0
      const read = () => { reads++; return later(300, `version ${reads}`) }
      const deps = { wouldWait: () => 'connected' as const, silent: () => false, quietMs: 50, idleMs: 5_000, streamCapMs: 100, heard, probe: async () => true, label }
      const cut = boundSharedHostRead('devbox', 'file:/old', read, deps).catch((e) => e)
      await vi.advanceTimersByTimeAsync(200)
      expect(await cut).toBeInstanceOf(HostStillLoadingError)
      await vi.advanceTimersByTimeAsync(300)
      expect(keptHostReadCount()).toBe(1)
      // The Mac slept past the result's time: the clock moved, the sweep timer has not fired.
      vi.setSystemTime(Date.now() + HOST_READ_RESULT_TTL_MS + 1)
      expect(keptHostReadCount()).toBe(1)
      const fresh = boundSharedHostRead('devbox', 'file:/old', read, { ...deps, streamCapMs: 5_000 })
      await vi.advanceTimersByTimeAsync(400)
      expect(await fresh).toBe('version 2')
      expect(reads).toBe(2)
    } finally {
      vi.useRealTimers()
      resetSharedHostReadsForTest()
    }
  })

  it('a save forgets a kept result: the next request reads the new bytes', async () => {
    resetSharedHostReadsForTest()
    const link = streaming()
    let reads = 0
    const read = async () => { reads++; await later(300, null); return `version ${reads}` }
    const deps = { wouldWait: () => 'connected' as const, quietMs: 50, idleMs: 5_000, streamCapMs: 120, heard: link.heard, probe: async () => true, label }
    try {
      expect(await boundSharedHostRead('devbox', 'file:/c', read, deps).catch((e) => e)).toBeInstanceOf(HostReconnectingError)
      await later(400, null)
      forgetSharedHostRead('devbox', 'file:/c')
      expect(await boundSharedHostRead('devbox', 'file:/c', read, { ...deps, streamCapMs: 5_000 })).toBe('version 2')
    } finally { link.stop() }
  })
})

describe('host display name', () => {
  it('a label wins; the cloud box without one is "Cloud"; any other alias is itself', () => {
    expect(hostDisplayName('devbox', 'Dev box')).toBe('Dev box')
    expect(hostDisplayName('devbox', '  ')).toBe('devbox')
    expect(hostDisplayName('__cloudbox__')).toBe('Cloud')
    expect(hostDisplayName('__cloudbox__', 'My cloud')).toBe('My cloud')
  })

  it('a lower layer\'s sentence is put in the host\'s terms, whole mentions only', () => {
    expect(inHostTerms('Connection to __cloudbox__ failed 0s ago: timeout', '__cloudbox__')).toBe('Connection to Cloud failed 0s ago: timeout')
    expect(inHostTerms('Remote read failed (__cloudbox__): DaemonConnection not connected to __cloudbox__', '__cloudbox__'))
      .toBe('Remote read failed (Cloud): DaemonConnection not connected to Cloud')
    // An alias inside a hostname or a path is not a mention of the host.
    expect(inHostTerms('ssh: connect to host box.example.test via /srv/box/x', 'box', 'Build box')).toBe('ssh: connect to host box.example.test via /srv/box/x')
    expect(inHostTerms('Cannot list directory on box: ENOENT', 'box', 'Build box')).toBe('Cannot list directory on Build box: ENOENT')
    expect(inHostTerms('Could not reach box.', 'box', 'Build box')).toBe('Could not reach Build box.')
    expect(inHostTerms('nothing to change', 'devbox')).toBe('nothing to change')
  })
})
