/**
 * useTaskControlSlot: a session panel's memory of whether it drew Fork, Board
 * and Locate, so a later "no task" keeps their places as spacers instead of
 * moving the tool row (2026-10-11).
 *
 * The memory is per session (a host that hands a mounted panel another session
 * starts it over), and it crosses one replacement: a panel that adopts the
 * canonical id of a prefix hands it to the panel the host mounts under the full
 * id. Only that panel reads it, on its first frame. The r3 hand-over was read on
 * every render and kept until a panel for the id mounted, so when the host folded
 * the prefix column into a column already showing the full id, that column grew
 * three spacers at its next render and moved Changed, Files and Terminal under a
 * click, and a later fresh panel for the session drew spacers instead of nothing
 * (the r3 gate, L-17).
 *
 * Real React mounts over linkedom; each render's slot is recorded, so a frame
 * that drew the wrong thing is caught, not only the settled state. The browser
 * half: tests/e2e/browser/session-header-chips-hold-place.spec.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const { useTaskControlSlot, _taskSlotHandOverPendingForTests: pending } = await import('../../web/src/components/sessions/useTaskControlSlot')

type Presence = 'task' | 'none' | 'unknown'
interface PanelSpec { key: string; sid: string; presence: Presence }

/** Every render's slot, by panel key (a repeat of the last one is not a new frame: a render-phase
 *  update renders the panel twice in a row). */
let frames: Record<string, string[]> = {}
/** Each mounted panel's handOver, by panel key. */
const handOvers: Record<string, (id: string) => void> = {}

function Panel({ panelKey, sid, presence }: { panelKey: string; sid: string; presence: Presence }) {
  const { slot, handOver } = useTaskControlSlot(sid, presence)
  const seen = (frames[panelKey] ??= [])
  if (seen.at(-1) !== slot) seen.push(slot)
  handOvers[panelKey] = handOver
  return null
}

/** A host: a list of panels, keyed like the home columns (a new key is a new panel). */
function Host({ panels }: { panels: PanelSpec[] }) {
  return createElement('div', null, ...panels.map((p) => createElement(Panel, { key: p.key, panelKey: p.key, sid: p.sid, presence: p.presence })))
}

let root: { render: (n: unknown) => void; unmount: () => void } | null = null

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  frames = {}
})

async function show(panels: PanelSpec[]): Promise<void> {
  if (!root) root = createRoot((globalThis as unknown as { document: Document }).document.createElement('div'))
  await act(async () => { root!.render(createElement(Host, { panels })) })
}
const last = (key: string) => frames[key]?.at(-1)

const FULL = '2532066a-e210-4702-be34-ed01008adbde'
const PREFIX = FULL.slice(0, 8)

