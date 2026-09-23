/**
 * Settings primitives in a real browser (run in Chromium AND WebKit: the Mac app
 * is a WKWebView). The page is /settings on the fixture's Vite dev server; on
 * top of it a harness mounts the REAL primitive modules (same React instance
 * Vite serves the app with) inside a SettingsPaneProvider, so the Saved timing,
 * optimistic revert, commit-on-unmount, sticky compact bar, container wrapping,
 * hairlines, colours, focus rings and reduced motion are measured on the
 * shipped code rather than on a copy.
 *
 * Saves go to an in-page fake (window.__h) so a spec can force a failure or a
 * delay without touching the fixture's config.
 */
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(120_000)

const HARNESS = String.raw`
const src = await (await fetch('/src/main.tsx')).text()
const m = src.match(/\/node_modules\/\.vite\/deps\/react-dom_client\.js\?v=(\w+)/)
if (!m) { window.__harnessError = 'not a Vite dev server'; throw new Error('not vite') }
const v = m[1]
const React = (await import('/node_modules/.vite/deps/react.js?v=' + v)).default
const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js?v=' + v)).default
const ctx = await import('/src/components/settings/settings-pane-context.tsx')
const sec = await import('/src/components/settings/SettingsSection.tsx')
const { ToggleSwitch } = await import('/src/components/settings/inputs/ToggleSwitch.tsx')
const { NumberInput } = await import('/src/components/settings/inputs/NumberInput.tsx')
const { SegmentedControl } = await import('/src/components/settings/inputs/SegmentedControl.tsx')
const { SettingsCheckbox } = await import('/src/components/settings/inputs/SettingsCheckbox.tsx')
const { SettingsButton } = await import('/src/components/settings/inputs/SettingsButton.tsx')
const { InlineConfirmButton } = await import('/src/components/settings/inputs/InlineConfirmButton.tsx')
const { useOptimisticSetting } = await import('/src/components/settings/inputs/useOptimisticSetting.ts')
const { useCommitField } = await import('/src/components/settings/inputs/useCommitField.ts')
const h = React.createElement
const { useState } = React

window.__h = { saves: [], mode: 'ok', delay: 60, formEvents: [] }
const fakeSave = (v) => { window.__h.saves.push(v); return new Promise((res, rej) => setTimeout(() => (window.__h.mode === 'fail' ? rej(new Error('HTTP 500: disk full')) : res()), window.__h.delay)) }

const META = {
  tasks: { id: 'tasks', label: 'Tasks', title: 'Tasks', description: 'How new tasks start and what the board shows.', icon: null, tint: 'rgb(255, 149, 0)', glyph: 'check' },
  sessions: { id: 'sessions', label: 'Sessions', title: 'Sessions', description: 'How Walnut runs an engine.', icon: null, tint: 'rgb(88, 86, 214)', glyph: 'play' },
  engines: { id: 'engines', label: 'Engines', title: 'Engines', description: 'Settings the engine keeps itself.', icon: null, tint: 'rgb(52, 199, 89)', glyph: 'cpu' },
}
const metaFor = (id) => META[id]

function OptRow() {
  const [server, setServer] = useState(false)
  const opt = useOptimisticSetting(server, (x) => fakeSave(x).then(() => setServer(x)), { rowKey: 'priority' })
  return h(sec.SettingsRow, { label: 'Show task priority', help: 'Adds the priority dot to every task row.', htmlFor: 'opt-switch', 'data-testid': 'opt-row', error: opt.error,
    control: h(ToggleSwitch, { id: 'opt-switch', checked: opt.value, busy: opt.busy, onChange: opt.set }) })
}

function CommitRow() {
  const [server, setServer] = useState(30)
  const f = useCommitField(server, (x) => fakeSave(x).then(() => setServer(x)), { rowKey: 'idle-timeout' })
  return h(sec.SettingsRow, { label: 'Idle timeout', htmlFor: 'idle-timeout', anchor: 'idle-timeout-row', error: f.error,
    control: h(NumberInput, { id: 'idle-timeout', field: f.inputProps, unit: 'minutes' }) })
}

function FormRows() {
  const [on, setOn] = useState(false)
  const onRef = (form) => {
    if (!form || form.__wired) return
    form.__wired = true
    form.addEventListener('change', () => window.__h.formEvents.push(new FormData(form).get('git-enabled')))
  }
  return h('form', { ref: onRef, 'data-testid': 'harness-form' }, h(sec.SettingsGroup, null,
    h(sec.SettingsRow, { label: 'Git versioning', htmlFor: 'git-switch', control: h(ToggleSwitch, { id: 'git-switch', name: 'git-enabled', checked: on, onChange: setOn }) }),
    h(sec.SettingsDisclosure, { id: 'harness-more', label: 'More options', summary: 'Off', 'data-testid': 'harness-disclosure' },
      h(sec.SettingsRow, { label: 'Hidden child', anchor: 'hidden-child', control: h('input', { name: 'child-field', defaultValue: 'kept', className: 'settings-input settings-input--short' }) }))))
}
`

