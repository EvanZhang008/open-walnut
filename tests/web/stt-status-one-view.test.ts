/**
 * Every mic in one view says the same thing about voice (2026-11-10: in the
 * full-screen review column one reply box's mic said "Voice input" and the
 * other three "Set up dictation"). Two ways they parted:
 *   1. a mic mounted after the shared read went stale showed "loading" (its
 *      label "Voice input") while the others showed the last read;
 *   2. a read one mic made reached only that mic; the others kept their copy
 *      until their own re-check.
 * Real React over linkedom (same technique as composer-model-pill-open-request).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const fetchSttStatus = vi.fn()
vi.mock('@/api/stt', () => ({ fetchSttStatus: () => fetchSttStatus() }))
vi.mock('@/utils/page-visibility', () => ({ visibleInterval: () => () => {} }))

const mod = await import('../../web/src/hooks/useSttStatus.js')

type Seen = { isLoading: boolean; isConfigured: boolean }
const seen = new Map<string, Seen>()
function Mic({ id }: { id: string }) {
  const s = mod.useSttStatus()
  seen.set(id, { isLoading: s.isLoading, isConfigured: s.isConfigured })
  return null
}

let doc: Document
const roots: Array<{ render: (el: unknown) => void; unmount: () => void }> = []

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})

beforeEach(() => { fetchSttStatus.mockReset(); mod.invalidateSttStatusCache(); seen.clear() })
afterEach(async () => {
  await act(async () => { for (const r of roots.splice(0)) r.unmount() })
  vi.useRealTimers()
})

async function mount(id: string) {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host as unknown as Element) as unknown as (typeof roots)[number]
  roots.push(root)
  await act(async () => { root.render(createElement(Mic, { id })) })
}

const NONE = { engine: null, available: false, error: 'No STT engine configured' }
const GOOD = { engine: 'mlx', available: true }

describe('one view, one voice status', () => {
  it('a mic mounted while the read is stale shows the last read, and the new read reaches every mic', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
    fetchSttStatus.mockResolvedValueOnce(NONE)
    await mount('a')
    expect(seen.get('a')).toEqual({ isLoading: false, isConfigured: false })

    // Past the shared read's life: the next mic reads again, slowly.
    vi.setSystemTime(new Date('2026-11-10T00:02:00Z'))
    let answer: (v: unknown) => void = () => {}
    fetchSttStatus.mockReturnValueOnce(new Promise((r) => { answer = r }))
    await mount('b')
    expect(seen.get('b'), 'the late mic shows what the others show').toEqual(seen.get('a'))

    await act(async () => { answer(GOOD) })
    expect(seen.get('a'), 'the earlier mic gets the new read too').toEqual({ isLoading: false, isConfigured: true })
    expect(seen.get('b')).toEqual({ isLoading: false, isConfigured: true })
  })
})
