/**
 * Which hosts the "connecting in the background" card shows (web/src/components/hosts/
 * background-connect.ts) and its words (2026-11-13, the user: "make it clear, close & run
 * background that make it clear that it will still running ... collapse into an always on
 * notification"). A host's FIRST connect shows, an established host's reconnect never does; a
 * connected host reads "is connected" for a moment and goes; a failure lets the host go.
 */
import { describe, expect, it } from 'vitest'
import type { HostStatus } from '@/api/hosts'
import { stepsFromPhase } from '@/utils/host-connect'
import {
  ASKED_TTL_MS, CONNECTED_HOLD_MS, EMPTY_MEMORY, pillParts, pillText, stepBackgroundConnects, withAsked,
  type BackgroundConnectMemory, type BackgroundConnectRow,
} from '@/components/hosts/background-connect'

const MB = 1_048_576
const T0 = 1_800_000_000_000

function status(host: string, phase: HostStatus['phase'], over: Partial<HostStatus> = {}): HostStatus {
  return {
    host, label: host, hostname: `${host}.example.test`, connected: phase === 'connected', phase,
    phaseLabel: phase === 'connected' ? '' : `Working on ${host}`, steps: stepsFromPhase(phase),
    phaseElapsedMs: 0, connectElapsedMs: 0, at: T0, ...over,
  }
}
const first = (host: string, phase: HostStatus['phase'] = 'install-runtime', over: Partial<HostStatus> = {}) => status(host, phase, { firstConnect: true, ...over })
const uploading = (host: string, done: number, total: number, over: Partial<HostStatus> = {}) => first(host, 'upload', {
  steps: stepsFromPhase('upload').map((s) => (s.status === 'active' ? { ...s, progress: { via: 'upload' as const, done, total } } : s)),
  ...over,
})
const failed = (host: string, at = T0) => status(host, 'failed', { error: 'ssh: connect to host build-box port 22: Connection refused', at })

/** Several looks in a row, each over the memory the one before left. */
function run(steps: Array<{ statuses: HostStatus[]; now: number; ask?: string[]; askedOver?: HostStatus }>, start: BackgroundConnectMemory = EMPTY_MEMORY) {
  let memory = start
  let rows: BackgroundConnectRow[] = []
  let wakeAt: number | undefined
  for (const s of steps) {
    // `askedOver`: the status the store held when the Add / Try again was pressed.
    for (const h of s.ask ?? []) memory = withAsked(memory, h, s.now, s.askedOver?.host === h ? s.askedOver.at : undefined)
    const r = stepBackgroundConnects(memory, s.statuses, s.now)
    memory = r.memory
    rows = r.rows
    wakeAt = r.wakeAt
  }
  return { memory, rows, wakeAt }
}
const shown = (rows: BackgroundConnectRow[]) => rows.map((r) => `${r.host}:${r.state}`)