const HARNESS_2 = String.raw`
function ControlRows() {
  const [theme, setTheme] = useState('light')
  const [cal, setCal] = useState(false)
  const [busy, setBusy] = useState(false)
  return h(React.Fragment, null,
    h(sec.SettingsGroup, { heading: 'Controls', 'data-testid': 'controls-group' },
      h(sec.SettingsRow, { label: 'Theme', 'data-testid': 'theme-row', control: h(SegmentedControl, { id: 'theme', value: theme, onChange: setTheme, 'aria-label': 'Theme',
        options: [{ value: 'light', label: 'Light', testId: 'theme-light' }, { value: 'dark', label: 'Dark', testId: 'theme-dark' }, { value: 'system', label: 'System', testId: 'theme-system' }] }) }),
      h(sec.SettingsRow, { label: 'Calendar refresh', 'data-testid': 'refresh-row', control: h(SettingsButton, { 'data-testid': 'refresh-btn', busy, busyLabel: 'Refreshing...', onClick: () => { setBusy(true); setTimeout(() => setBusy(false), 800) } }, 'Refresh now') }),
      h(sec.SettingsRow, { label: 'Paired phone', indent: true, 'data-testid': 'remove-row', control: h(InlineConfirmButton, { 'data-testid': 'remove-btn', onConfirm: () => { window.__h.removed = (window.__h.removed || 0) + 1 } }) }),
      h(sec.SettingsRow, { label: 'Model id', wide: true, 'data-testid': 'wide-row', control: h('input', { className: 'settings-input settings-input--long settings-input--mono', defaultValue: 'global.anthropic.claude-opus-5-5', 'aria-label': 'Model id' }) }),
    ),
    h(sec.SettingsChecklist, { heading: 'Calendars', headingTrailing: (cal ? 1 : 0) + ' of 1 shown' },
      h(SettingsCheckbox, { id: 'cal-1', 'data-testid': 'cal-1', checked: cal, onChange: setCal, label: 'Team calendar' })))
}

function Filler({ n }) {
  return h(sec.SettingsGroup, { heading: 'Filler' }, Array.from({ length: n }, (_, i) => h(sec.SettingsRow, { key: i, label: 'Filler row ' + i, help: 'Keeps the pane tall enough to scroll.' })))
}

function PaneContent({ pane }) {
  const body = pane === 'tasks' ? [h(OptRow, { key: 'o' }), h(ControlRows, { key: 'c' }), h(FormRows, { key: 'f' }), h(Filler, { key: 'x', n: 30 }), h(OptRowLow, { key: 'low' })]
    : pane === 'sessions' ? [h(sec.SettingsGroup, { key: 'g' }, h(CommitRow))]
    : [h(sec.SettingsGroup, { key: 'g' }, h(sec.SettingsRow, { label: 'Engine row' }))]
  return h(sec.SettingsSection, { id: pane, title: META[pane].title, actions: pane === 'tasks' ? h(SettingsButton, { 'data-testid': 'pane-action' }, 'Refresh') : undefined }, body)
}

function OptRowLow() {
  const [server, setServer] = useState(false)
  const opt = useOptimisticSetting(server, (x) => fakeSave(x).then(() => setServer(x)), { rowKey: 'low' })
  return h(sec.SettingsGroup, { heading: 'Bottom' }, h(sec.SettingsRow, { label: 'Last calendar', htmlFor: 'low-switch', error: opt.error,
    control: h(ToggleSwitch, { id: 'low-switch', checked: opt.value, busy: opt.busy, onChange: opt.set }) }))
}

function Nav({ setPane }) {
  const failed = ctx.useFailedPanes()
  return h('nav', { className: 'harness-nav', style: { display: 'flex', gap: '8px', padding: '8px' } },
    Object.keys(META).map((id) => h('button', { key: id, type: 'button', 'data-testid': 'settings-nav-' + id, onClick: () => setPane(id) }, META[id].label,
      failed.has(id) ? h('span', { 'data-testid': 'nav-dot-' + id, title: "A change here wasn't saved." }, ' !') : null)))
}

function App() {
  const [pane, setPane] = useState('tasks')
  window.__setPane = setPane
  return h('div', { className: 'settings-container', style: { height: '100%' } }, h('div', { className: 'settings-layout', 'data-testid': 'harness-layout', style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    h(ctx.SettingsPaneProvider, { paneId: pane, leadSectionId: pane, metaFor },
      h(Nav, { setPane }),
      h('div', { className: 'settings-pane', role: 'region', 'aria-labelledby': pane + '-title', 'data-testid': 'harness-pane',
        style: { flex: '1 1 auto', overflowY: 'auto', padding: '28px 40px 64px', background: 'var(--settings-pane-bg)', '--settings-pane-pad-x': '40px' } },
        h(ctx.SettingsPaneStickyBar),
        h('div', { style: { maxWidth: '680px' }, 'data-testid': 'harness-column' }, h(PaneContent, { key: pane, pane }))))))
}

const host = document.createElement('div')
host.id = 'settings-harness'
host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:var(--bg)'
document.body.appendChild(host)
createRoot(host).render(h(App))
window.__harnessReady = true
`

