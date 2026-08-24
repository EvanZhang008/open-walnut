import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'

/**
 * Plugin APPS — the frontend half of the plugin app system.
 *
 * The fixture server installs no plugins, so this pins the two behaviors that
 * must hold on a stock install:
 *
 *   1. Zero plugins = zero noise on EITHER entry surface. No divider, no `/apps/…`
 *      link, the column is still exactly the core nine, and Settings → Manage carries
 *      no App row. (The declutter spec owns the label list; here we assert the app
 *      group specifically stays empty.)
 *   2. An unknown app id answers with a friendly card, never a raw error and
 *      never a bounce to home through the router's catch-all. A dead-end errno
 *      in the UI is a bug, not a diagnosis.
 *
 * Full end-to-end coverage of a REAL embedded app (iframe boots, walnut:ready →
 * walnut:init handshake, an api round trip) needs a plugin that ships an app —
 * that lands with the example plugin.
 *
 * The `/api/apps` assertion is deliberately its OWN test rather than a
 * precondition inside the sidebar one: the endpoint is server-owned, so if it is
 * missing the failure names the server, and the frontend behavior (empty group,
 * not-found card) still reports its own verdict — a hook-based sidebar treats a
 * failed catalogue fetch as "no apps" by design.
 */

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

/** Expand the sidebar so labels (not just glyphs) are assertable. */
async function expandSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('.sidebar')
  await expect(sidebar).toBeVisible({ timeout: 30_000 })
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

test('the catalogue endpoint answers an empty list on a plugin-free install', async () => {
  const res = await fetch(`${API}/api/apps`)
  expect(res.ok).toBe(true)
  const apps = (await res.json()) as Array<{ id: string }>
  expect(Array.isArray(apps)).toBe(true)
  expect(apps).toHaveLength(0)
})

test('with no plugins installed the sidebar carries no app entries', async ({ page }) => {
  await page.goto('/')
  await expandSidebar(page)

  await expect(page.locator('.sidebar-nav a[href^="/apps/"]')).toHaveCount(0)
  await expect(page.locator('.sidebar-nav [data-testid^="sidebar-app-"]')).toHaveCount(0)

  const labels = (await page.locator('.sidebar-nav .sidebar-link').allTextContents()).map((t) => t.trim())
  expect(labels).toEqual([
    'Chat', 'Todo', 'Agenda', 'Home', 'Tasks', 'Notes', 'Calendar', 'Routines', 'Settings',
  ])

  // The other entry surface stays empty too: an App only reaches Settings → Manage by
  // asking for `placement: 'settings'`, so zero plugins must mean zero extra rows.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-agents')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-nav [data-testid^="settings-nav-app-"]')).toHaveCount(0)
})