describe('which hosts the background card lists', () => {
  it('a first connect the server flags shows; an established host reconnecting does not', () => {
    const { rows } = run([{ now: T0, statuses: [first('build-box'), status('old-box', 'ssh'), status('old-box-2', 'reconnecting', { reconnectSince: T0 - 5_000 })] }])
    expect(shown(rows)).toEqual(['build-box:connecting'])
  })

  it('a host added here shows while it connects, before the server flags it (its probe, its turn in the queue)', () => {
    const { rows } = run([{ now: T0, ask: ['lab'], statuses: [status('lab', 'queued')] }])
    expect(shown(rows)).toEqual(['lab:connecting'])
  })

  it('a host added here that connects at once, fails at once, or never starts is forgotten', () => {
    const r = run([{ now: T0, ask: ['a', 'b', 'c'], statuses: [] }, { now: T0 + 10, statuses: [status('a', 'connected', { at: T0 + 5 }), failed('b', T0 + 5)] }])
    expect(r.rows).toEqual([])
    expect(Object.keys(r.memory.asked)).toEqual(['c'])
    const later = run([{ now: T0 + ASKED_TTL_MS + 1, statuses: [] }], r.memory)
    expect(later.memory.asked).toEqual({})
  })

  it('the frame a Try again was pressed over (its failure) is not read as the new attempt ending', () => {
    const before = failed('lab', T0)
    const r = run([{ now: T0 + 100, ask: ['lab'], askedOver: before, statuses: [before] }, { now: T0 + 200, statuses: [before] }])
    expect(Object.keys(r.memory.asked)).toEqual(['lab'])
    const next = run([{ now: T0 + 300, statuses: [status('lab', 'ssh', { at: T0 + 250 })] }], r.memory)
    expect(shown(next.rows)).toEqual(['lab:connecting'])
  })

  it('connected: "is connected" for the hold, then the row goes', () => {
    const r = run([{ now: T0, statuses: [first('build-box')] }, { now: T0 + 1_000, statuses: [status('build-box', 'connected')] }])
    expect(shown(r.rows)).toEqual(['build-box:connected'])
    expect(r.wakeAt).toBe(T0 + 1_000 + CONNECTED_HOLD_MS)
    const still = run([{ now: T0 + 1_000 + CONNECTED_HOLD_MS - 1, statuses: [status('build-box', 'connected')] }], r.memory)
    expect(shown(still.rows)).toEqual(['build-box:connected'])
    const gone = run([{ now: T0 + 1_000 + CONNECTED_HOLD_MS, statuses: [status('build-box', 'connected')] }], r.memory)
    expect(gone.rows).toEqual([])
    expect(gone.memory.following).toEqual({})
  })

  it('a failure drops the row at once; the failed attempt never brings it back, a new attempt does', () => {
    // The server stamps every attempt (attemptStartedAt): the failed one began at T0.
    const attempt1 = { attemptStartedAt: T0 }
    const r = run([{ now: T0, statuses: [first('build-box', 'install-runtime', attempt1)] }, { now: T0 + 1, statuses: [status('build-box', 'failed', { ...attempt1, error: 'Connection refused', at: T0 + 1 })] }])
    expect(r.rows).toEqual([])
    expect(r.memory.dropped).toEqual({ 'build-box': T0 })
    // Still that attempt: its failure again, the reconnect loop's pause after it, a Retry's reset to idle.
    const same = run([
      { now: T0 + 2, statuses: [status('build-box', 'failed', { ...attempt1, error: 'Connection refused', at: T0 + 2 })] },
      { now: T0 + 3, statuses: [first('build-box', 'reconnecting', { ...attempt1, lastError: 'Connection refused', at: T0 + 3 })] },
      { now: T0 + 4, statuses: [status('build-box', 'idle', { ...attempt1, at: T0 + 4 })] },
    ], r.memory)
    expect(same.rows).toEqual([])
    expect(same.memory.dropped).toEqual({ 'build-box': T0 })
    // A new attempt (a retry from Settings or Notifications, Try again, the server's own): shown again.
    const retry = run([{ now: T0 + 10, statuses: [first('build-box', 'ssh', { attemptStartedAt: T0 + 9, at: T0 + 10 })] }], same.memory)
    expect(shown(retry.rows)).toEqual(['build-box:connecting'])
    expect(retry.memory.dropped).toEqual({})
    // And that one failing again drops it again, by its own attempt.
    const again = run([{ now: T0 + 20, statuses: [status('build-box', 'failed', { attemptStartedAt: T0 + 9, error: 'Connection refused', at: T0 + 20 })] }], retry.memory)
    expect(again.rows).toEqual([])
    expect(again.memory.dropped).toEqual({ 'build-box': T0 + 9 })
  })

  it('a status with no attempt stamp (an older server): the next frame that connects is the new attempt', () => {
    const r = run([{ now: T0, statuses: [first('build-box')] }, { now: T0 + 1, statuses: [failed('build-box', T0 + 1)] }])
    expect(r.memory.dropped).toEqual({ 'build-box': T0 + 1 })
    const retry = run([{ now: T0 + 2, statuses: [first('build-box', 'ssh', { at: T0 + 2 })] }], r.memory)
    expect(shown(retry.rows)).toEqual(['build-box:connecting'])
  })

  it('a switched-off host: the retry loop\'s dials never bring its row back, however many', () => {
    const r = run([{ now: T0, statuses: [first('build-box', 'install-runtime', { attemptStartedAt: T0 })] }, { now: T0 + 1, statuses: [status('build-box', 'failed', { attemptStartedAt: T0, error: 'Connection timed out', at: T0 + 1 })] }])
    expect(r.rows).toEqual([])
    // Every few minutes a dial of the loop walks ssh and probe, each a new attempt, each carrying
    // the loop's last failure or its start (host-status.ts); between them the loop waits.
    let memory = r.memory
    for (let i = 1; i <= 5; i++) {
      const t = T0 + i * 180_000
      for (const frame of [
        first('build-box', 'ssh', { attemptStartedAt: t, lastError: 'Connection timed out', at: t }),
        first('build-box', 'probe', { attemptStartedAt: t, reconnectSince: T0, at: t + 1 }),
        first('build-box', 'reconnecting', { attemptStartedAt: t, lastError: 'Connection timed out', at: t + 2 }),
      ]) {
        const step = run([{ now: frame.at, statuses: [frame] }], memory)
        expect(step.rows, `dial ${i} ${frame.phase}`).toEqual([])
        memory = step.memory
      }
    }
    expect(Object.keys(memory.dropped)).toEqual(['build-box'])
  })

  it('a person\'s retry brings it back, even over the loop\'s marks, and the loop\'s marks do not end that attempt', () => {
    const r = run([{ now: T0, statuses: [first('build-box', 'install-runtime', { attemptStartedAt: T0 })] }, { now: T0 + 1, statuses: [status('build-box', 'failed', { attemptStartedAt: T0, error: 'Connection timed out', at: T0 + 1 })] }])
    const before = status('build-box', 'failed', { attemptStartedAt: T0, error: 'Connection timed out', at: T0 + 1 })
    const retry = run([
      { now: T0 + 10, ask: ['build-box'], askedOver: before, statuses: [before] },
      { now: T0 + 11, statuses: [first('build-box', 'ssh', { attemptStartedAt: T0 + 11, lastError: 'Connection timed out', at: T0 + 11 })] },
    ], r.memory)
    expect(shown(retry.rows)).toEqual(['build-box:connecting'])
    expect(retry.memory.dropped).toEqual({})
    const later = run([{ now: T0 + 12, statuses: [first('build-box', 'upload', { attemptStartedAt: T0 + 11, reconnectSince: T0, at: T0 + 12 })] }], retry.memory)
    expect(shown(later.rows)).toEqual(['build-box:connecting'])
  })

  it('a host the card follows that the retry loop takes over (no ask here) goes', () => {
    const r = run([{ now: T0, statuses: [first('build-box', 'install-runtime', { attemptStartedAt: T0 })] }, { now: T0 + 1, statuses: [first('build-box', 'ssh', { attemptStartedAt: T0 + 1, lastError: 'Connection refused', at: T0 + 1 })] }])
    expect(r.rows).toEqual([])
    expect(r.memory.dropped).toEqual({ 'build-box': T0 + 1 })
  })

  it('after a reload the card never picks up a dial of the retry loop, only a first connect in flight', () => {
    const loop = run([{ now: T0, statuses: [first('build-box', 'ssh', { lastError: 'Connection timed out' }), first('lab-box', 'probe', { reconnectSince: T0 - 60_000 })] }])
    expect(loop.rows).toEqual([])
    const real = run([{ now: T0, statuses: [first('build-box', 'upload')] }])
    expect(shown(real.rows)).toEqual(['build-box:connecting'])
  })

  it('a host removed from the config, or connected then dropping within the hold, goes', () => {
    const r = run([{ now: T0, statuses: [first('a'), first('b')] }, { now: T0 + 1, statuses: [status('b', 'connected')] }, { now: T0 + 2, statuses: [status('b', 'reconnecting')] }])
    expect(r.rows).toEqual([])
    expect(r.memory.following).toEqual({})
  })

  it('keeps the same memory object when nothing changed (the card commits it without looping)', () => {
    const r = run([{ now: T0, statuses: [first('build-box')] }])
    expect(stepBackgroundConnects(r.memory, [first('build-box')], T0 + 5).memory).toBe(r.memory)
    expect(stepBackgroundConnects(EMPTY_MEMORY, [status('old-box', 'ssh')], T0).memory).toBe(EMPTY_MEMORY)
  })

  it('rows keep the order the hosts were first followed in', () => {
    const r = run([{ now: T0, statuses: [first('b')] }, { now: T0 + 1, statuses: [first('a'), first('b')] }, { now: T0 + 2, statuses: [first('a'), status('b', 'connected')] }])
    expect(shown(r.rows)).toEqual(['b:connected', 'a:connecting'])
  })
})