async function mountHarness(page: Page, opts: { reducedMotion?: boolean } = {}) {
  if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/settings')
  await page.waitForLoadState('domcontentloaded')
  await page.addScriptTag({ type: 'module', content: HARNESS + HARNESS_2 })
  await page.waitForFunction(() => (window as unknown as { __harnessReady?: boolean; __harnessError?: string }).__harnessReady
    || (window as unknown as { __harnessError?: string }).__harnessError, null, { timeout: 30_000 })
  const err = await page.evaluate(() => (window as unknown as { __harnessError?: string }).__harnessError)
  test.skip(!!err, `harness needs the Vite dev fixture: ${err}`)
  await expect(page.getByTestId('harness-pane')).toBeVisible()
}

const H = (page: Page) => page.locator('#settings-harness')

const saves = (page: Page) => page.evaluate(() => (window as unknown as { __h: { saves: unknown[] } }).__h.saves)
const setMode = (page: Page, mode: 'ok' | 'fail', delay = 60) =>
  page.evaluate(([m, d]) => {
    const w = window as unknown as { __h: { mode: string; delay: number } }
    w.__h.mode = m as string
    w.__h.delay = d as number
  }, [mode, delay] as const)

test.describe('settings primitives', () => {
  test('C12: a save shows Saved, a re-save restarts the hold, then the element leaves the DOM', async ({ page }) => {
    await mountHarness(page)
    const sw = H(page).locator('#opt-switch')
    const indicator = H(page).getByTestId('settings-saved-indicator')
    await expect(indicator).toHaveCount(0)
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(indicator).toHaveText('Saved', { timeout: 1000 })
    await expect(indicator).toHaveAttribute('role', 'status')
    await expect(indicator).toHaveAttribute('aria-live', 'polite')
    const shownAt = Date.now()
    // Re-save 1.5s in: the hold restarts, no flash (the element never leaves).
    await page.waitForTimeout(1500)
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(1200)
    await expect(indicator).toHaveCount(1)
    await expect(indicator).toHaveCount(0, { timeout: 3000 })
    const lifetime = Date.now() - shownAt
    // 1.5s + one full 2.32s cycle, with generous slack for a loaded machine.
    expect(lifetime).toBeGreaterThan(3500)
    expect(lifetime).toBeLessThan(5800)
    expect(await saves(page)).toEqual([true, false])
  })

  test('C12 timing: a single save leaves the DOM 2.2 to 2.8s after it lands', async ({ page }) => {
    await mountHarness(page)
    // Timestamps in the page (MutationObserver), not Playwright's backing-off polls.
    await page.evaluate(() => {
      const w = window as unknown as { __t: { shown?: number; gone?: number } }
      w.__t = {}
      new MutationObserver(() => {
        const el = document.querySelector('#settings-harness [data-testid="settings-saved-indicator"]')
        if (el && w.__t.shown === undefined) w.__t.shown = performance.now()
        if (!el && w.__t.shown !== undefined && w.__t.gone === undefined) w.__t.gone = performance.now()
      }).observe(document.getElementById('settings-harness')!, { subtree: true, childList: true })
    })
    await H(page).locator('#opt-switch').click()
    await expect(H(page).getByTestId('settings-saved-indicator')).toHaveText('Saved', { timeout: 1000 })
    await expect(H(page).getByTestId('settings-saved-indicator')).toHaveCount(0, { timeout: 4000 })
    const t = await page.evaluate(() => (window as unknown as { __t: { shown: number; gone: number } }).__t)
    const dt = t.gone - t.shown
    expect(dt).toBeGreaterThan(2200)
    expect(dt).toBeLessThan(2800)
  })

  test('C13 + C68: a failed switch reverts, shows an untimed row error and Not saved, never Saved', async ({ page }) => {
    await mountHarness(page)
    await setMode(page, 'fail')
    const sw = H(page).locator('#opt-switch')
    const indicator = H(page).getByTestId('settings-saved-indicator')
    let sawSaved = false
    await page.exposeFunction('__sawSaved', () => { sawSaved = true })
    await page.evaluate(() => {
      new MutationObserver(() => {
        const el = document.querySelector('#settings-harness [data-testid="settings-saved-indicator"]')
        if (el?.textContent === 'Saved') (window as unknown as { __sawSaved: () => void }).__sawSaved()
      }).observe(document.getElementById('settings-harness')!, { subtree: true, childList: true, characterData: true })
    })
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    const alert = H(page).locator('.settings-row-error[role="alert"]')
    await expect(alert).toContainText("Couldn't save: HTTP 500: disk full")
    await expect(indicator).toHaveText('Not saved')
    await expect(indicator).toHaveAttribute('title', 'HTTP 500: disk full')
    const next = H(page).getByTestId('theme-row')
    const before = await next.boundingBox()
    await page.waitForTimeout(7000)
    await expect(alert).toHaveCount(1)
    expect(await next.boundingBox()).toEqual(before)
    await expect(indicator).toHaveCount(0)
    expect(sawSaved).toBe(false) // the whole failure path never showed Saved
    await setMode(page, 'ok')
    await sw.click()
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    await expect(alert).toHaveCount(0)
    await expect(indicator).toHaveText('Saved')
  })
})