describe('useTaskControlSlot', () => {
  it('a panel that drew the three keeps their places when "no task" arrives; known from the first frame, none', async () => {
    await show([{ key: 'a', sid: 'sess-a', presence: 'unknown' }])
    expect(last('a')).toBe('live')
    await show([{ key: 'a', sid: 'sess-a', presence: 'none' }])
    expect(last('a')).toBe('spacer')
    // A panel that heard of a task later still keeps its places when it goes away.
    await show([{ key: 'a', sid: 'sess-a', presence: 'none' }, { key: 'b', sid: 'sess-b', presence: 'none' }])
    expect(frames.b).toEqual(['absent'])
    await show([{ key: 'a', sid: 'sess-a', presence: 'none' }, { key: 'b', sid: 'sess-b', presence: 'task' }])
    await show([{ key: 'a', sid: 'sess-a', presence: 'none' }, { key: 'b', sid: 'sess-b', presence: 'none' }])
    expect(frames.b).toEqual(['absent', 'live', 'spacer'])
  })

  it('a mounted panel handed another session starts over: that session decides from its own first frame', async () => {
    // The plugin session view renders one panel and changes its session.
    await show([{ key: 'p', sid: 'sess-with-task', presence: 'task' }])
    expect(last('p')).toBe('live')
    await show([{ key: 'p', sid: 'sess-no-task', presence: 'none' }])
    expect(frames.p, 'the first session\'s drawing does not follow the panel').toEqual(['live', 'absent'])
    await show([{ key: 'p', sid: 'sess-with-task', presence: 'none' }])
    expect(last('p'), 'nor does it come back with the first session').toBe('absent')
  })

  it('a prefix panel replaced under the full id: the new panel starts from what it drew, once', async () => {
    await show([{ key: PREFIX, sid: PREFIX, presence: 'unknown' }])
    expect(last(PREFIX)).toBe('live')
    // The record names the full id: the panel hands over, and the host mounts a panel under the full id.
    handOvers[PREFIX]!(FULL)
    expect(pending(FULL)).toBe(true)
    await show([{ key: FULL, sid: FULL, presence: 'none' }])
    expect(frames[FULL], 'the new panel never frames without the places').toEqual(['spacer'])
    expect(pending(FULL), 'taken').toBe(false)
    await show([{ key: FULL, sid: FULL, presence: 'none' }])
    expect(last(FULL)).toBe('spacer')
    // Closed, then opened again for a session known to have no task: a fresh panel, nothing drawn.
    await show([])
    await show([{ key: `${FULL}-again`, sid: FULL, presence: 'none' }])
    expect(frames[`${FULL}-again`]).toEqual(['absent'])
  })

  it('the host folds the prefix column into one already showing the full id: that one never picks the hand-over up', async () => {
    // The full id is open, known to have no task; a chat reference opens its prefix in another column.
    await show([{ key: FULL, sid: FULL, presence: 'none' }, { key: PREFIX, sid: PREFIX, presence: 'unknown' }])
    expect(last(FULL)).toBe('absent')
    expect(last(PREFIX)).toBe('live')
    handOvers[PREFIX]!(FULL)
    // The host drops the prefix column (sessionColumns.replaceSessionColumn) and the open one renders on.
    await show([{ key: FULL, sid: FULL, presence: 'none' }])
    await show([{ key: FULL, sid: FULL, presence: 'none' }])
    expect(frames[FULL]!.every((slot) => slot === 'absent'), `every frame of the open panel: ${frames[FULL]!.join(',')}`).toBe(true)
    expect(pending(FULL), 'the hand-over died with the panel that made it').toBe(false)
    // Closed and opened again from the finder: no places drawn.
    await show([])
    await show([{ key: `${FULL}-again`, sid: FULL, presence: 'none' }])
    expect(frames[`${FULL}-again`]).toEqual(['absent'])
  })

  it('a host that keeps the panel and hands it the full id: it reads its own hand-over, which is then spent', async () => {
    await show([{ key: 'one', sid: PREFIX, presence: 'unknown' }])
    handOvers.one!(FULL)
    await show([{ key: 'one', sid: FULL, presence: 'none' }])
    expect(frames.one).toEqual(['live', 'spacer'])
    expect(pending(FULL), 'spent once read, while its panel is still open').toBe(false)
    // Another panel for the session, opened meanwhile from a list that knows it has no task: nothing drawn.
    await show([{ key: 'one', sid: FULL, presence: 'none' }, { key: 'two', sid: FULL, presence: 'none' }])
    expect(frames.two).toEqual(['absent'])
  })

  it('a panel that drew nothing hands nothing over, and a hand-over no panel took ends with its maker', async () => {
    await show([{ key: 'k', sid: 'sess-k', presence: 'none' }])
    handOvers.k!('sess-k-full')
    expect(pending('sess-k-full')).toBe(false)
    await show([{ key: 'm', sid: 'sess-m', presence: 'task' }])
    handOvers.m!('sess-m-full')
    expect(pending('sess-m-full')).toBe(true)
    await show([])
    expect(pending('sess-m-full')).toBe(false)
  })
})