describe('the bar and the minimized line', () => {
  it('the bar is the bytes while the daemon file goes onto the host, else the steps done', () => {
    const bytes = run([{ now: T0, statuses: [uploading('build-box', 23 * MB, 67 * MB)] }]).rows[0]!
    expect(bytes.percent).toBe(34)
    expect(bytes.valueText).toBe('23 of 67 MB sent')
    const steps = run([{ now: T0, statuses: [first('build-box', 'install-runtime')] }]).rows[0]!
    expect(steps.percent).toBeCloseTo((2 / 7) * 100)
    expect(steps.valueText).toBe('2 of 7 steps complete')
    expect(steps.stepWords).toBe('Working on build-box')
  })

  it('one host: "Connecting to <name> · 34%", the name the person knows it by', () => {
    const rows = run([{ now: T0, statuses: [uploading('build-box', 23 * MB, 67 * MB, { label: 'Build box' })] }]).rows
    expect(pillText(rows)).toBe('Connecting to Build box · 34%')
    expect(pillParts(rows)).toEqual({ words: 'Connecting to Build box', percent: 34 })
  })

  it('several: how many, and their average; a host done is no longer counted', () => {
    const rows = run([{ now: T0, statuses: [uploading('a', 20 * MB, 100 * MB), uploading('b', 60 * MB, 100 * MB)] }]).rows
    expect(pillText(rows)).toBe('Connecting to 2 machines · 40%')
    const one = run([{ now: T0, statuses: [uploading('a', 20 * MB, 100 * MB), uploading('b', 60 * MB, 100 * MB)] }, { now: T0 + 1, statuses: [uploading('a', 20 * MB, 100 * MB), status('b', 'connected')] }]).rows
    expect(pillText(one)).toBe('Connecting to a · 20%')
  })

  it('no measured percent says none; only connected hosts say so', () => {
    // A download whose size the host did not say: the bar sweeps, the line has no number.
    const unsized = run([{ now: T0, statuses: [uploading('lab', 5 * MB, 0)] }]).rows
    expect(unsized[0]!.percent).toBeUndefined()
    expect(pillText(unsized)).toBe('Connecting to lab')
    const done = run([{ now: T0, statuses: [first('lab')] }, { now: T0 + 1, statuses: [status('lab', 'connected')] }]).rows
    expect(pillText(done)).toBe('lab is connected')
  })
})
