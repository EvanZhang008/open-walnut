/**
 * With experiment `focus_workspace` off, no page asks /api/v1/focus-spaces
 * (web/src/focus-spaces/focus-store.ts). 2026-11-22: every page asked it, the route's 404 showed
 * in the console as a failed request, and every browser spec that checks the console failed.
 * Switched on, the store reads the route; switched off again, it shows none without asking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  gets: [] as string[],
  handlers: new Map<string, (data: unknown) => void>(),
}))

vi.mock('../../web/src/api/config', () => ({
  fetchConfig: async () => ({ experimental: { ...h.flags } }),
  fetchFreshConfig: async () => ({ experimental: { ...h.flags } }),
}))
vi.mock('../../web/src/api/client', () => ({
  apiGet: async (path: string) => {
    h.gets.push(path)
    return { spaces: [{ id: 's1', name: 'Walnut', projects: ['Walnut'], tasks: [], apps: {}, createdAt: 1, updatedAt: 1 }], active: null, apps: [] }
  },
  apiPost: vi.fn(), apiPatch: vi.fn(), apiPut: vi.fn(), apiDelete: vi.fn(),
}))
vi.mock('../../web/src/api/ws', () => ({
  wsClient: { onEvent: (name: string, cb: (data: unknown) => void) => { h.handlers.set(name, cb); return () => {} } },
}))
vi.mock('../../web/src/api/test-run', () => ({ testRunLabel: () => null }))

import { loadFocus, focusSnapshot, _resetFocusStoreForTest } from '../../web/src/focus-spaces/focus-store'

beforeEach(() => {
  h.flags = {}
  h.gets.length = 0
  _resetFocusStoreForTest()
})

describe('focus store with the experiment off', () => {
  it('asks nothing and shows no focus', async () => {
    await loadFocus()
    expect(h.gets).toEqual([])
    expect(focusSnapshot()).toMatchObject({ loaded: true, spaces: [], active: null })
  })

  it('reads the route once switched on, and drops it again once off', async () => {
    h.flags = { focus_workspace: true }
    await loadFocus({ freshConfig: true })
    expect(h.gets).toEqual(['/api/v1/focus-spaces'])
    expect(focusSnapshot().spaces).toHaveLength(1)

    h.flags = {}
    await loadFocus({ freshConfig: true })
    expect(h.gets).toHaveLength(1)
    expect(focusSnapshot().spaces).toEqual([])
  })

  it('"every experiment on" counts as on', async () => {
    h.flags = { every_experiment: true }
    await loadFocus()
    expect(h.gets).toEqual(['/api/v1/focus-spaces'])
  })
})