test('an unknown app id shows the not-found card, not a crash or a redirect home', async ({ page }) => {
  // Initial load only — the deep link IS the thing under test (a stale bookmark
  // to a removed app is exactly how a user reaches this state).
  await page.goto('/apps/no-such-app-xyz')

  const pageRoot = page.getByTestId('plugin-app-page')
  await expect(pageRoot).toBeVisible({ timeout: 30_000 })
  const card = page.getByTestId('plugin-app-not-found')
  await expect(card).toBeVisible()
  await expect(card).toContainText('App not found')
  await expect(card).toContainText('no-such-app-xyz')

  // The route survived: the catch-all did NOT bounce it to /.
  await expect(page).toHaveURL(/\/apps\/no-such-app-xyz$/)
  // No iframe was mounted for a nonexistent app.
  await expect(page.getByTestId('plugin-app-iframe')).toHaveCount(0)
  // No render crash. AppErrorBoundary is styled inline (no class to hook), so
  // match its actual copy — a class selector here would assert nothing.
  await expect(page.getByText('Something went wrong rendering the page.')).toHaveCount(0)

  // The escape hatch is a real SPA link (click, no page.goto).
  await card.getByRole('link', { name: 'Back to Walnut' }).click()
  await expect(page).toHaveURL(/localhost:\d+\/$/)
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('the plugin-app SDK is served for plugin authors to load', async () => {
  const res = await fetch(`${API}/walnut-app-sdk.js`)
  expect(res.ok).toBe(true)
  const body = await res.text()
  // The four protocol messages the host implements must all be spoken by the SDK.
  for (const marker of ['walnut:ready', 'walnut:api', 'walnut:subscribe', 'walnut:open']) {
    expect(body).toContain(marker)
  }
  expect(body).toContain('window.Walnut')
})

/**
 * The bridge end-to-end, in a REAL browser, through a REAL sandboxed iframe.
 *
 * Only the CATALOGUE is mocked (the plugin that ships an app is another agent's
 * deliverable). The app page itself is served over real HTTP by a throwaway
 * loopback server that also serves the SDK, so the shape matches production: one
 * origin serving both, the page loading `/walnut-app-sdk.js` by relative path,
 * and the iframe genuinely sandboxed without `allow-same-origin` — i.e. an
 * opaque "null" origin, which is exactly the condition a jsdom unit test cannot
 * reproduce and the one the host's source/origin check must get right.
 *
 * The real HTTP server is load-bearing, not fussiness: a `route.fulfill`-ed
 * document has no real address space, so Chrome's private-network rules refuse
 * to let it pull the SDK off loopback at all ("Permission was denied for this
 * request to access the `loopback` address space") and `window.Walnut` never
 * exists. That is a mock artifact — production serves real bytes over real HTTP
 * from the same server — but it makes route-mocking the app document useless
 * for testing anything that loads a subresource.
 */
const FAKE_APP_HTML = `<!doctype html>
<html><body>
<div id="ctx">waiting</div>
<div id="api">waiting</div>
<div id="evt">waiting</div>
<div id="blocked">waiting</div>
<script src="/walnut-app-sdk.js"></script>
<script>
  Walnut.ready(function (ctx) {
    document.getElementById('ctx').textContent =
      ctx.appId + '|' + ctx.pluginId + '|' + ctx.theme;
    Walnut.api('GET', '/api/dashboard').then(function (data) {
      document.getElementById('api').textContent = 'ok:' + (typeof data);
    }).catch(function (e) {
      document.getElementById('api').textContent = 'err:' + e.error;
    });
    Walnut.api('POST', '/api/config', { nope: 1 }).then(function () {
      document.getElementById('blocked').textContent = 'ALLOWED';
    }).catch(function (e) {
      document.getElementById('blocked').textContent = 'refused:' + e.error;
    });
    Walnut.on('task:', function (name) {
      document.getElementById('evt').textContent = name;
    });
  });
</script>
</body></html>`

/** Serve the fake app doc + the real SDK bytes from one throwaway origin. */
async function startAppHost(): Promise<{ url: string; close: () => Promise<void> }> {
  const sdk = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/public/walnut-app-sdk.js'),
    'utf8',
  )
  const server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/walnut-app-sdk.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' })
      res.end(sdk)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(FAKE_APP_HTML)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/app/index.html`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('an embedded app completes the handshake, calls the API, gets events, and is refused config writes', async ({ page }) => {
  const host = await startAppHost()
  try {
    await runEmbeddedAppChecks(page, host.url)
  } finally {
    await host.close()
  }
})

async function runEmbeddedAppChecks(page: Page, appUrl: string): Promise<void> {
  await page.route('**/api/apps', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 'demo', pluginId: 'demo-plugin', title: 'Demo App', icon: null, url: appUrl },
    ]),
  }))

  await page.goto('/')
  await expandSidebar(page)

  // Real UI click, no page.goto — the sidebar entry is the product surface.
  const entry = page.getByTestId('sidebar-app-demo')
  await expect(entry).toBeVisible({ timeout: 30_000 })
  await expect(entry).toContainText('Demo App')
  await entry.click()
  await expect(page).toHaveURL(/\/apps\/demo$/)

  const frameEl = page.getByTestId('plugin-app-iframe')
  await expect(frameEl).toBeVisible({ timeout: 30_000 })
  // The security boundary, asserted on the live attribute: scripts yes,
  // same-origin NEVER (that is what keeps the device token out of reach).
  const sandbox = await frameEl.getAttribute('sandbox')
  expect(sandbox).toContain('allow-scripts')
  expect(sandbox).not.toContain('allow-same-origin')

  const frame = page.frameLocator('[data-testid="plugin-app-iframe"]')
  // walnut:ready → walnut:init, carrying identity + theme.
  await expect(frame.locator('#ctx')).toHaveText(/^demo\|demo-plugin\|(light|dark)$/, { timeout: 20_000 })
  // A real API round trip through the host.
  await expect(frame.locator('#api')).toHaveText('ok:object', { timeout: 20_000 })
  // The one carve-out: a config WRITE is refused by the host, not attempted.
  await expect(frame.locator('#blocked')).toContainText('refused:', { timeout: 20_000 })
  await expect(frame.locator('#blocked')).toContainText('Settings')

  // Bus events reach the app, filtered by its declared prefix.
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `plugin-app-event ${Date.now()}`, source: 'local' }),
  })
  expect(res.ok).toBe(true)
  await expect(frame.locator('#evt')).toHaveText(/^task:/, { timeout: 20_000 })
}
