/**
 * `/model` opens the composer model pill's picker through a counter
 * (SessionPanel's `modelPickerRequest` → the pill's `openNonce`).
 *
 * SessionPanel mounts the pill only once the session record has loaded, and the
 * composer takes `/model` before that (it renders while the header still says
 * "Loading..."). The pill used to count the value it mounted with as already
 * served, so a `/model` picked during the load was dropped: the palette closed,
 * the input cleared, and no picker ever opened (a cold Playwright run, 4 tests at
 * once, 2026-10-03). The caller now keeps the last served value, so:
 *   1. a request made before the pill mounts opens the picker once it mounts;
 *   2. a pill that remounts after serving a request does not reopen it;
 *   3. a re-render with the same value does not reopen it;
 *   4. a new request after that opens it again.
 * Real React over linkedom (same technique as task-move-stale-list).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

// The provider module pulls in the markdown renderer, whose DOMPurify hook needs a
// real window at import time; the hook under test never notifies.
vi.mock('@/contexts/notifications', () => ({ useNotifications: () => ({ notify: () => {} }) }))

const { useOpenRequest } = await import('../../web/src/components/sessions/ComposerModelPill')

let opens = 0
function Probe({ nonce, served }: { nonce: number | undefined; served?: { current: number } }) {
  useOpenRequest(nonce, served, openCounter)
  return null
}
function openCounter() { opens++ }

let doc: Document
let root: { render: (el: unknown) => void; unmount: () => void } | null = null

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  opens = 0
})

async function render(props: { nonce: number | undefined; served?: { current: number } }) {
  if (!root) {
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    root = createRoot(host as unknown as Element) as unknown as typeof root
  }
  await act(async () => { root!.render(createElement(Probe, props)) })
}

async function unmount() {
  await act(async () => { root?.unmount() })
  root = null
}

describe('the /model open request', () => {
  it('opens a picker for a request made before the pill mounted', async () => {
    const served = { current: 0 }
    // `/model` was picked while the record loaded: the counter is already 1.
    await render({ nonce: 1, served })
    expect(opens).toBe(1)
    expect(served.current).toBe(1)
  })

  it('does not reopen a served request on a remount or a re-render', async () => {
    const served = { current: 0 }
    await render({ nonce: 1, served })
    expect(opens).toBe(1)
    await render({ nonce: 1, served })
    expect(opens).toBe(1)
    await unmount()
    await render({ nonce: 1, served })
    expect(opens).toBe(1)
  })

  it('opens again for the next request', async () => {
    const served = { current: 0 }
    await render({ nonce: 0, served })
    expect(opens).toBe(0)
    await render({ nonce: 1, served })
    expect(opens).toBe(1)
    await unmount()
    await render({ nonce: 1, served })
    await render({ nonce: 2, served })
    expect(opens).toBe(2)
  })

  it('a fresh caller (a new panel) starts with nothing to open', async () => {
    await render({ nonce: 0, served: { current: 0 } })
    expect(opens).toBe(0)
  })

  it('without a served record, the value at mount counts as served (other callers)', async () => {
    await render({ nonce: 3 })
    expect(opens).toBe(0)
    await render({ nonce: 4 })
    expect(opens).toBe(1)
    await render({ nonce: undefined })
    expect(opens).toBe(1)
  })
})
