/**
 * macOS Access: the session file-access row a user sets up themselves.
 *
 * The report is stubbed rather than probed, for one structural reason: the
 * session identity deliberately never engages for an isolated daemon dir (see
 * sessionHostUnavailableReason), which is exactly what a fixture server has. So
 * a real report here would always report the row not-applicable and hide it. The
 * server-side row is covered by tests/web/routes/permissions-api.test.ts; what
 * this spec owns is that a user can find it, read what to grant, and act on it
 * without a terminal.
 */
import { test, expect } from '@playwright/test'

/**
 * Evidence for a human reviewer, off by default: `PW_SHOTS=1` saves what the
 * user actually reads. Gated because an ordinary or CI run must not write
 * outside the test output dir, and because the copy in this panel is the whole
 * feature — it has to be looked at, not just asserted on.
 */
async function shot(target: { screenshot: (o: { path: string }) => Promise<unknown> }, name: string): Promise<void> {
  if (!process.env.PW_SHOTS) return
  await target.screenshot({ path: `/tmp/walnut-session-identity/${name}.png` })
}

const REPORT = {
  platform: 'darwin',
  applicable: true,
  launcher: { kind: 'terminal', name: 'iTerm2' },
  probedAt: Date.now(),
  permissions: [
    {
      id: 'full-disk-access',
      label: 'Full Disk Access',
      state: 'denied',
      fixKind: 'settings-only',
      why: 'Lets Walnut read Apple Screen Time.',
      grantTarget: '/Users/example/.open-walnut/cache/walnut-reader-v1',
      launcherIndependent: true,
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      steps: ['Open System Settings.'],
    },
    {
      id: 'session-full-disk-access',
      label: 'Session file access',
      state: 'unknown',
      unverifiable: true,
      optional: true,
      fixKind: 'settings-only',
      why:
        'Optional. Stops the repeated "wants to access data from other apps" popups '
        + 'while Claude Code reads files in a session.',
      grantTarget: '/Applications/Walnut.app',
      launcherIndependent: true,
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
      context:
        'Claude Code runs inside Walnut, so macOS asks Walnut for access, and granting it '
        + 'once replaces a popup per file. Skipping it costs nothing: work in your own '
        + 'project folders never needed it. macOS lists this separately from the reader '
        + 'helper above because it grants access per program, not per app you think of as '
        + 'one. Sessions already running keep the identity they started with, so the switch '
        + 'applies after the session daemon next restarts.',
      steps: [
        'Open System Settings → Privacy & Security → Full Disk Access.',
        'Click + (authenticate if asked).',
        'Press Cmd+Shift+G, then Cmd+V (the path is already copied): /Applications/Walnut.app',
        'You will know it worked because the popups stop.',
      ],
    },
  ],
}

