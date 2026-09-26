/**
 * Settings → Plugins → Configure: the config form's rows keep the generic settings
 * row layout inside the Installed list.
 *
 * The form's rows are rendered INSIDE `.plugin-store-installed`, whose own row rules
 * (plugin-updates.css, settings-sections-addons.css) once reached them through a
 * descendant combinator. A stacked list field then rendered its label and help
 * centred, a 320px gap under them (a row-direction basis applied to a column), and a
 * small textarea near the bottom; a wide text field dropped under its label and sat
 * flush right. This spec measures both rows in a wide group (600px or more) and,
 * after a live resize, in a narrow one.
 *
 * Every plugin endpoint is a page.route fixture with neutral names, and nothing is
 * saved, so the shared fixture's config is never touched.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a WKWebView)
 * with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { test, expect, type Page, type Route } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

const PLUGIN = 'channel-watch'
const LIST_FIELD = `plugin-${PLUGIN}-channels`
const TEXT_FIELD = `plugin-${PLUGIN}-quiet_hours`
/** Layout rounding between engines, in CSS px. */
const PX = 1.5

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const row = (id: string, name: string, configurable: boolean) => ({
  id, name, description: `${name} keeps an eye on things.`,
  source: { kind: 'builtin' }, installed: true, status: 'active', builtin: true, configurable,
  catalog: false, toggleable: true, version: '1.0.0',
})

async function mockPlugins(page: Page) {
  const rows = [row(PLUGIN, 'Channel Watch', true), row('quiet-helper', 'Quiet Helper', false)]
  await page.route('**/api/plugin-runtime/registry', (route) =>
    json(route, { rows, installedCount: rows.length, availableCount: 0 }))
  await page.route('**/api/plugin-sources', (route) => json(route, []))
  await page.route('**/api/integrations/connections', (route) => json(route, { connections: [] }))
  await page.route('**/api/integrations/settings', (route) => json(route, [{
    id: PLUGIN, name: 'Channel Watch', status: 'loaded', missing: [],
    configSchema: {
      properties: {
        interval: { type: 'integer', default: 5 },
        quiet_hours: { type: 'string', default: '22:00-08:00' },
        channels: { type: 'array', items: { type: 'string' } },
        notify: { type: 'boolean', default: true },
      },
    },
    uiHints: {
      interval: { label: 'Check every (minutes)', help: '0 stops the watching altogether' },
      quiet_hours: { label: 'Quiet hours', help: 'No reminders inside this local window, as HH:MM-HH:MM. Leave empty for none.' },
      channels: { label: 'Watch these channels', help: 'One name per entry' },
      notify: { label: 'Send a letter for each mention' },
    },
    values: {},
  }]))
}

interface Box { left: number; right: number; top: number; bottom: number }
interface RowGeometry { contentLeft: number; contentRight: number; label: Box; help: Box; control: Box }

/** The two rows under test, measured against their own row's content box. */
async function measure(page: Page): Promise<{ groupWidth: number; list: RowGeometry; text: RowGeometry }> {
  return page.getByTestId(`plugin-config-${PLUGIN}`).evaluate((form, ids) => {
    const box = (el: Element | null): Box => {
      if (!el) throw new Error('missing element')
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    }
    const parts = (fieldId: string): RowGeometry => {
      const control = form.querySelector(`#${fieldId}`)
      const rowEl = control?.closest('.settings-row')
      if (!rowEl) throw new Error(`no row for ${fieldId}`)
      const cs = getComputedStyle(rowEl)
      const r = rowEl.getBoundingClientRect()
      return {
        contentLeft: r.left + parseFloat(cs.paddingLeft),
        contentRight: r.right - parseFloat(cs.paddingRight),
        label: box(rowEl.querySelector('.settings-row-label')),
        help: box(rowEl.querySelector('.settings-row-help')),
        control: box(control),
      }
    }
    const group = form.closest('.settings-group')
    if (!group) throw new Error('config form is not inside a settings group')
    return { groupWidth: group.getBoundingClientRect().width, list: parts(ids.list), text: parts(ids.text) }
  }, { list: LIST_FIELD, text: TEXT_FIELD })
}

/** A stacked list field: label and help at the row's left edge, the editor right under them, full width. */
function expectStackedList(g: RowGeometry) {
  expect(Math.abs(g.label.left - g.contentLeft), 'list label starts at the row edge').toBeLessThan(PX)
  expect(Math.abs(g.help.left - g.contentLeft), 'list help starts at the row edge').toBeLessThan(PX)
  expect(Math.abs(g.control.left - g.contentLeft), 'textarea starts at the row edge').toBeLessThan(PX)
  expect(Math.abs(g.control.right - g.contentRight), 'textarea spans to the row edge').toBeLessThan(PX)
  const gap = g.control.top - g.help.bottom
  expect(gap, 'textarea sits right under the help, no dead space').toBeGreaterThanOrEqual(0)
  expect(gap, 'textarea sits right under the help, no dead space').toBeLessThan(16)
}

async function openConfig(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  const nav = page.getByTestId('settings-nav-plugin-store')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  await page.getByTestId(`plugin-configure-${PLUGIN}`).click()
  const form = page.getByTestId(`plugin-config-${PLUGIN}`)
  await expect(form.locator(`#${LIST_FIELD}`)).toBeVisible({ timeout: 30_000 })
  await expect(form.locator(`#${TEXT_FIELD}`)).toBeVisible()
  await form.scrollIntoViewIfNeeded()
  return form
}

async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId(`plugin-config-${PLUGIN}`).screenshot({
    path: `/tmp/walnut-plugin-cards/spec-${engine}-${name}.png`, scale: 'css',
  })
}

test('config form rows keep the generic row layout inside the plugin list, wide and narrow', async ({ page }) => {
  await mockPlugins(page)
  await openConfig(page)

  // Wide group: the text field fits beside its copy, right-aligned on the copy's line.
  const wide = await measure(page)
  expect(wide.groupWidth, 'precondition: a wide group').toBeGreaterThanOrEqual(600)
  expectStackedList(wide.list)
  const t = wide.text
  expect(Math.abs(t.label.left - t.contentLeft), 'text label starts at the row edge').toBeLessThan(PX)
  expect(Math.abs(t.control.right - t.contentRight), 'text field is right-aligned').toBeLessThan(PX)
  expect(t.control.top < t.help.bottom && t.control.bottom > t.label.top, 'text field shares the copy line').toBe(true)
  await shot(page, 'wide')

  // The list's own rows still get the list layout: the fix scopes those rules, it does not drop them.
  const listRow = page.getByTestId('plugin-row-quiet-helper')
  expect(await listRow.evaluate((el) => getComputedStyle(el).flexWrap)).toBe('wrap')
  expect(await listRow.locator('.settings-row-copy').evaluate((el) => getComputedStyle(el).flexBasis)).toBe('320px')

  // Narrow group (under 600px), after a live resize: the text field drops under its
  // copy, from the copy's left edge, across the row.
  await page.setViewportSize({ width: 900, height: 900 })
  await expect.poll(async () => (await measure(page)).groupWidth).toBeLessThan(600)
  const narrow = await measure(page)
  expectStackedList(narrow.list)
  const n = narrow.text
  expect(n.control.top, 'text field drops under its copy').toBeGreaterThanOrEqual(n.help.bottom)
  expect(Math.abs(n.control.left - n.contentLeft), 'dropped text field starts at the copy edge').toBeLessThan(PX)
  expect(Math.abs(n.control.right - n.contentRight), 'dropped text field spans the row').toBeLessThan(PX)
  await shot(page, 'narrow')
})