test.describe('pane bookkeeping', () => {
  test('C60: a typed value flushes when the pane unmounts; the new pane never shows Saved', async ({ page }) => {
    await mountHarness(page)
    await H(page).getByTestId('settings-nav-sessions').click()
    const input = H(page).locator('#idle-timeout')
    await expect(input).toHaveValue('30')
    await input.fill('45')
    await H(page).getByTestId('settings-nav-engines').click()
    await expect.poll(() => saves(page)).toEqual([45])
    await expect(H(page).locator('#engines-title')).toHaveText('Engines')
    // Watch the Engines pane for the whole save round trip plus the hold.
    for (let i = 0; i < 6; i++) {
      await expect(H(page).getByTestId('settings-saved-indicator')).toHaveCount(0)
      await page.waitForTimeout(150)
    }
  })

  test('C60: a flushed save that fails marks the old pane and replays as a row error', async ({ page }) => {
    await mountHarness(page)
    await setMode(page, 'fail', 150)
    await H(page).getByTestId('settings-nav-sessions').click()
    await H(page).locator('#idle-timeout').fill('50')
    await H(page).getByTestId('settings-nav-engines').click()
    await expect(H(page).getByTestId('nav-dot-sessions')).toBeVisible()
    await expect(H(page).getByTestId('settings-saved-indicator')).toHaveCount(0)
    await H(page).getByTestId('settings-nav-sessions').click()
    await expect(H(page).getByTestId('nav-dot-sessions')).toHaveCount(0)
    await expect(H(page).locator('#idle-timeout-row + .settings-row-error[role="alert"]')).toContainText("Couldn't save")
    await expect(H(page).locator('#idle-timeout')).toHaveAttribute('aria-invalid', 'true')
  })

  test('commit field: Enter commits, unchanged sends nothing, Esc reverts', async ({ page }) => {
    await mountHarness(page)
    await H(page).getByTestId('settings-nav-sessions').click()
    const input = H(page).locator('#idle-timeout')
    await input.click()
    await input.press('Enter')
    await input.fill('31')
    await input.press('Enter')
    await expect.poll(() => saves(page)).toEqual([31])
    await expect(H(page).getByTestId('settings-saved-indicator')).toHaveText('Saved')
    await input.fill('99')
    await input.press('Escape')
    await expect(input).toHaveValue('31')
    await expect(input).not.toBeFocused()
    await page.waitForTimeout(300)
    expect(await saves(page)).toEqual([31])
  })

  test('C67: at the bottom of a long pane the compact bar holds the one Saved indicator in view', async ({ page }) => {
    await mountHarness(page)
    const pane = H(page).getByTestId('harness-pane')
    await pane.evaluate((el) => { el.scrollTop = el.scrollHeight })
    const bar = H(page).locator('.settings-pane-stickybar')
    await expect(bar).toHaveClass(/is-compact/)
    const inner = H(page).locator('.settings-pane-stickybar-inner')
    const box = await inner.boundingBox()
    expect(Math.abs((box?.height ?? 0) - 44)).toBeLessThanOrEqual(2)
    expect(await H(page).locator('.settings-pane-stickybar-title').evaluate((el) => getComputedStyle(el).fontSize)).toBe('15px')
    // Actions move into the bar once, never duplicated.
    await expect(H(page).getByTestId('pane-action')).toHaveCount(1)
    await expect(inner.getByTestId('pane-action')).toHaveCount(1)
    await H(page).locator('#low-switch').click()
    const indicator = H(page).getByTestId('settings-saved-indicator')
    await expect(indicator).toHaveText('Saved')
    await expect(indicator).toHaveCount(1)
    await expect(inner.getByTestId('settings-saved-indicator')).toHaveCount(1)
    const ib = await indicator.boundingBox()
    const vp = page.viewportSize()!
    expect(ib!.y).toBeGreaterThanOrEqual(0)
    expect(ib!.y + ib!.height).toBeLessThanOrEqual(vp.height)
    // Back to the top: the full header owns the indicator again.
    await pane.evaluate((el) => { el.scrollTop = 0 })
    await expect(bar).not.toHaveClass(/is-compact/)
    await expect(H(page).locator('.settings-pane-header').getByTestId('pane-action')).toHaveCount(1)
  })
})

