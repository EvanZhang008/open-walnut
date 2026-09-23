/**
 * Pure parts of the settings pane context: the Saved / Not saved timing state
 * machine, the per-pane row failure book, and the SSR shape of the section
 * header inside and outside a SettingsPaneProvider.
 */
import { describe, expect, it } from 'vitest'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  FAILED_HOLD_MS,
  SAVED_FADE_IN_MS,
  SAVED_FADE_OUT_MS,
  SAVED_HOLD_MS,
  SettingsPaneProvider,
  SettingsPaneSkeleton,
  isHeaderAboveBar,
  saveErrorMessage,
  savedStatusDelay,
  savedStatusReducer,
  savedStatusTimerEvent,
  withRowFailure,
  withoutRowFailure,
  type SavedStatus,
  type SettingsPaneMeta,
} from '../../web/src/components/settings/settings-pane-context.js'
import { SettingsSection } from '../../web/src/components/settings/SettingsSection.js'

/** Drive the reducer the way the provider's timer effect does, returning the
 *  time (ms after the notification) at which the status leaves the DOM. */
function lifetime(start: SavedStatus): number {
  let t = 0
  let s: SavedStatus | null = start
  for (let i = 0; i < 5 && s; i++) {
    t += savedStatusDelay(s)
    s = savedStatusReducer(s, savedStatusTimerEvent(s))
  }
  expect(s).toBeNull()
  return t
}

describe('saved indicator state machine', () => {
  it('success: 120ms in + 2000ms hold + 200ms out, then removed', () => {
    const s = savedStatusReducer(null, { type: 'success' })!
    expect(s).toMatchObject({ kind: 'saved', leaving: false })
    expect(savedStatusDelay(s)).toBe(SAVED_FADE_IN_MS + SAVED_HOLD_MS)
    const leaving = savedStatusReducer(s, savedStatusTimerEvent(s))!
    expect(leaving.leaving).toBe(true)
    expect(savedStatusDelay(leaving)).toBe(SAVED_FADE_OUT_MS)
    // C12: gone at 2.32s, inside the 2.5s +-0.3s window the spec checks.
    expect(lifetime(s)).toBe(2320)
  })

  it('a re-save restarts the timer and ignores the stale timer event', () => {
    const first = savedStatusReducer(null, { type: 'success' })!
    const second = savedStatusReducer(first, { type: 'success' })!
    expect(second.seq).toBeGreaterThan(first.seq)
    expect(second.kind).toBe('saved')
    // The first save's timer fires late: it must not start the fade.
    expect(savedStatusReducer(second, { type: 'expire', seq: first.seq })).toBe(second)
    // A re-save during the fade brings it back without unmounting.
    const fading = savedStatusReducer(second, savedStatusTimerEvent(second))!
    const back = savedStatusReducer(fading, { type: 'success' })!
    expect(back).toMatchObject({ kind: 'saved', leaving: false })
    expect(savedStatusReducer(back, { type: 'removed', seq: fading.seq })).toBe(back)
  })

  it('failure holds 6000ms (+ fade) and carries the server message', () => {
    const s = savedStatusReducer(null, { type: 'failure', message: 'disk full' })!
    expect(s).toMatchObject({ kind: 'failed', message: 'disk full' })
    expect(savedStatusDelay(s)).toBe(FAILED_HOLD_MS)
    expect(lifetime(s)).toBe(FAILED_HOLD_MS + SAVED_FADE_OUT_MS)
  })

  it('a success replaces a failure at once', () => {
    const failed = savedStatusReducer(null, { type: 'failure', message: 'x' })!
    const ok = savedStatusReducer(failed, { type: 'success' })!
    expect(ok.kind).toBe('saved')
    expect(ok.message).toBeUndefined()
  })

  it('reset clears everything (pane switch)', () => {
    const s = savedStatusReducer(null, { type: 'success' })
    expect(savedStatusReducer(s, { type: 'reset' })).toBeNull()
  })
})

