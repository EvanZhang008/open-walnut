/**
 * Settings "Copy diagnostics" (the build line) and "Copy host diagnostics"
 * (Remote Hosts header), clicked as a user would, in either engine:
 * `PW_WEBKIT=1 npx playwright test --project=webkit settings-copy-diagnostics`
 * is the Mac app's WKWebView.
 *
 * The page's clipboard API is replaced by a recorder (init script) so both
 * engines hand the test the exact text the page wrote: WebKit grants no
 * clipboard-read permission to Playwright. What is pinned: the button says
 * "Copied", the text is the doctor block, and it carries neither this
 * machine's user name nor its home path (the fixture server runs as the
 * developer, so both are real values here).
 */
import os from 'node:os'
import { test, expect, type Page } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

declare global {
  interface Window { __copied?: string[]; __refuseClipboard?: boolean }
}

/** `refuse`: every clipboard path fails until the test sets `window.__refuseClipboard = false`. */
async function recordClipboard(page: Page, refuse = false) {
  await page.addInitScript((startRefusing: boolean) => {
    window.__copied = []
    window.__refuseClipboard = startRefusing
    const record = (t: string) => {
      if (window.__refuseClipboard) throw new DOMException('Write permission denied.', 'NotAllowedError')
      window.__copied!.push(t)
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t: string) => { record(t) },
        write: async (items: ClipboardItem[]) => {
          for (const item of items) record(await (await item.getType('text/plain')).text())
        },
        readText: async () => window.__copied!.at(-1) ?? '',
      },
    })
    const execCommand = document.execCommand.bind(document)
    document.execCommand = (cmd: string, ...rest: unknown[]) =>
      cmd === 'copy' && window.__refuseClipboard ? false : execCommand(cmd, ...(rest as [boolean, string]))
  }, refuse)
}

async function copied(page: Page): Promise<string> {
  return page.evaluate(() => window.__copied?.at(-1) ?? '')
}

async function openSettings(page: Page) {
  // page.goto only to load the app; everything after is a click.
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 30_000 })
}

function expectNoIdentity(text: string) {
  const user = os.userInfo().username
  expect(text).not.toContain(os.homedir())
  if (user.length >= 2) expect(text).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_.-])${user}([^A-Za-z0-9_-]|$)`))
}

test('the build line copies the redacted doctor block and says Copied', async ({ page }) => {
  await recordClipboard(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)

  const line = page.getByTestId('settings-build-line')
  await line.scrollIntoViewIfNeeded()
  const button = line.getByTestId('settings-copy-diagnostics')
  await expect(button).toHaveText('Copy diagnostics')
  // WebKit tabs only to buttons with an explicit tabindex (N20).
  await expect(button).toHaveAttribute('tabindex', '0')
  // One row: the link sits on the build line, not below it.
  const [lineBox, buttonBox] = [await line.boundingBox(), await button.boundingBox()]
  expect(buttonBox!.y).toBeLessThan(lineBox!.y + lineBox!.height)

  await button.click()
  await expect(button).toHaveText('Copied', { timeout: 30_000 })
  const text = await copied(page)
  expect(text.startsWith('Open Walnut doctor (server, ')).toBe(true)
  expect(text).toContain('claude     ')
  expect(text).toContain('hosts      ')
  expectNoIdentity(text)
  await expect(page.getByTestId('settings-diagnostics-fallback')).toHaveCount(0)
  await expect(button).toHaveText('Copy diagnostics', { timeout: 5_000 })
})

test('a refused copy shows the text to copy by hand, and the next click copies it without collecting again', async ({ page }) => {
  await recordClipboard(page, true)
  const collections: string[] = []
  page.on('request', (req) => { if (new URL(req.url()).pathname === '/api/diagnostics') collections.push(req.url()) })
  await openSettings(page)

  const button = page.getByTestId('settings-copy-diagnostics')
  await button.scrollIntoViewIfNeeded()
  await button.click()
  await expect(page.getByTestId('settings-build-line').getByRole('alert')).toHaveText('Copy failed: the browser refused clipboard access', { timeout: 30_000 })
  const box = page.getByTestId('settings-diagnostics-fallback').getByRole('textbox', { name: 'Diagnostics text' })
  await expect(box).toBeVisible()
  await expect(box).toHaveAttribute('readonly', '')
  const shown = await box.inputValue()
  expect(shown.startsWith('Open Walnut doctor (server, ')).toBe(true)
  expectNoIdentity(shown)

  await page.evaluate(() => { window.__refuseClipboard = false })
  await button.click()
  await expect(button).toHaveText('Copied', { timeout: 5_000 })
  expect(await copied(page)).toBe(shown)
  expect(collections).toHaveLength(1)
  await expect(page.getByTestId('settings-diagnostics-fallback')).toHaveCount(0)
})

test('Remote Hosts offers no host diagnostics without a saved, enabled host', async ({ page }) => {
  // The fixture config has one host, disabled: the server lists none, so the button would copy nothing.
  await openSettings(page)
  await page.getByTestId('settings-nav-remote-hosts').click()
  await expect(page.locator('#remote-hosts')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('remote-hosts-copy-diagnostics')).toHaveCount(0)
})

test('Remote Hosts copies the hosts section when a host is saved', async ({ page }) => {
  await recordClipboard(page)
  // Only the page's view of the config gains an enabled host; nothing is written.
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json() as { config: { hosts?: Record<string, unknown> } }
    body.config.hosts = { ...(body.config.hosts ?? {}), 'pw-devbox': { hostname: 'devbox.example.test' } }
    await route.fulfill({ response: res, json: body })
  })
  await openSettings(page)
  await page.getByTestId('settings-nav-remote-hosts').click()
  const button = page.getByTestId('remote-hosts-copy-diagnostics')
  await expect(button).toBeVisible({ timeout: 20_000 })
  await button.click()
  await expect(button).toHaveText('Copied', { timeout: 30_000 })
  const text = await copied(page)
  expect(text.startsWith('Open Walnut host diagnostics (')).toBe(true)
  expect(text).not.toContain('claude     ')
  expectNoIdentity(text)
})
