// A card that waits on the user folds to one line with its × and never answers it
// (web/src/components/actions/AskFold.tsx). The fold is a view choice kept per card id with what
// the card asked when it was folded: a new ask on the same card opens it and drops that fold, so
// the card coming back to its old words later never arrives folded. Mounted for real (linkedom +
// the web app's own React), since the drop runs in an effect.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement as h, act, useSyncExternalStore } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

// The view memory as a plain map that re-renders its readers, read and written the way
// usePageViewOf is (one value per page, name and id).
const kept = new Map<string, unknown>()
const heard = new Set<() => void>()
const hear = (l: () => void) => { heard.add(l); return () => { heard.delete(l) } }
vi.mock('../../web/src/utils/view-memory', () => ({
  usePageViewOf: (page: string, name: string, id: string, initial: unknown) => {
    const key = `${page}.${name}|${id}`
    const v = useSyncExternalStore(hear, () => (kept.has(key) ? kept.get(key) : initial))
    return [v, setters.get(key) ?? setters.set(key, (x: unknown) => { kept.set(key, x); for (const l of [...heard]) l() }).get(key)]
  },
}))
const setters = new Map<string, (x: unknown) => void>()

const { AskFoldLine, asksNothingNew, foldIds, useAskFold } = await import('../../web/src/components/actions/AskFold')

type Fold = ReturnType<typeof useAskFold>
let last: Fold
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
const Probe = ({ place, id, sig, many }: { place: string; id: string; sig: string; many?: boolean }) => {
  last = many ? useAskFold(place, id, sig, asksNothingNew) : useAskFold(place, id, sig)
  return null
}
const at = async (place: string, id: string, sig: string, many?: boolean): Promise<Fold> => {
  await act(async () => { root!.render(h(Probe, { place, id, sig, many })) })
  return last
}
const run = async (f: () => void) => { await act(async () => { f() }) }

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  kept.clear()
  setters.clear()
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  document.body.innerHTML = ''
})

describe('useAskFold', () => {
  it('folds the card it names, for the ask it holds, until Show', async () => {
    await run((await at('action-item', 'item-1', 'Deploy now?')).fold)
    expect((await at('action-item', 'item-1', 'Deploy now?')).folded).toBe(true)
    // Another card, and the same card in another place, are their own.
    expect((await at('action-item', 'item-2', 'Deploy now?')).folded).toBe(false)
    expect((await at('org-alert', 'item-1', 'Deploy now?')).folded).toBe(false)
    await run((await at('action-item', 'item-1', 'Deploy now?')).show)
    expect((await at('action-item', 'item-1', 'Deploy now?')).folded).toBe(false)
  })

  it('a new ask opens it and drops the fold, so its old words coming back never arrive folded', async () => {
    await run((await at('org-thread', 't1', 'needs||')).fold)
    // It moves to Working: open, and the kept fold is dropped.
    expect((await at('org-thread', 't1', 'working||')).folded).toBe(false)
    expect(kept.get('ask-fold.org-thread|t1')).toBe('')
    // Back in Needs you with a new question that reads the same: open.
    expect((await at('org-thread', 't1', 'needs||')).folded).toBe(false)
  })

  it('keeps the fold while what it asks is not known yet (its status still loading)', async () => {
    await run((await at('kanban-prompt', 's1', 'req-1')).fold)
    expect((await at('kanban-prompt', 's1', '')).folded).toBe(false)
    expect((await at('kanban-prompt', 's1', 'req-1')).folded).toBe(true)
  })

  it('a place with no card (no id) never reads folded', async () => {
    await run((await at('kanban-prompt', '', 'Bash')).fold)
    expect((await at('kanban-prompt', '', 'Bash')).folded).toBe(false)
  })

  it('a card of several asks stays folded as they are answered and opens for a new one', async () => {
    await run((await at('action-asks', 'task-1', foldIds(['a', 'b', 'c']), true)).fold)
    // One answered: still folded, and only the rest are kept.
    expect((await at('action-asks', 'task-1', foldIds(['b', 'c']), true)).folded).toBe(true)
    expect(kept.get('ask-fold.action-asks|task-1')).toBe(foldIds(['b', 'c']))
    // The answered one asked again is new to it now: open.
    expect((await at('action-asks', 'task-1', foldIds(['a', 'b', 'c']), true)).folded).toBe(false)
    expect(kept.get('ask-fold.action-asks|task-1')).toBe('')
  })
})

describe('AskFoldLine', () => {
  it('says what waits and offers Show, never an answer', () => {
    const html = renderToStaticMarkup(h(AskFoldLine, {
      testId: 'action-fold-line', showTestId: 'action-fold-show', lead: 'Waits on you', onShow: () => {},
      words: h('span', { className: 'top-thread-line-title' }, 'Deploy now?'),
    }))
    expect(html).toContain('data-testid="action-fold-line"')
    expect(html).toContain('Waits on you')
    expect(html).toContain('Deploy now?')
    expect(html).toMatch(/data-testid="action-fold-show"[^>]*>Show<\/button>/)
    expect(html).toContain('top-thread-dot is-needs')
  })

  it('a thread line wears its own mark in place of the red dot', () => {
    const html = renderToStaticMarkup(h(AskFoldLine, {
      testId: 'org-thread-folded', showTestId: 'org-thread-show', onShow: () => {},
      mark: h('span', { className: 'org-thread-state' }, 'Done'), words: h('span', null, 'Release notes'),
    }))
    expect(html).toContain('org-thread-state')
    expect(html).not.toContain('top-thread-dot')
  })
})