describe('row failure book', () => {
  it('stores per pane and row, clears one row without touching others', () => {
    let book = withRowFailure({}, 'sessions', 'idle-timeout', 'HTTP 500')
    book = withRowFailure(book, 'sessions', 'other', 'nope')
    book = withRowFailure(book, 'tasks', 'idle-timeout', 'tasks failure')
    expect(book.sessions['idle-timeout']).toBe('HTTP 500')
    const cleared = withoutRowFailure(book, 'sessions', 'idle-timeout')
    expect(cleared.sessions['idle-timeout']).toBeUndefined()
    expect(cleared.sessions.other).toBe('nope')
    expect(cleared.tasks['idle-timeout']).toBe('tasks failure')
  })

  it('clearing a missing row returns the same object (no re-render)', () => {
    const book = withRowFailure({}, 'a', 'b', 'c')
    expect(withoutRowFailure(book, 'a', 'zzz')).toBe(book)
    expect(withoutRowFailure(book, 'nope', 'b')).toBe(book)
  })

  it('error text falls back for non-Error throws', () => {
    expect(saveErrorMessage(new Error('boom'))).toBe('boom')
    expect(saveErrorMessage('plain')).toBe('plain')
    expect(saveErrorMessage(undefined)).toBe('Unknown error')
  })

  it('header is under the bar only once its bottom passes the bar line', () => {
    expect(isHeaderAboveBar(100, 50, 44)).toBe(false)
    expect(isHeaderAboveBar(94, 50, 44)).toBe(true)
  })
})

const META: SettingsPaneMeta = {
  id: 'tasks',
  label: 'Tasks',
  title: 'Tasks',
  description: 'How new tasks start and what the board shows.',
  icon: null,
  tint: 'rgb(255, 149, 0)',
  glyph: 'checklist',
}
const metaFor = (id: string) => (id === 'tasks' ? META : undefined)

describe('section shell SSR', () => {
  it('outside a provider: plain header, id + settings-section kept, no Saved', () => {
    const html = renderToStaticMarkup(h(SettingsSection, { id: 'tasks', title: 'Tasks', description: 'Desc' }, 'body'))
    expect(html).toContain('id="tasks"')
    expect(html).toContain('class="settings-section settings-card"')
    expect(html).toContain('settings-card-head')
    expect(html).not.toContain('settings-pane-header')
    expect(html).not.toContain('settings-saved-indicator')
  })

  it('lead section in a provider: pane header with tile, h2 id and one sentence', () => {
    const html = renderToStaticMarkup(
      h(SettingsPaneProvider, { paneId: 'tasks', leadSectionId: 'tasks', metaFor },
        h(SettingsSection, { id: 'tasks', title: 'Old title', description: 'Old description.' }, 'body')),
    )
    expect(html).toContain('settings-pane-header')
    expect(html).toContain('id="tasks-title"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('>Tasks</h2>')
    expect(html).toContain('How new tasks start and what the board shows.')
    expect(html).toContain('settings-pane-tile')
    expect(html).toContain('class="settings-section settings-card is-lead"')
  })

  it('other sections in the pane fold under a 17px header', () => {
    const html = renderToStaticMarkup(
      h(SettingsPaneProvider, { paneId: 'tasks', leadSectionId: 'tasks', metaFor },
        h(SettingsSection, { id: 'focus-tiers', title: 'Focus Tiers', description: 'Tiers.' }, 'body')),
    )
    expect(html).toContain('id="focus-tiers"')
    expect(html).toContain('settings-folded-header')
    expect(html).toContain('is-folded')
    expect(html).not.toContain('settings-pane-header')
  })

  it('skeleton: real header from meta plus three 44/132/88px blocks', () => {
    const html = renderToStaticMarkup(h(SettingsPaneSkeleton, { meta: META }))
    expect(html).toContain('id="tasks-title"')
    for (const px of [44, 132, 88]) expect(html).toContain(`height:${px}px`)
    expect(html).not.toMatch(/shimmer/)
  })
})