test.describe('controls', () => {
  test('segmented: .check() and arrow keys select in this engine; checkbox checks; named switch feeds FormData', async ({ page }) => {
    await mountHarness(page)
    const dark = H(page).getByTestId('theme-dark')
    await dark.check()
    await expect(dark).toHaveAttribute('aria-checked', 'true')
    await expect(H(page).getByTestId('theme-light')).toHaveAttribute('aria-checked', 'false')
    await dark.press('ArrowRight')
    await expect(H(page).getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true')
    await expect(H(page).getByTestId('theme-system')).toBeFocused()
    await expect(H(page).locator('#theme')).toHaveAttribute('role', 'radiogroup')

    const cal = H(page).getByTestId('cal-1')
    const cb = await cal.boundingBox()
    expect([Math.round(cb!.width), Math.round(cb!.height)]).toEqual([16, 16])
    const labelBox = await H(page).locator('.settings-checkbox-label').boundingBox()
    expect(labelBox!.x - (cb!.x + cb!.width)).toBeGreaterThanOrEqual(8)
    await cal.check()
    await expect(cal).toBeChecked()
    await expect(H(page).getByText('1 of 1 shown')).toBeVisible()
    await cal.press('Space')
    await expect(cal).not.toBeChecked()

    await H(page).locator('#git-switch').click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __h: { formEvents: unknown[] } }).__h.formEvents)).toEqual(['on'])
    await H(page).locator('#git-switch').press('Space')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __h: { formEvents: unknown[] } }).__h.formEvents)).toEqual(['on', null])
  })

  test('disclosure: closed rows stay mounted, state persists in sessionStorage, chevron is SVG', async ({ page }) => {
    await mountHarness(page)
    const row = H(page).getByTestId('harness-disclosure')
    await expect(row).toHaveAttribute('aria-expanded', 'false')
    const child = H(page).locator('#hidden-child')
    await expect(child).toBeAttached()
    await expect(child).toBeHidden()
    expect(await H(page).getByTestId('harness-form').evaluate((f) => new FormData(f as HTMLFormElement).get('child-field'))).toBe('kept')
    await expect(row.locator('svg.settings-disclosure-chevron')).toHaveCount(1)
    await row.click()
    await expect(row).toHaveAttribute('aria-expanded', 'true')
    await expect(child).toBeVisible()
    expect(await page.evaluate(() => sessionStorage.getItem('walnut.settings.disclosure.harness-more'))).toBe('1')
    await row.press('Enter')
    await expect(child).toBeHidden()
  })

  test('C79: labels that change never move the button or its neighbours', async ({ page }) => {
    await mountHarness(page)
    const refresh = H(page).getByTestId('refresh-btn')
    // Reserved labels never leak into the accessible name either.
    await expect(H(page).getByRole('button', { name: 'Refresh now', exact: true })).toHaveCount(1)
    await expect(H(page).getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1)
    const before = await refresh.boundingBox()
    await refresh.click()
    await expect(refresh).toHaveText('Refreshing...') // reserve labels live in pseudo-elements, not text
    const during = await refresh.boundingBox()
    expect(Math.abs(during!.x - before!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(during!.width - before!.width)).toBeLessThanOrEqual(1)

    const remove = H(page).getByTestId('remove-btn')
    const label = H(page).getByTestId('remove-row').locator('.settings-row-label')
    const rb = await remove.boundingBox()
    const lb = await label.boundingBox()
    await remove.click()
    await expect(remove).toHaveText('Confirm remove')
    expect(await page.evaluate(() => (window as unknown as { __h: { removed?: number } }).__h.removed ?? 0)).toBe(0)
    const ra = await remove.boundingBox()
    expect(Math.abs(ra!.x - rb!.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(ra!.width - rb!.width)).toBeLessThanOrEqual(1)
    expect(await label.boundingBox()).toEqual(lb)
    // Unconfirmed: reverts after 3s without a request.
    await expect(remove).toHaveText('Remove', { timeout: 4500 })
    expect(await page.evaluate(() => (window as unknown as { __h: { removed?: number } }).__h.removed ?? 0)).toBe(0)
    await remove.click()
    await remove.click()
    expect(await page.evaluate(() => (window as unknown as { __h: { removed?: number } }).__h.removed ?? 0)).toBe(1)
  })
})

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
}

