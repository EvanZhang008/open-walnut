/**
 * The claude-cli adapter's process gate under load, on a fake clock: no process
 * is spawned, each turn is a timer of its own length run through the real
 * gate (`_withSlotForTesting`), so the shapes below run in milliseconds and
 * give the same answer every time.
 *
 * The shapes come from the 2026-10-05 gate run. With one slot
 * (WALNUT_CLAUDE_CLI_CONCURRENCY=1), background aging handed every freed slot
 * to an aged backlog: four interactive loops finished 9, 10, 2, 0, 0, 0 turns
 * per 5 s, and random interactive turns waited 65 s at the median. The rules
 * pinned here: interactive turns always keep a slot of their own (aging is off
 * with one slot, and at most one aged background turn runs ahead of them), yet
 * every background turn still runs, in the order it was queued. With one slot
 * a background turn never goes ahead of a queued interactive turn, however
 * long it has waited: it runs when no interactive turn is queued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../../src/model/providers/adapter-claude-cli.js')
type Adapter = InstanceType<Mod['ClaudeCliAdapter']>
type Purpose = 'interactive' | 'background'

async function load(slots: number): Promise<Mod> {
  vi.stubEnv('WALNUT_CLAUDE_CLI_CONCURRENCY', String(slots))
  vi.resetModules()
  const m = await import('../../../src/model/providers/adapter-claude-cli.js')
  vi.unstubAllEnvs()
  expect(m.MAX_CONCURRENT_CLI).toBe(slots)
  return m
}

interface Turn {
  id: string; purpose: Purpose; submit: number; start?: number; end?: number; aborted?: boolean
  /** Gate state seen by the turn as it started (it counts itself). */
  seen?: { interactiveWaiting: number; backgroundInFlight: number }
}

/** Every turn the gate ran, with the invariants a run must keep. */
function recorder(adapter: Adapter) {
  const turns: Turn[] = []
  let running = 0, runningBg = 0, maxRunning = 0, maxBg = 0
  const submit = (id: string, purpose: Purpose, dur: number, signal?: AbortSignal): Promise<void> => {
    const t: Turn = { id, purpose, submit: Date.now() }
    turns.push(t)
    signal?.addEventListener('abort', () => { if (t.start === undefined) t.aborted = true }, { once: true })
    return adapter._withSlotForTesting(purpose, signal, async () => {
      if (signal?.aborted) { t.aborted = true; return }
      const g = adapter._gateStateForTesting()
      t.seen = { interactiveWaiting: g.waiting - g.backgroundWaiting, backgroundInFlight: g.backgroundInFlight }
      t.start = Date.now()
      running++; if (purpose === 'background') runningBg++
      maxRunning = Math.max(maxRunning, running); maxBg = Math.max(maxBg, runningBg)
      await new Promise((r) => setTimeout(r, dur))
      running--; if (purpose === 'background') runningBg--
      t.end = Date.now()
    })
  }
  return { turns, submit, max: () => ({ running: maxRunning, background: maxBg }) }
}

/** Background turns that started while an interactive turn was still queued. */
const wentAhead = (turns: Turn[]): Turn[] =>
  turns.filter((t) => t.purpose === 'background' && t.seen && t.seen.interactiveWaiting > 0)
/** Turns of one purpose that started out of the order they were queued in. */
function outOfOrder(turns: Turn[], purpose: Purpose): string[] {
  const started = turns.filter((t) => t.purpose === purpose && t.start !== undefined)
  const byStart = [...started].sort((a, b) => a.start! - b.start! || turns.indexOf(a) - turns.indexOf(b))
  return byStart.filter((t, i) => t !== started[i]).map((t) => t.id)
}

beforeEach(() => { vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] }) })
afterEach(() => { vi.useRealTimers() })

