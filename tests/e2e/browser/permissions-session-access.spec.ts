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
      steps: [{ text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true }],
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
        { text: 'Open System Settings → Privacy & Security → Full Disk Access.', open: true },
        'Click + (authenticate if asked).',
        { text: 'Press ⌘⇧G, then paste:', copy: '/Applications/Walnut.app' },
        'Turn its toggle on. The popups stop — that is how you know.',
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
  // Each step owns its action: step 1 IS the opener, and it names the whole pane
  // path, which is also the only way back if the deep link ever fails. So there
  // is no second Open-Settings button at the bottom to wonder about, and no
  // separate path line above the list.
  await expect(dialog.locator('.permission-steps li')).toHaveCount(4)
  const openStep = dialog.locator('.permission-steps .permission-step-link')
  await expect(openStep).toHaveText('Open System Settings → Privacy & Security → Full Disk Access.')
  await expect(dialog.locator('.app-modal-actions button')).toHaveCount(1)
  await expect(dialog.locator('.app-modal-actions button')).toHaveText('Close')
  await expect(dialog.locator('.permission-grant-target')).toHaveCount(0)
  // The opener must be real inline text, not an atomic inline box. As a <button>
  // it could not wrap, so its baseline came from its last line and its first
  // line rendered ABOVE its own "1." marker — and every text assertion here
  // passed anyway, as did a bounding-box check (the <li> grows to contain it).
  expect(await openStep.evaluate((el) => getComputedStyle(el).display)).toBe('inline')
  expect(await openStep.evaluate((el) => el.tagName)).toBe('A')
  // The guidance is ONE CLICK away, not in the way: a user who already decided
  // to grant it reads one line and presses the button.
  await shot(dialog, 'setup-dialog')
  const why = dialog.locator('.permission-why')
  await expect(why).toContainText('Why this exists')
  const whyBody = why.locator('.permission-why-body')
  await expect(whyBody).toBeHidden()
  await why.locator('summary').click()
  await expect(whyBody).toBeVisible()
  await expect(whyBody).toContainText('Claude Code runs inside Walnut')
  await expect(whyBody).toContainText('Skipping it costs nothing')
  await expect(whyBody).toContainText('separately from the reader helper')
  await shot(dialog, 'setup-dialog-why-open')
  // The path is a copy control INSIDE the step that says to paste it, so what
  // you copied and what you paste are the same thing on screen.
  const copyStep = dialog.locator('.permission-steps li', { hasText: 'then paste' })
  await expect(copyStep.locator('.permission-copy code')).toHaveText('/Applications/Walnut.app')
  // And it must not promise a green that can never arrive.
  await expect(dialog).not.toContainText('turns green once granted')
  await expect(dialog).toContainText("macOS can't report this back")

  // Clicking the STEP is what opens the pane (and copies the path on the Mac):
  // the instruction and the control are one object.
  await openStep.click()
  await expect.poll(() => opened).toContain('/api/permissions/session-full-disk-access/open-settings')

  // The reader row is the same permission for a different identity, and it can
  // really be probed — so that one keeps the "turns green" promise, and its own
  // step carries its own opener.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await readerRow.getByRole('button', { name: 'Fix…' }).click()
  await expect(dialog.locator('.app-modal-title')).toHaveText('Full Disk Access needs permission')
  await expect(dialog).toContainText('turns green once granted')
  await expect(dialog.locator('.permission-steps .permission-step-link')).toHaveCount(1)
  // Wait out the overlay fade, or the evidence shot is a half-transparent dialog
  // over the page behind it and nothing in it can be judged.
  await expect(dialog).toHaveCSS('opacity', '1')
  await shot(dialog, 'reader-dialog')
})