test.describe('geometry and colour', () => {
  test('C26 + C27 + C28: header, row type, hairlines inset 14px (36px indented), none on the first row', async ({ page }) => {
    await mountHarness(page)
    const title = H(page).locator('#tasks-title')
    expect(await title.evaluate((el) => [getComputedStyle(el).fontSize, Number(getComputedStyle(el).fontWeight) >= 600])).toEqual(['22px', true])
    const tile = await H(page).locator('.settings-pane-header .settings-pane-tile').boundingBox()
    expect([Math.round(tile!.width), Math.round(tile!.height)]).toEqual([40, 40])
    const row = H(page).getByTestId('opt-row')
    const type = await row.evaluate((el) => {
      const label = el.querySelector('.settings-row-label')!
      const help = el.querySelector('.settings-row-help')!
      const root = getComputedStyle(el)
      const probe = document.createElement('span')
      probe.style.color = 'var(--fg)'
      el.appendChild(probe)
      const fg = getComputedStyle(probe).color
      probe.style.color = 'var(--fg-muted)'
      const muted = getComputedStyle(probe).color
      probe.remove()
      const ch = document.createElement('div')
      ch.style.width = '60ch'
      help.appendChild(ch)
      const sixtyCh = getComputedStyle(ch).width
      ch.remove()
      return {
        label: [getComputedStyle(label).fontSize, getComputedStyle(label).color === fg, getComputedStyle(label).textTransform],
        help: [getComputedStyle(help).fontSize, getComputedStyle(help).color === muted, Math.abs(parseFloat(getComputedStyle(help).maxWidth) - parseFloat(sixtyCh)) < 1, getComputedStyle(help).maxWidth, sixtyCh],
        minHeight: root.minHeight,
      }
    })
    expect(type.label).toEqual(['14px', true, 'none'])
    expect(type.help[0]).toBe('12.5px')
    expect(type.help[1]).toBe(true)
    expect(type.help[2]).toBe(true) // max-width is 60ch at the help's own font
    expect(type.minHeight).toBe('44px')

    const lines = await H(page).getByTestId('controls-group').evaluate((block) => {
      const group = block.querySelector('.settings-group') ?? block
      const g = group.getBoundingClientRect()
      return Array.from(group.children).filter((c) => c.classList.contains('settings-row')).map((r) => {
        const before = getComputedStyle(r, '::before')
        return { content: before.content, left: r.getBoundingClientRect().left - g.left + parseFloat(before.left || '0'), indent: r.classList.contains('settings-row-indent') }
      })
    })
    expect(lines[0].content === 'none' || lines[0].content === 'normal').toBe(true)
    for (const l of lines.slice(1)) {
      expect(l.content).toBe('""')
      expect(Math.round(l.left) - 1).toBe(l.indent ? 36 : 14) // minus the group's 1px border
    }
  })

  test('C29: group and pane colours in light and dark', async ({ page }) => {
    await mountHarness(page)
    const read = () => page.evaluate(() => ({
      group: getComputedStyle(document.querySelector('#settings-harness .settings-group')!).backgroundColor,
      pane: getComputedStyle(document.querySelector('#settings-harness .settings-pane')!).backgroundColor,
    }))
    await setTheme(page, 'light')
    expect(await read()).toEqual({ group: 'rgb(255, 255, 255)', pane: 'rgb(245, 245, 247)' })
    await page.screenshot({ path: `/tmp/settings-redesign/p1-primitives-light-${test.info().project.name}.png`, scale: 'css' })
    await setTheme(page, 'dark')
    expect(await read()).toEqual({ group: 'rgb(44, 44, 46)', pane: 'rgb(28, 28, 30)' })
    await page.screenshot({ path: `/tmp/settings-redesign/p1-primitives-dark-${test.info().project.name}.png`, scale: 'css' })
  })

  test('C44: wide rows wrap under 600px, every row under 360px, nothing leaves its group', async ({ page }) => {
    await mountHarness(page)
    const column = H(page).getByTestId('harness-column')
    const check = async (width: number) => {
      await column.evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, width)
      return H(page).getByTestId('controls-group').evaluate((block) => {
        const group = block.querySelector('.settings-group') ?? block
        const g = group.getBoundingClientRect()
        const rows = Array.from(group.querySelectorAll('.settings-row')) as HTMLElement[]
        const wrapped = (r: HTMLElement) => {
          const copy = r.querySelector('.settings-row-copy')!.getBoundingClientRect()
          const ctl = r.querySelector('.settings-row-actions')?.getBoundingClientRect()
          return !!ctl && ctl.top >= copy.bottom - 1
        }
        const overflow = Array.from(group.querySelectorAll('input, button, [role="radiogroup"]')).some((c) => {
          const b = c.getBoundingClientRect()
          return b.width > 0 && (b.left < g.left - 0.5 || b.right > g.right + 0.5)
        })
        return { wide: wrapped(rows.find((r) => r.dataset.wide)!), theme: wrapped(rows.find((r) => r.dataset.testid === 'theme-row')!), overflow }
      })
    }
    expect(await check(680)).toEqual({ wide: false, theme: false, overflow: false })
    expect(await check(500)).toEqual({ wide: true, theme: false, overflow: false })
    expect(await check(330)).toEqual({ wide: true, theme: true, overflow: false })
  })
})