test('a user can set up session file access from Settings, without a terminal', async ({ page }) => {
  // Match by PATHNAME, never a `**/api/permissions**` glob: the fixture serves the
  // SPA through Vite in dev mode, where the client source lives at
  // /src/api/permissions.ts, so that glob also hijacks a module script and answers
  // it with JSON. The page then dies on strict MIME checking and every later
  // assertion fails on a blank screen for a reason that has nothing to do with it.
  await page.route(
    (url) => url.pathname === '/api/permissions',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORT) })
    },
  )
  // The fix button must never actually open System Settings on the machine
  // running the test, so the POST is answered here too.
  let opened: string | null = null
  await page.route((url) => url.pathname.endsWith('/open-settings'), async (route) => {
    opened = new URL(route.request().url()).pathname
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, opened: 'x-apple.systempreferences:…', copiedPath: '/Applications/Walnut.app' }),
    })
  })

  // A blank page is the failure mode this spec must never debug blind.
  const crashes: string[] = []
  page.on('pageerror', (e) => crashes.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') crashes.push(`console: ${m.text()}`) })

  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar'), `page crashed: ${JSON.stringify(crashes.slice(0, 5), null, 1)}`)
    .toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
  await page.locator('.settings-nav-item', { hasText: 'macOS Access' }).click()

  const section = page.locator('#permissions')
  await expect(section).toBeVisible()

  const row = section.locator('.permission-row', { hasText: 'Session file access' })
  await expect(row).toBeVisible()
  // The path is the whole point: users kept granting to "node" and it never
  // worked, so the row has to name what to add.
  await expect(row).toContainText('popups')
  // A user scanning this list must see that skipping it is fine, and must
  // recognise who is asking. Both words are pinned server-side too
  // (tests/web/routes/permissions-api.test.ts); here they are pinned as VISIBLE,
  // because a row that truncates its own text tells the user neither.
  await expect(row).toContainText('Optional.')
  await expect(row).toContainText('Claude Code')
  // The reasoning must NOT be here: it belongs to the dialog, and a paragraph in
  // a scanned list is what made this row twice the height of its neighbour.
  await expect(row).not.toContainText('Skipping it costs nothing')

  // "Unknown" beside a switch the user just flipped reads as a broken check.
  await expect(row.locator('.permission-row-state')).toHaveText("Can't be checked")
  // And it is a setup step, not a fault: "Fix" would say something is broken.
  const setUp = row.getByRole('button', { name: 'Set up…' })
  await expect(setUp).toBeVisible()
  // The reader row, same macOS permission but a different identity, keeps the
  // ordinary wording.
  const readerRow = section.locator('.permission-row', { hasText: 'Full Disk Access' })
  await expect(readerRow.locator('.permission-row-state')).toHaveText('Not granted')
  await expect(readerRow.getByRole('button', { name: 'Fix…' })).toBeVisible()
  await shot(section, 'permissions-section')

  await setUp.click()
  const dialog = page.locator('.app-modal-overlay[role="dialog"]')
  await expect(dialog).toBeVisible()
  // The title is what people believe. "needs permission" above a body that
  // opens with "Optional." is the dialog contradicting itself.
  await expect(dialog.locator('.app-modal-title')).toHaveText('Set up session file access')
  await expect(dialog).toContainText('/Applications/Walnut.app')
  await expect(dialog).toContainText('Full Disk Access')
  // The row is one line, so the guidance has to be here: what it buys, that
  // skipping it costs nothing, and why System Settings will show two
  // Walnut-ish entries for one permission.
  await expect(dialog).toContainText('Claude Code runs inside Walnut')
  await expect(dialog).toContainText('Skipping it costs nothing')
  await expect(dialog).toContainText('separately from the reader helper')
  // The numbered list is actions only — the explanation above is not step 1.
  await expect(dialog.locator('.permission-steps li').first()).toHaveText(/^Open System Settings/)
  // The grant target IS the app here, so the dialog must not call it a helper.
  await expect(dialog).toContainText('macOS checks this grant for Walnut itself')
  await expect(dialog).not.toContainText("Walnut's own helper")
  // And it must not promise a green that can never arrive.
  await expect(dialog).not.toContainText('turns green once granted')
  await expect(dialog).toContainText("keeps saying \"Can't be checked\"")
  await shot(dialog, 'setup-dialog')

  // The one action that replaces the terminal: it opens the pane and copies the
  // path on the MAC, so the user only drags or pastes.
  await dialog.getByRole('button', { name: 'Open System Settings' }).click()
  await expect.poll(() => opened).toContain('/api/permissions/session-full-disk-access/open-settings')

  // The other branch of the same sentence: a helper binary is still called a
  // helper, and a probe-able row still promises the green.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await readerRow.getByRole('button', { name: 'Fix…' }).click()
  await expect(dialog.locator('.app-modal-title')).toHaveText('Full Disk Access needs permission')
  await expect(dialog).toContainText("macOS checks this grant for Walnut's own helper")
  await expect(dialog).toContainText('turns green once granted')
})
