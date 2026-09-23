/**
 * Pure logic and SSR markup of the settings primitives: optimistic seq/revert,
 * commit-field planning, disclosure storage, segmented keys, and the markup
 * contracts specs rely on (role=switch, hidden FormData mirror, radiogroup,
 * reserved button widths, row errors as role=alert, groups never nested).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import {
  couldntSave,
  initialOptimisticState,
  optimisticReducer,
  type OptimisticState,
} from '../../web/src/components/settings/inputs/useOptimisticSetting.js'
import { commitText, parseCommitText, planCommit } from '../../web/src/components/settings/inputs/useCommitField.js'
import {
  disclosureStorageKey,
  hashTargetId,
  readDisclosureOpen,
  writeDisclosureOpen,
  SettingsDisclosure,
  SettingsGroup,
  SettingsMonoBlock,
  SettingsRow,
  SettingsTag,
  SettingsLoadingRow,
  SettingsSubCard,
  SettingsChecklist,
} from '../../web/src/components/settings/SettingsSection.js'
import { segmentIndexForKey, SegmentedControl } from '../../web/src/components/settings/inputs/SegmentedControl.js'
import { ToggleSwitch } from '../../web/src/components/settings/inputs/ToggleSwitch.js'
import { SettingsCheckbox } from '../../web/src/components/settings/inputs/SettingsCheckbox.js'
import { SettingsButton } from '../../web/src/components/settings/inputs/SettingsButton.js'
import { InlineConfirmButton } from '../../web/src/components/settings/inputs/InlineConfirmButton.js'
import { SecretInput } from '../../web/src/components/settings/inputs/SecretInput.js'
import { NumberInput } from '../../web/src/components/settings/inputs/NumberInput.js'
import { SectionCard } from '../../web/src/components/settings/inputs/SectionCard.js'

type S = OptimisticState<boolean>
const step = (s: S, ...events: Parameters<typeof optimisticReducer<boolean>>[1][]) =>
  events.reduce((acc, e) => optimisticReducer(acc, e), s)

describe('optimistic setting reducer', () => {
  it('shows the new value at once and keeps it after success until the server catches up', () => {
    let s = step(initialOptimisticState<boolean>(), { type: 'set', value: true })
    expect(s.override).toEqual({ value: true, seq: 1, inFlight: true })
    s = step(s, { type: 'resolved', seq: 1, serverEquals: false })
    expect(s.override).toEqual({ value: true, seq: 1, inFlight: false })
    s = step(s, { type: 'server-changed' })
    expect(s.override).toBeNull()
  })

  it('last set wins: a stale response is ignored', () => {
    let s = step(initialOptimisticState<boolean>(), { type: 'set', value: true }, { type: 'set', value: false })
    s = step(s, { type: 'rejected', seq: 1, message: 'stale' })
    expect(s.error).toBeNull()
    expect(s.override?.value).toBe(false)
    s = step(s, { type: 'resolved', seq: 2, serverEquals: true })
    expect(s.override).toBeNull()
  })

  it('failure reverts to the server value with an untimed row error', () => {
    let s = step(initialOptimisticState<boolean>(), { type: 'set', value: true })
    s = step(s, { type: 'rejected', seq: 1, message: 'HTTP 500' })
    expect(s.override).toBeNull()
    expect(s.error).toBe("Couldn't save: HTTP 500")
    // Nothing but the next set() clears it.
    s = step(s, { type: 'server-changed' })
    expect(s.error).toBe("Couldn't save: HTTP 500")
    s = step(s, { type: 'set', value: true })
    expect(s.error).toBeNull()
  })

  it('a config re-read during an open write does not drop the optimistic value', () => {
    const s = step(initialOptimisticState<boolean>(), { type: 'set', value: true }, { type: 'server-changed' })
    expect(s.override?.value).toBe(true)
  })

  it('error copy', () => {
    expect(couldntSave('x')).toBe("Couldn't save: x")
  })
})

describe('commit field planning', () => {
  it('unchanged text sends nothing', () => {
    expect(planCommit('30', '30', 'number')).toEqual({ action: 'skip', text: '30' })
    expect(planCommit('abc', 'abc', 'text')).toEqual({ action: 'skip', text: 'abc' })
  })

  it('a changed number commits the parsed value', () => {
    expect(planCommit('45', '30', 'number')).toEqual({ action: 'commit', value: 45, text: '45' })
  })

  it('clamps only through the caller-supplied server bound', () => {
    const nonNegative = (v: number | undefined) => (v === undefined ? v : Math.max(0, v))
    expect(planCommit<number | undefined>('-5', '30', 'number', nonNegative)).toEqual({ action: 'commit', value: 0, text: '0' })
    expect(planCommit<number | undefined>('-5', '0', 'number', nonNegative)).toEqual({ action: 'skip', text: '0' })
  })

  it('empty number clears (undefined); text keeps spaces as typed', () => {
    expect(parseCommitText('  ', 'number')).toBeUndefined()
    expect(parseCommitText(' a ', 'text')).toBe(' a ')
    expect(planCommit('', '30', 'number')).toEqual({ action: 'commit', value: undefined, text: '' })
    expect(commitText(undefined)).toBe('')
    expect(commitText(12)).toBe('12')
  })
})

function memoryStorage() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe('disclosure storage', () => {
  it('uses walnut.settings.disclosure.<id> in sessionStorage shape', () => {
    expect(disclosureStorageKey('keep-awake')).toBe('walnut.settings.disclosure.keep-awake')
  })

  it('round-trips open/closed and falls back when unset', () => {
    const store = memoryStorage()
    expect(readDisclosureOpen(store, 'x', false)).toBe(false)
    expect(readDisclosureOpen(store, 'x', true)).toBe(true)
    writeDisclosureOpen(store, 'x', true)
    expect(store.map.get('walnut.settings.disclosure.x')).toBe('1')
    expect(readDisclosureOpen(store, 'x', false)).toBe(true)
    writeDisclosureOpen(store, 'x', false)
    expect(readDisclosureOpen(store, 'x', true)).toBe(false)
  })

  it('survives blocked storage', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readDisclosureOpen(blocked, 'x', true)).toBe(true)
    expect(() => writeDisclosureOpen(blocked, 'x', true)).not.toThrow()
    expect(readDisclosureOpen(null, 'x', false)).toBe(false)
  })

  it('hash target decoding', () => {
    expect(hashTargetId('')).toBeNull()
    expect(hashTargetId('#')).toBeNull()
    expect(hashTargetId('#providers')).toBe('providers')
    expect(hashTargetId('#a%20b')).toBe('a b')
    expect(hashTargetId('#%E0%A4%A')).toBe('%E0%A4%A')
  })

  it('closed children stay mounted with hidden (FormData forms)', () => {
    const html = renderToStaticMarkup(
      h(SettingsGroup, null,
        h(SettingsDisclosure, { id: 'git', label: 'Git versioning', summary: 'On' },
          h('input', { name: 'git-enabled', type: 'checkbox', defaultChecked: true }))),
    )
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls="git-disclosure"')
    expect(html).toMatch(/id="git-disclosure"[^>]*hidden=""/)
    expect(html).toContain('name="git-enabled"')
    expect(html).toContain('<svg')
  })

  it('forceOpen shows the children', () => {
    const html = renderToStaticMarkup(h(SettingsDisclosure, { id: 'f', label: 'L', forceOpen: true }, 'child'))
    expect(html).toContain('aria-expanded="true"')
    expect(html).not.toMatch(/id="f-disclosure"[^>]*hidden/)
  })
})

describe('segmented control', () => {
  it('arrow keys wrap, Home/End jump, other keys do nothing', () => {
    expect(segmentIndexForKey('ArrowRight', 2, 3)).toBe(0)
    expect(segmentIndexForKey('ArrowLeft', 0, 3)).toBe(2)
    expect(segmentIndexForKey('ArrowDown', 0, 3)).toBe(1)
    expect(segmentIndexForKey('Home', 2, 3)).toBe(0)
    expect(segmentIndexForKey('End', 0, 3)).toBe(2)
    expect(segmentIndexForKey('a', 0, 3)).toBeNull()
    expect(segmentIndexForKey('ArrowRight', 0, 0)).toBeNull()
  })

  it('radiogroup root with id, radio segments carrying testIds and a native radio each', () => {
    const html = renderToStaticMarkup(
      h(SegmentedControl, {
        id: 'theme',
        value: 'dark',
        'aria-label': 'Theme',
        onChange: () => {},
        options: [
          { value: 'light', label: 'Light', testId: 'theme-light' },
          { value: 'dark', label: 'Dark', testId: 'theme-dark' },
          { value: 'system', label: 'System', testId: 'theme-system' },
        ],
      }),
    )
    expect(html).toMatch(/id="theme" role="radiogroup" aria-label="Theme"/)
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0" data-testid="theme-dark"/)
    expect(html.match(/type="radio"/g)).toHaveLength(3)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
  })
})

describe('control markup', () => {
  const noop = () => {}

  it('switch: role=switch + aria-checked/aria-busy; name adds a hidden FormData mirror', () => {
    const plain = renderToStaticMarkup(h(ToggleSwitch, { id: 'a', checked: true, onChange: noop, busy: true }))
    expect(plain).toMatch(/role="switch" aria-checked="true" aria-busy="true"/)
    expect(plain).not.toContain('type="checkbox"')
    const named = renderToStaticMarkup(h(ToggleSwitch, { id: 'b', name: 'git-enabled', checked: true, onChange: noop }))
    const mirror = named.match(/<input [^>]*>/)?.[0] ?? ''
    for (const attr of ['type="checkbox"', 'name="git-enabled"', 'checked=""', 'tabindex="-1"', 'aria-hidden="true"']) {
      expect(mirror).toContain(attr)
    }
  })

  it('checkbox row: native input kept (checkable), label and trailing slot', () => {
    const html = renderToStaticMarkup(
      h(SettingsCheckbox, { id: 'cal-1', checked: false, onChange: noop, label: 'Team calendar', trailing: 'Read only', 'data-testid': 'cal-1' }),
    )
    expect(html).toMatch(/<input id="cal-1" type="checkbox"[^>]*data-testid="cal-1"/)
    expect(html).toContain('Team calendar')
    expect(html).toContain('settings-checkbox-trailing')
  })

  it('button reserves every label it can show (width never changes)', () => {
    const html = renderToStaticMarkup(
      h(SettingsButton, { busy: true, busyLabel: 'Refreshing...', reserve: ['Refresh now'] }, 'Refresh now'),
    )
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled=""')
    expect(html).toContain('<span class="settings-button-label">Refreshing...</span>')
    // Both labels reserved on the stack, outside textContent.
    expect(html).toContain('data-r1="Refreshing..." data-r2="Refresh now"')
    expect(html.replace(/<[^>]+>/g, '')).toBe('Refreshing...')
  })

  it('inline confirm: starts as Remove with Confirm remove reserved, no native confirm', () => {
    const html = renderToStaticMarkup(h(InlineConfirmButton, { onConfirm: noop }))
    expect(html).toContain('<span class="settings-button-label">Remove</span>')
    expect(html).toContain('data-r1="Confirm remove"')
    expect(html).toContain('data-armed="false"')
  })

  it('secret: saved state is one status line with Replace / Remove, never a mask', () => {
    const saved = renderToStaticMarkup(h(SecretInput, { value: '', onChange: noop, saved: true, onRemove: noop }))
    expect(saved).toContain('Saved in secrets, never synced.')
    expect(saved).toContain('Replace')
    expect(saved).toContain('Remove')
    expect(saved).not.toContain('type="password"')
    const legacy = renderToStaticMarkup(h(SecretInput, { value: 'x', onChange: noop }))
    expect(legacy).toContain('type="password"')
    expect(legacy).toContain('settings-input--short')
  })

  it('number: 120px class and a unit to its right', () => {
    const html = renderToStaticMarkup(h(NumberInput, { id: 'idle-timeout', value: 30, onChange: noop, unit: 'minutes' }))
    expect(html).toContain('settings-input--number')
    expect(html).toContain('<span class="number-input-suffix settings-input-unit">minutes</span>')
  })

  it('row: new props, legacy children + actions, error as role=alert under the row', () => {
    const html = renderToStaticMarkup(
      h(SettingsGroup, null,
        h(SettingsRow, { label: 'Show task priority', help: 'One sentence.', htmlFor: 'p', control: 'CTRL', wide: true, error: "Couldn't save: x", anchor: 'heartbeat-all-clear' }),
        h(SettingsRow, { actions: 'ACT', 'data-testid': 'legacy' }, 'COPY')),
    )
    expect(html).toContain('<label class="settings-row-label" for="p">Show task priority</label>')
    expect(html).toContain('data-wide="true"')
    expect(html).toContain('data-state="error"')
    expect(html).toContain('id="heartbeat-all-clear"')
    expect(html).toMatch(/<\/article><p class="settings-row-error" role="alert">Couldn&#x27;t save: x<\/p>/)
    expect(html).toMatch(/data-testid="legacy"><div class="settings-row-copy">COPY<\/div><div class="settings-row-actions">ACT<\/div>/)
  })

  it('group: heading and footer sit OUTSIDE the box; old SubCard maps to it', () => {
    const html = renderToStaticMarkup(h(SettingsGroup, { heading: 'Shown', headingTrailing: '3 of 21 shown', footer: 'Foot.', disabled: true }, 'rows'))
    expect(html).toMatch(/^<div class="settings-group-block" aria-disabled="true" inert="">/)
    expect(html).toMatch(/<\/div><div class="settings-group settings-subcard">rows<\/div><p class="settings-group-footer/)
    const sub = renderToStaticMarkup(h(SettingsSubCard, { title: 'T', description: 'D' }, 'x'))
    expect(sub).toContain('settings-group-title')
    expect(sub).toContain('settings-group-footer')
    const list = renderToStaticMarkup(h(SettingsChecklist, null, 'x'))
    expect(list).toContain('class="settings-group settings-subcard settings-checklist"')
  })

  it('tag, loading row and mono block', () => {
    expect(renderToStaticMarkup(h(SettingsTag, { tone: 'warning' }, 'Needs setup'))).toBe(
      '<span class="settings-tag settings-tag-warning">Needs setup</span>',
    )
    const loading = renderToStaticMarkup(h(SettingsLoadingRow))
    expect(loading).toContain('Loading...')
    expect(loading).not.toContain('role="status"')
    const mono = renderToStaticMarkup(h(SettingsMonoBlock, { label: 'Raw config', text: '{"a":1}', maxHeight: 240, 'data-testid': 'raw' }))
    expect(mono).toMatch(/<pre class="settings-mono-block" style="max-height:240px" data-testid="raw"/)
    expect(mono).toContain('Copy')
  })

  it('SectionCard: form + Save button, no inline success notice', () => {
    const html = renderToStaticMarkup(h(SectionCard, { id: 'voice', title: 'Voice', onSave: async () => {} }, 'x'))
    expect(html).toMatch(/^<form id="voice" class="settings-section settings-card"/)
    expect(html).toContain('type="submit"')
    expect(html).toContain('Save')
    expect(html).not.toContain('Saved successfully')
  })
})

describe('primitive sources (C10, C11, C20, C80)', () => {
  const root = join(import.meta.dirname, '../../web/src')
  const files = [
    'components/settings/settings-pane-context.tsx',
    'components/settings/settings-glyphs.tsx',
    'components/settings/SettingsSection.tsx',
    ...readdirSync(join(root, 'components/settings/inputs')).map((f) => `components/settings/inputs/${f}`),
    'styles/settings-shell.css',
    'styles/settings-rows.css',
    'styles/settings-controls.css',
    'styles/settings-controls-misc.css',
  ]
  // U+2014 U+2013 dashes, and the symbols C80 bans from visible text.
  const banned = /[—–·→›▸▾✓✗×…↗]/u

  it.each(files)('%s has no banned dash or symbol characters', (file) => {
    const text = readFileSync(join(root, file), 'utf8')
    const hit = text.split('\n').findIndex((line) => banned.test(line))
    expect(hit === -1 ? null : `${file}:${hit + 1}`).toBeNull()
  })

  it.each(files)('%s has no emoji, removed copy, native dialogs or console', (file) => {
    const text = readFileSync(join(root, file), 'utf8')
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(text).not.toMatch(/Saved successfully|Changes save automatically|Configure everything from one place/)
    expect(text).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(/)
    expect(text).not.toMatch(/console\.(log|warn|error|debug)/)
  })
})