test.describe('motion, focus and case', () => {
  test('C45: reduced motion zeroes every settings transition and animation', async ({ page }) => {
    await mountHarness(page, { reducedMotion: true })
    await H(page).locator('#opt-switch').click()
    await expect(H(page).getByTestId('settings-saved-indicator')).toHaveText('Saved')
    const durations = await page.evaluate(() => {
      const q = (sel: string) => document.querySelector(`#settings-harness ${sel}`)!
      const els = ['.toggle-thumb', '.settings-switch', '.settings-disclosure-chevron', '[data-testid="settings-saved-indicator"]',
        '.settings-pane-stickybar-inner', '.settings-segment'].map(q)
      return els.map((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el).animationDuration])
    })
    for (const [t, a] of durations) {
      expect(t.split(',').every((x) => x.trim() === '0s')).toBe(true)
      expect(a.split(',').every((x) => x.trim() === '0s')).toBe(true)
    }
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`C46: every focused control shows a ring (${theme})`, async ({ page, browserName }) => {
      await mountHarness(page)
      await setTheme(page, theme)
      const ids = ['#opt-switch', '[data-testid="theme-light"]', '[data-testid="refresh-btn"]', '[data-testid="remove-btn"]',
        'input[aria-label="Model id"]', '[data-testid="cal-1"]', '#git-switch', '[data-testid="harness-disclosure"]', '[data-testid="pane-action"]']
      // Keyboard modality first: script focus after a Tab keeps :focus-visible.
      await H(page).locator('#opt-switch').focus()
      await page.keyboard.press('Tab')
      for (const sel of ids) {
        const el = H(page).locator(sel)
        await el.evaluate((node) => (node as HTMLElement).focus())
        const ring = await el.evaluate((node) => {
          const cs = getComputedStyle(node)
          return { outline: cs.outlineStyle, shadow: cs.boxShadow }
        })
        expect(ring.outline !== 'none' || ring.shadow !== 'none', `${sel} in ${browserName}/${theme}: ${JSON.stringify(ring)}`).toBe(true)
      }
    })
  }

  test('C8 + C9: no uppercase transform, no box inside a group', async ({ page }) => {
    await mountHarness(page)
    const report = await page.evaluate(() => {
      const root = document.getElementById('settings-harness')!
      const upper = Array.from(root.querySelectorAll('*')).filter((el) => getComputedStyle(el).textTransform !== 'none').map((el) => el.className)
      const nested = root.querySelectorAll('.settings-group .settings-group, .settings-subcard .settings-subcard').length
      const boxes = Array.from(root.querySelectorAll('.settings-group *')).filter((el) => {
        if (el.matches('input, button, [role="switch"], [role="radio"], [role="radiogroup"], .settings-tag, .settings-segmented, .settings-segment, label.settings-segment')) return false
        if (el.closest('button, [role="radiogroup"], .settings-checkbox-control')) return false
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
        const edge = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderTopLeftRadius) > 0
        return bg && edge
      }).map((el) => el.className)
      return { upper, nested, boxes }
    })
    expect(report).toEqual({ upper: [], nested: 0, boxes: [] })
  })
})
