import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let win: EventTarget
let frames: FrameRequestCallback[]
beforeEach(() => {
  vi.resetModules()
  frames = []
  win = Object.assign(new EventTarget(), { requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => frames.push(callback)) })
  vi.stubGlobal('window', win)
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const load = () => import('../../web/src/api/read-lifecycle')
const edge = (name: string) => win.dispatchEvent(new Event(name))

describe('read lifecycle', () => {
  it('holds the original read until a cancelled navigation renders again', async () => {
    const { readsSuspended, waitForReadablePage } = await load()
    edge('beforeunload')
    const settled = vi.fn()
    const read = waitForReadablePage().then(settled)
    await Promise.resolve()
    expect(readsSuspended()).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    frames[0](0)
    await read
    expect(readsSuspended()).toBe(false)
    expect(settled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores previous navigation frames and every frame after pagehide until pageshow', async () => {
    const { readsSuspended, waitForReadablePage } = await load()
    edge('beforeunload'); edge('beforeunload')
    frames[0](0)
    expect(readsSuspended()).toBe(true)
    frames[1](0)
    expect(readsSuspended()).toBe(false)
    edge('beforeunload'); edge('pagehide')
    const read = waitForReadablePage()
    frames[2](0)
    expect(readsSuspended()).toBe(true)
    edge('pageshow')
    await read
    expect(readsSuspended()).toBe(false)
  })

  it('keeps hidden documents readable and removes aborted waiters and timers', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    vi.stubGlobal('document', doc)
    const { readsSuspended, waitForReadablePage } = await load()
    doc.dispatchEvent(new Event('visibilitychange'))
    await waitForReadablePage()
    expect(readsSuspended()).toBe(false)
    edge('beforeunload')
    const controller = new AbortController()
    const reason = new DOMException('Read cancelled', 'AbortError')
    const read = waitForReadablePage(controller.signal).catch(error => error)
    controller.abort(reason)
    expect(await read).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
    await expect(waitForReadablePage(controller.signal)).rejects.toBe(reason)
    edge('pageshow')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an expired read when pageshow runs before its frozen timeout', async () => {
    const { waitForReadablePage } = await load()
    edge('pagehide')
    const read = waitForReadablePage().catch(error => error)
    vi.setSystemTime(Date.now() + 20_001)
    edge('pageshow')
    expect(await read).toMatchObject({ name: 'TimeoutError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never extends the absolute 20-second deadline through two navigation attempts', async () => {
    const { waitForReadablePage } = await load()
    const deadline = Date.now() + 20_000
    edge('beforeunload')
    const read = waitForReadablePage(undefined, deadline).catch(error => error)
    await vi.advanceTimersByTimeAsync(8_000)
    edge('beforeunload')
    frames[0](0)
    await vi.advanceTimersByTimeAsync(11_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toMatchObject({ name: 'TimeoutError', message: 'Request waited 20000ms while the page was suspended' })
    expect(vi.getTimerCount()).toBe(0)
    edge('pageshow')
    await waitForReadablePage()
  })
})
