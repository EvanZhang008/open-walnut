/**
 * A request the page's own exit cut (a reload, a navigation) is not an error:
 * 2026-10-30, every reload in a browser test logged "[api] GET … JSON parse
 * failed … TypeError: Failed to fetch" for a body the browser cancelled. The same
 * failure while the page stays is still logged as one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let win: EventTarget
let errors: unknown[][]

async function loadClient() {
  vi.resetModules()
  return import('../../web/src/api/client')
}

beforeEach(() => {
  win = new EventTarget()
  vi.stubGlobal('window', win)
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** A 200 whose body read fails the way a cancelled load does. */
function cutBody(): Response {
  const res = new Response('{}', { status: 200 })
  Object.defineProperty(res, 'text', { value: () => Promise.reject(new TypeError('Failed to fetch')) })
  return res
}

describe('requests cut by the page leaving', () => {
  it('a body read the reload cut rejects without an error log', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => cutBody()))
    win.dispatchEvent(new Event('pagehide'))
    await expect(apiGet('/api/sessions/s1/supervision')).rejects.toBeInstanceOf(TypeError)
    expect(errors).toEqual([])
  })

  it('a fetch the reload cut rejects without an error log', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    win.dispatchEvent(new Event('pagehide'))
    await expect(apiGet('/api/tasks')).rejects.toBeInstanceOf(TypeError)
    expect(errors).toEqual([])
  })

  it('the same failures while the page stays are logged, and a back-forward restore counts as staying', async () => {
    const { apiGet } = await loadClient()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(apiGet('/api/tasks')).rejects.toBeInstanceOf(TypeError)
    win.dispatchEvent(new Event('pagehide'))
    win.dispatchEvent(new Event('pageshow'))
    vi.stubGlobal('fetch', vi.fn(async () => cutBody()))
    await expect(apiGet('/api/sessions/s1/supervision')).rejects.toBeDefined()
    expect(errors.map((e) => String(e[0]))).toEqual([
      expect.stringContaining('GET /api/tasks FAILED'),
      expect.stringContaining('JSON parse failed'),
      expect.stringContaining('JSON parse failed'),
    ])
  })
})
