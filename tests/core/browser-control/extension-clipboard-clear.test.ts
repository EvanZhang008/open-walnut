/**
 * The background's clipboard clear (bg-clipboard.ts) on a busy machine: a copied code or
 * password is cleared 30 s after the LAST copy, a read the offscreen page misses is tried again,
 * a wake before it is due waits for the due time, and a worker started after it was due clears
 * at once. Chrome's API is faked: storage.session in memory, the offscreen page as a clipboard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../../packages/browser-extension/src/bg-clipboard')

interface Fake {
  board: string
  session: Record<string, unknown>
  failReads: number
  reads: number
  alarms: Array<(a: { name: string }) => void>
}

function install(f: Fake): void {
  const area = {
    get: async (k: string) => (k in f.session ? { [k]: f.session[k] } : {}),
    set: async (o: Record<string, unknown>) => { Object.assign(f.session, structuredClone(o)) },
    remove: async (k: string) => { delete f.session[k] },
  }
  ;(globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: 'ext',
      getURL: (p: string) => `chrome-extension://ext/${p}`,
      sendMessage: async (m: { op: string; text?: string }) => {
        if (m.op === 'write') { f.board = m.text ?? ''; return { ok: true } }
        f.reads++
        if (f.failReads > 0) { f.failReads--; throw new Error('Could not establish connection. Receiving end does not exist.') }
        return { ok: true, text: f.board }
      },
    },
    storage: { session: area, local: area },
    alarms: { create: async () => undefined, onAlarm: { addListener: (l: (a: { name: string }) => void) => { f.alarms.push(l) } } },
    offscreen: { hasDocument: async () => true, createDocument: async () => undefined },
  }
}

/** The worker is stopped: its timers are gone (clearAllTimers also resets the fake clock, so it is put back). */
function stopWorker(): void {
  const t = Date.now()
  vi.clearAllTimers()
  vi.setSystemTime(t)
}

async function load(f: Fake): Promise<Mod> {
  vi.resetModules()
  install(f)
  const m = await import('../../../packages/browser-extension/src/bg-clipboard')
  m.initClipboard()
  return m
}

let f: Fake
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  f = { board: '', session: {}, failReads: 0, reads: 0, alarms: [] }
})
afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).chrome
})

describe('the background clears what it copied', () => {
  it('clears a copied code 30 s later', async () => {
    const m = await load(f)
    expect(await m.copyText('123456')).toBe(true)
    expect(f.board).toBe('123456')
    await vi.advanceTimersByTimeAsync(29_000)
    expect(f.board).toBe('123456')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(f.board).toBe('')
  })

  it('a read the offscreen page misses is tried again, so the code is still cleared', async () => {
    const m = await load(f)
    await m.copyText('123456')
    f.failReads = 2
    await vi.advanceTimersByTimeAsync(30_200 + 2_500)
    expect(f.reads).toBe(3)
    expect(f.board).toBe('')
  })

  it('leaves what the person copied since', async () => {
    const m = await load(f)
    await m.copyText('123456')
    f.board = 'my own text'
    await vi.advanceTimersByTimeAsync(31_000)
    expect(f.board).toBe('my own text')
  })

  it('an alarm before the clear is due waits for the due time, even when the worker restarted', async () => {
    let m = await load(f)
    await m.copyText('123456')
    await vi.advanceTimersByTimeAsync(10_000)
    // A second copy of the same code moves the clear to 30 s after it.
    await m.clearLater('123456')
    // The worker is stopped (its timers are gone) and started by the first copy's alarm.
    stopWorker()
    f.alarms = []
    m = await load(f)
    await vi.advanceTimersByTimeAsync(20_100)
    for (const a of f.alarms) a({ name: 'walnut-clear-clipboard' })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.board).toBe('123456')
    await vi.advanceTimersByTimeAsync(10_500)
    expect(f.board).toBe('')
  })

  it('a worker started after the clear was due clears at once', async () => {
    const m = await load(f)
    await m.copyText('123456')
    stopWorker()
    vi.setSystemTime(Date.now() + 45_000)
    await load(f)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.board).toBe('')
  })
})