describe('claude-cli process gate under load (fake clock)', () => {
  it.each([[1], [3]])('%i slot(s): a background backlog under four interactive loops (the gate fuzz A2 shape)', async (slots) => {
    const m = await load(slots)
    const adapter = new m.ClaudeCliAdapter()
    const rec = recorder(adapter)
    const loops = Array.from({ length: 4 }, (_, i) => (async () => {
      for (let k = 0; Date.now() < 30_000; k++) await rec.submit(`i${i}k${k}`, 'interactive', 400)
    })())
    await vi.advanceTimersByTimeAsync(200)
    const bgs = Array.from({ length: 12 }, (_, i) => rec.submit(`b${String(i).padStart(2, '0')}`, 'background', 3000))
    await vi.advanceTimersByTimeAsync(120_000)
    await Promise.all([...loops, ...bgs])

    const interactive = rec.turns.filter((t) => t.purpose === 'interactive')
    const bg = rec.turns.filter((t) => t.purpose === 'background')
    // Interactive turns keep MAX - 1 slots (the only one with one slot) busy the whole time.
    const perWindow = [0, 5, 10, 15, 20, 25].map((w) => interactive.filter((t) => t.end! >= w * 1000 && t.end! < (w + 5) * 1000).length)
    const floor = Math.max(1, slots - 1) * 12 - 1
    expect(perWindow.filter((n) => n < floor), `interactive turns per 5 s: ${perWindow.join(',')}`).toEqual([])
    // Every background turn ran to its end, in the order it was queued.
    expect(bg.every((t) => t.end !== undefined)).toBe(true)
    expect(outOfOrder(rec.turns, 'background')).toEqual([])
    expect(outOfOrder(rec.turns, 'interactive')).toEqual([])
    const ahead = wentAhead(rec.turns)
    if (slots === 1) {
      // With one slot nothing goes ahead of an interactive turn: the backlog waits for the loops to stop.
      expect(ahead.map((t) => t.id)).toEqual([])
      expect(Math.min(...bg.map((t) => t.start!))).toBeGreaterThanOrEqual(30_000)
    } else {
      // The backlog still moves while the loops run: one aged turn at a time, from 10 s on.
      expect(ahead.length).toBeGreaterThan(0)
      expect(ahead.filter((t) => t.seen!.backgroundInFlight !== 1).map((t) => t.id)).toEqual([])
      expect(Math.min(...bg.map((t) => t.start!))).toBeGreaterThanOrEqual(10_200)
      expect(Math.min(...bg.map((t) => t.start!))).toBeLessThan(10_200 + 400)
    }
    expect(rec.max().running).toBeLessThanOrEqual(slots)
    expect(rec.max().background).toBeLessThanOrEqual(Math.max(1, slots - 1))
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: 0, waiting: 0, backgroundInFlight: 0, backgroundWaiting: 0 })
  })

  it.each([[1], [3]])('%i slot(s): random turns with aborts and a 2 s aging (the gate fuzz A3 shape)', async (slots) => {
    const m = await load(slots)
    const adapter = new m.ClaudeCliAdapter({ backgroundMaxWaitMs: 2000 })
    const rec = recorder(adapter)
    let r = 777
    const rnd = (): number => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff }
    const all: Promise<void>[] = []
    const driver = (async () => {
      for (let i = 0; i < 400; i++) {
        await new Promise((res) => setTimeout(res, Math.floor(rnd() * 200)))
        const purpose: Purpose = rnd() < 0.7 ? 'background' : 'interactive'
        const dur = purpose === 'background' ? 50 + Math.floor(rnd() * 600) : 50 + Math.floor(rnd() * 200)
        let signal: AbortSignal | undefined
        if (rnd() < 0.25) {
          const c = new AbortController()
          setTimeout(() => c.abort(), Math.floor(rnd() * 3000))
          signal = c.signal
        }
        all.push(rec.submit(`n${String(i).padStart(3, '0')}`, purpose, dur, signal))
      }
    })()
    await vi.advanceTimersByTimeAsync(600_000)
    await driver
    await Promise.all(all)

    expect(rec.turns).toHaveLength(400)
    // Each turn either ran to its end or left the queue on its abort.
    expect(rec.turns.filter((t) => (t.end !== undefined) === !!t.aborted).map((t) => t.id)).toEqual([])
    expect(outOfOrder(rec.turns, 'background')).toEqual([])
    expect(outOfOrder(rec.turns, 'interactive')).toEqual([])
    expect(rec.max().running).toBeLessThanOrEqual(slots)
    expect(rec.max().background).toBeLessThanOrEqual(Math.max(1, slots - 1))
    const ahead = wentAhead(rec.turns)
    if (slots === 1) expect(ahead.map((t) => t.id)).toEqual([])
    else expect(ahead.filter((t) => t.seen!.backgroundInFlight !== 1).map((t) => t.id)).toEqual([])
    // An interactive turn waits for at most the turns already running plus the
    // interactive ones queued ahead of it, never for the background backlog.
    const waits = rec.turns.filter((t) => t.purpose === 'interactive' && t.start !== undefined).map((t) => t.start! - t.submit)
    expect(Math.max(...waits)).toBeLessThan(slots === 1 ? 2_000 : 1_000)
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: 0, waiting: 0, backgroundInFlight: 0, backgroundWaiting: 0 })
  })

  /** Turns that hold their slot until released by hand. */
  function held(adapter: Adapter) {
    const release = new Map<string, () => void>()
    const order: string[] = []
    const run = (id: string, purpose: Purpose): void => {
      void adapter._withSlotForTesting(purpose, undefined, () => new Promise<void>((res) => { order.push(id); release.set(id, res) }))
    }
    const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    const end = async (id: string): Promise<void> => { release.get(id)!(); await flush() }
    return { run, end, order, flush }
  }

  it('the default aging is 10 s: one ms short, the interactive turn goes first; at 10 s, the background turn', async () => {
    const m = await load(3)
    expect(m.BACKGROUND_MAX_WAIT_MS).toBe(10_000)
    const adapter = new m.ClaudeCliAdapter()
    const h = held(adapter)
    for (const id of ['ia', 'ib', 'ic']) h.run(id, 'interactive')
    h.run('bg', 'background')
    h.run('id', 'interactive')
    await h.flush()
    expect(h.order).toEqual(['ia', 'ib', 'ic'])
    vi.setSystemTime(9_999)
    await h.end('ia')
    expect(h.order.slice(3)).toEqual(['id'])
    h.run('ie', 'interactive')
    vi.setSystemTime(10_000)
    await h.end('ib')
    expect(h.order.slice(4)).toEqual(['bg'])
    expect(adapter._gateStateForTesting()).toMatchObject({ inFlight: 3, waiting: 1, backgroundInFlight: 1 })
    await h.end('ic')
    expect(h.order.slice(5)).toEqual(['ie'])
  })

  it('queued background turns start in the order they were queued', async () => {
    const m = await load(3)
    const adapter = new m.ClaudeCliAdapter()
    const h = held(adapter)
    for (const id of ['ia', 'ib', 'ic']) h.run(id, 'interactive')
    for (const id of ['b1', 'b2', 'b3']) h.run(id, 'background')
    await h.flush()
    await h.end('ia')
    await h.end('ib')
    expect(h.order.slice(3)).toEqual(['b1', 'b2'])
    await h.end('b1')
    expect(h.order.slice(5)).toEqual(['b3'])
  })

  it('one slot: an aged background turn still waits for the queued interactive ones', async () => {
    const m = await load(1)
    const adapter = new m.ClaudeCliAdapter({ backgroundMaxWaitMs: 0 })
    const h = held(adapter)
    h.run('b1', 'background')
    h.run('b2', 'background')
    h.run('ia', 'interactive')
    h.run('ib', 'interactive')
    await h.flush()
    vi.setSystemTime(60_000)
    await h.end('b1')
    await h.end('ia')
    await h.end('ib')
    expect(h.order).toEqual(['b1', 'ia', 'ib', 'b2'])
  })

  it('one slot: a background turn queued for a week still waits for every queued interactive turn', async () => {
    // Default options: no aging of any length applies with one slot.
    const m = await load(1)
    const adapter = new m.ClaudeCliAdapter()
    const h = held(adapter)
    h.run('ia', 'interactive')
    h.run('bg', 'background')
    h.run('ib', 'interactive')
    await h.flush()
    vi.setSystemTime(7 * 24 * 3_600_000)
    await h.end('ia')
    expect(h.order).toEqual(['ia', 'ib'])
    h.run('ic', 'interactive')
    await h.end('ib')
    expect(h.order).toEqual(['ia', 'ib', 'ic'])
    // Nobody queued ahead of it any more: the background turn runs next.
    await h.end('ic')
    expect(h.order).toEqual(['ia', 'ib', 'ic', 'bg'])
    await h.end('bg')
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: 0, waiting: 0, backgroundInFlight: 0, backgroundWaiting: 0 })
  })

  it('one slot: a steady interactive stream holds the backlog until it stops, then every background turn runs in order', async () => {
    const m = await load(1)
    const adapter = new m.ClaudeCliAdapter()
    const rec = recorder(adapter)
    const loops = Array.from({ length: 4 }, (_, i) => (async () => {
      for (let k = 0; Date.now() < 200_000; k++) await rec.submit(`i${i}k${k}`, 'interactive', 400)
    })())
    await vi.advanceTimersByTimeAsync(200)
    const bgs = Array.from({ length: 12 }, (_, i) => rec.submit(`b${String(i).padStart(2, '0')}`, 'background', 3000))
    await vi.advanceTimersByTimeAsync(300_000)
    await Promise.all([...loops, ...bgs])

    const bg = rec.turns.filter((t) => t.purpose === 'background')
    expect(wentAhead(rec.turns).map((t) => t.id)).toEqual([])
    expect(Math.min(...bg.map((t) => t.start!))).toBeGreaterThanOrEqual(200_000)
    expect(bg.every((t) => t.end !== undefined)).toBe(true)
    expect(outOfOrder(rec.turns, 'background')).toEqual([])
    // An interactive turn waits only for the interactive turns ahead of it.
    const waits = rec.turns.filter((t) => t.purpose === 'interactive').map((t) => t.start! - t.submit)
    expect(Math.max(...waits)).toBeLessThanOrEqual(3 * 400)
    expect(rec.max().running).toBe(1)
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: 0, waiting: 0, backgroundInFlight: 0, backgroundWaiting: 0 })
  })

  it.each([[2], [3]])('%i slots: a freed slot goes to the queued interactive turn while background turns hold all theirs', async (slots) => {
    // The slot an interactive turn frees is the one background turns may not
    // take: checking it against the background cap (G07 in the 2026-10-07
    // gate) left it idle and raised the gate sim's interactive p50 from 24.7 s
    // to 89.8 s with two slots.
    const m = await load(slots)
    const adapter = new m.ClaudeCliAdapter()
    const h = held(adapter)
    const bgs = Array.from({ length: slots - 1 }, (_, i) => `b${i + 1}`)
    for (const id of bgs) h.run(id, 'background')
    h.run('ia', 'interactive')
    h.run('ib', 'interactive')
    await h.flush()
    expect(h.order).toEqual([...bgs, 'ia'])
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: slots, waiting: 1, backgroundInFlight: slots - 1, backgroundWaiting: 0 })
    await h.end('ia')
    expect(h.order).toEqual([...bgs, 'ia', 'ib'])
    expect(adapter._gateStateForTesting()).toEqual({ inFlight: slots, waiting: 0, backgroundInFlight: slots - 1, backgroundWaiting: 0 })
  })
})
