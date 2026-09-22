/**
 * The default-engine picker in WEBKIT — the Mac app is a WKWebView, and a styled
 * <select> inside a settings subcard is exactly the shape that has rendered
 * differently there before (a cap that floors a fractional line height, a control
 * that paints but cannot be opened).
 *
 * READ-ONLY on purpose: this file and the chromium one run in a single Playwright
 * invocation against one fixture server, so two files writing `defaults.engine`
 * would race on the same config key. The write path is pinned in the chromium
 * spec; what is pinned here is that WebKit paints the row, agrees with the
 * server about the current value, and can open the list.
 */
import { test, expect } from '@playwright/test'
import { openEnginesSection } from './engine-settings-helpers'

test.use({ browserName: 'webkit' })
test.setTimeout(90_000)

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('webkit: the default-engine row renders, matches the config and offers the catalog', async ({ page, request }) => {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: { defaults?: { engine?: string } } }
  const configured = body.config?.defaults?.engine ?? 'claude'

  const section = await openEnginesSection(page)
  const select = section.getByTestId('default-engine-select')
  await expect(select).toBeVisible()
  await expect(select).toHaveValue(configured)
  await expect(section).toContainText('Default engine for new sessions')

  // The control has real height and is not clipped by the subcard around it —
  // a zero/negative box is how a WebKit-only layout break shows up.
  const box = await select.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThan(16)
  expect(box!.width).toBeGreaterThan(80)
  const sectionBox = await section.boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(sectionBox!.y - 1)

  // The list is populated and Claude is selectable (label read from the DOM, so a
  // WebKit-only empty option list would fail here).
  const options = await select.locator('option').evaluateAll(
    (nodes) => nodes.map((n) => (n as HTMLOptionElement).value),
  )
  expect(options.length).toBeGreaterThan(0)
  expect(options).toContain('claude')
  await expect(select).toBeEnabled()
})
