/**
 * Settings > Remote Hosts: every button and link on the pane, clicked, each with a result you
 * can see (2026-11-04, the user on Add host: "this button doesn't wrok can we make sure it
 * wroks?": it appended an empty row off screen, so a press looked like nothing happened).
 *
 * REGISTRY names every button the pane may show, by a stable key (data-testid, else a known
 * class, else role and accessible name, each host's name written `<host>`), with the check that
 * clicks it. The pane is swept after each step: a button the registry does not name fails the
 * run with its key, a registry key the run never saw fails it too, and so does a key whose
 * check never ran. Adding a button to the pane means adding its check here.
 *
 * SSH hosts are the server's host fixture (real status frames, real Retry, Check again and
 * Install). The rest is routed (remote-hosts-every-button-helpers.ts): nothing is saved to the
 * server's config, deleted, sent to a real host or started as an agent. Destructive buttons are
 * armed and then cancelled (Escape), or answered by the route. Navigation is by clicks. The
 * longer steps live in remote-hosts-every-button-steps.ts.
 *
 * Run: walnut-dev run env PW_WEBKIT=1 npx playwright test remote-hosts-every-button --project=webkit
 *      walnut-dev run npx playwright test remote-hosts-every-button --project=chromium-host-fixture
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fixtureCounters, hostFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import { armThenCancel, flip, isChromium, openFixturePane, paneKeys } from './remote-hosts-every-button-helpers'
import {
  ADD_ITEMS, checkAddHost, checkExecGrants, checkHostServers, checkJoinLink, checkMoreSettings, checkSecrets, checkSessionLimits, expectRing, type StepCtx,
} from './remote-hosts-every-button-steps'

test.setTimeout(300_000)
// A button that is not there fails in seconds, not at the end of the test's budget.
test.use({ actionTimeout: 15_000 })

/** Every button the pane may show, and the check that clicks it. `optional`: it depends on the engine. */
const REGISTRY: Record<string, { check: string; optional?: true }> = {
  'Header/button#remote-hosts-add': { check: 'a menu with the two ways in, under the button; each lands in view with its first control focused and ringed' },
  'Header/button#remote-hosts-copy-diagnostics': { check: 'reads /api/diagnostics; says Copied or why not' },
  'Overview/button#host-fleet-toggle': { check: 'folds and opens the Overview; opening reads every host again' },
  'Overview/button#host-fleet-refresh': { check: 'asks to read every host again; Refreshing... until the read ends' },
  'Overview/button#host-fleet-topo-node': { check: 'each node lands on its host\'s row in Hosts (this computer: its card), focused' },
  'Overview/button#host-fleet-details-toggle': { check: 'shows and hides each card\'s details, reading that host again' },
  'Overview/button#host-fleet-fix': { check: 'Setting up..., then the card says it is set up' },
  'Overview/button#host-fleet-connect': { check: 'Retrying..., then the host is a card that says Connected, holding the focus' },
  'Hosts/button:Remove <host>': { check: 'quiet until armed; Escape keeps the host; confirm on a new row or a machine takes it away and focuses the next row' },
  'Hosts/button:Edit': { check: 'opens the host\'s fields with its values (Done), and closes them' },
  'Hosts/switch:Use <host>': { check: 'flips and saves the host off, then on; a visible Use label beside it' },
  'Hosts/switch:Keep notes on <host>': { check: 'flips and saves keep.notes' },
  'Hosts/switch:Keep attachments on <host>': { check: 'flips and saves keep.attachments' },
  'Hosts/switch:Keep memory on <host>': { check: 'flips and saves keep.memory' },
  'Hosts/switch:Keep skills on <host>': { check: 'flips and saves keep.skills' },
  'Hosts/button#rh-found-not-now': { check: 'answers not_now; the question says Walnut does not connect' },
  'Hosts/button#rh-found-connect': { check: 'answers yes; the row becomes a host with its switch on' },
  'Hosts/button#host-profile-toggle-<host>': { check: 'under Edit: opens What Walnut knows (reads the profile and the host), closes it' },
  'Hosts/button:Kind of <host>': { check: 'opens the kinds; Escape gives the focus back; a pick is saved and shown' },
  'Hosts/button:Probe again': { check: 'asks for a probe; the new system line shows' },
  'Hosts/button.mic-btn': { check: 'unconfigured voice: takes you to Settings > Voice', optional: true },
  'Hosts/button.setup-copy-btn': { check: 'says Copied or Copy failed' },
  'Hosts/button.hc-other': { check: 'shows and hides the other commands' },
  'Hosts/button#rh-readiness-recheck': { check: 'Checking..., then Check again; the server checked once' },
  'Hosts/button#rh-readiness-fix-claude_missing': { check: 'asks for the install (agents: true); Installing..., then Installed' },
  'Hosts/button.rh-connect-btn': { check: 'Retry on a failed host and Connect now on a machine: Retrying..., then Connected' },
  'Hosts/button.hft-details': { check: 'shows and hides the failure details' },
  'Hosts/button.rh-show-again-btn': { check: 'the host\'s problem shows on the home page again' },
  'Hosts/radio#host-network-os-mac': { check: 'the Terminal command for a Mac (the default)' },
  'Hosts/radio#host-network-os-linux': { check: 'the terminal command for Linux' },
  'Hosts/radio#host-network-os-windows': { check: 'the Windows app and its link' },
  'Hosts/button#host-network-copy': { check: 'copies the command; Add host focuses it' },
  'Hosts/button#host-network-windows-link-copy': { check: 'copies the link' },
  'Hosts/button#host-network-windows-copy': { check: 'copies the PowerShell command (under More about this link)' },
  'Hosts/link:Walnut for Windows': { check: 'opens the download in a new tab' },
  'Hosts/button#host-network-more': { check: 'shows and hides the notes about the link' },
  'Hosts/button#host-network-new-link': { check: 'an expired link: makes a new one, its Copy focused' },
  'Pane/button#remote-hosts-more-toggle': { check: 'closed: says what is inside and how much needs a look; opens the groups' },
  'Relay/radio[relay=own]': { check: 'disabled without a companion, and says why' },
  'Relay/radio[relay=public]': { check: 'picked again: saved and checked' },
  'Relay/radio[relay=none]': { check: 'saved and checked' },
  'Walnut on a host/button#host-server-retry-<host>': { check: 'busy, then the host starts the new build' },
  'Walnut on a host/switch#host-server-enabled-<host>': { check: 'flips and saves off, then on' },
  'Walnut on a host/button#host-server-copies-toggle-<host>': { check: 'says how many kinds are copied; shows and hides the 11 switches' },
  'Walnut on a host/switch#host-server-copy-<host>-<kind>': { check: 'every copy switch flips and saves its kind, and back; the line counts it' },
  'Walnut on a host/switch#host-server-expose-<host>': { check: 'flips and saves the tunnel off, then on' },
  'Walnut on a host/link#host-server-url-<host>': { check: 'opens the host\'s address in a new tab' },
  'Walnut on a host/button#host-server-copy-url-<host>': { check: 'copies the address' },
  'Walnut on a host/button#host-server-tunnel-retry-<host>': { check: 'the tunnel starts again' },
  'Tasks using other hosts/switch:Tasks on other hosts may use <host>': { check: 'flips and saves the host closed (it says Off), then open' },
  'Tasks using other hosts/button:Revoke <task> on <host>': { check: 'revokes (routed); the grant goes' },
  'Tasks using other hosts/button:Allow <task> on <host>': { check: 'allows (routed); it becomes a grant' },
  'Secrets/button:Edit <secret>': { check: 'opens the editor on that secret' },
  'Secrets/button:Replace': { check: 'a value field, focused' },
  'Secrets/button.secret-toggle': { check: 'shows the typed value, hides it again' },
  'Secrets/button:Cancel': { check: 'closes the editor, saves nothing' },
  'Secrets/button#secret-add': { check: 'opens the editor for a new secret, Name focused' },
  'Secrets/button#secret-save': { check: 'refuses a blank name, and sessions without a variable, each under its field, focused; saves a valid one (routed)' },
  'Secrets/checkbox#secret-host-<host>': { check: 'ticks a host; the save copies to it' },
  'Secrets/checkbox#secret-sessions': { check: 'ticks; the save asks for the variable, then sends sessions: true' },
  'Secrets/button:Delete <secret>': { check: 'arms Confirm delete, Escape keeps it; confirm sends the DELETE (routed) and the row goes' },
  'Removals to confirm/button#replica-removal-confirm-host:<host>/notes': { check: 'arms Confirm remove, Escape sends nothing; confirm sends what the row read (routed) and the row waits' },
  'Session limits/button:Remove the limit for <host>': { check: 'the limit row goes and the limits save without it' },
  'Session limits/button:Add': { check: 'off until a host and a number are typed; adds the limit row and saves it' },
}

interface Ctx extends StepCtx { seen: Set<string>; ranKeys: Set<string> }

const unknownKeys = (keys: string[]) => keys.filter((k) => !(k in REGISTRY))

const pane = (page: Page) => page.locator('#remote-hosts')

async function setUp(page: Page, request: APIRequestContext): Promise<Ctx> {
  const routes = await openFixturePane(page, request)
  const seen = new Set<string>()
  const ranKeys = new Set<string>()
  return {
    page, request, routes, seen, ranKeys,
    // Every button on the pane now must be in REGISTRY.
    sweep: async () => {
      const keys = await paneKeys(page)
      const unknown = unknownKeys(keys)
      expect(unknown, `buttons on Settings > Remote Hosts with no check in REGISTRY: ${unknown.join(', ')}`).toEqual([])
      for (const k of keys) seen.add(k)
    },
    ran: (...keys: string[]) => {
      for (const k of keys) {
        if (!(k in REGISTRY)) throw new Error(`ran() names a key REGISTRY does not have: ${k}`)
        ranKeys.add(k)
      }
    },
  }
}

test.describe('Settings > Remote Hosts: every button', () => {
  // Both tests load the server's one host fixture: never two at once (the webkit project has no workers: 1).
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('every button and link on the pane does something you can see', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const ctx = await setUp(page, request)
    const { routes, sweep, ran } = ctx
    await sweep()

    await test.step('header: Add host and Copy diagnostics', async () => {
      await checkAddHost(ctx)
      const diag = page.locator('[data-testid="remote-hosts-copy-diagnostics"]:visible').first()
      await expect(diag).toHaveText('Copy diagnostics')
      const read = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/diagnostics')
      await diag.click()
      await read
      await expect(diag.filter({ hasText: 'Copied' }).or(page.locator('.settings-copy-diagnostics-error:visible'))).toBeVisible({ timeout: 20_000 })
      ran('Header/button#remote-hosts-copy-diagnostics')
    })

    await test.step('Overview', async () => {
      const toggle = page.getByTestId('host-fleet-toggle')
      const reads = () => routes.callsTo('POST', '/api/v1/hosts/refresh').length
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(page.getByTestId('host-fleet-summary')).toHaveCount(0)
      const n = reads()
      await toggle.click()
      await expect(page.getByTestId('host-fleet-summary')).toBeVisible()
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', n + 1)).body).toEqual({})
      // The read the opening started runs a moment (Refreshing...), then Refresh is back.
      const refresh = page.getByTestId('host-fleet-refresh')
      await expect(refresh).toBeVisible({ timeout: 10_000 })
      await refresh.click()
      await expect(page.getByTestId('host-fleet-refreshing')).toHaveText('Refreshing...')
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', n + 2)).body).toEqual({})
      await expect(refresh).toBeVisible({ timeout: 10_000 })
      ran('Overview/button#host-fleet-toggle', 'Overview/button#host-fleet-refresh')

      // A node lands on its host's row in Hosts (the card was already in view); this computer has no row.
      const nodes = page.getByTestId('host-fleet-topo-node')
      const hosts = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('data-host')!))
      expect(hosts.length).toBeGreaterThanOrEqual(3)
      for (const host of hosts) {
        await page.locator(`[data-testid="host-fleet-topo-node"][data-host="${host}"]`).click()
        const row = page.locator(`[id="rh-host-${host}"]`)
        const target = (await row.count()) ? row : page.locator(`[id="hf-card-${host}"]`)
        await expectRing(page, target)
        await expect(target).toBeInViewport()
      }
      await expect(page.locator('[id="rh-host-devbox"]')).toHaveCount(1)
      ran('Overview/button#host-fleet-topo-node')

      for (const host of ['__local__', 'devbox', 'farbox']) {
        const box = page.locator(`[id="hf-card-${host}"]`)
        const t = box.getByTestId('host-fleet-details-toggle')
        const before = reads()
        await t.click()
        await expect(t).toHaveText('Hide details')
        await expect(box.getByTestId('host-fleet-details')).toBeVisible()
        expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 1)).body).toEqual({ hosts: [host] })
      }
      await sweep()
      for (const host of ['__local__', 'devbox', 'farbox']) {
        const box = page.locator(`[id="hf-card-${host}"]`)
        await box.getByTestId('host-fleet-details-toggle').click()
        await expect(box.getByTestId('host-fleet-details')).toHaveCount(0)
      }
      ran('Overview/button#host-fleet-details-toggle')

      const alpha = page.locator('[id="hf-card-devbox"]')
      const fix = alpha.getByTestId('host-fleet-fix')
      await expect(fix).toHaveText('Set up')
      const releaseBoot = routes.gate('boot')
      await fix.click()
      await expect(fix).toHaveText('Setting up...')
      releaseBoot()
      await expect(alpha.getByTestId('host-fleet-problem')).toHaveCount(0)
      await expect(alpha.getByTestId('host-fleet-action-note')).toHaveText('Set up: starts by itself after a reboot (as a systemd user service).')
      expect(routes.callsTo('POST', '/api/v1/hosts/devbox/boot-start')).toHaveLength(1)
      ran('Overview/button#host-fleet-fix')

      // Far box's last try failed: Retry, the host's one connect attempt (the Hosts list's words).
      // Once it answers, the host is live: its card says so and takes the focus the row had.
      const connect = page.locator('[data-testid="host-fleet-offline"][data-host="farbox"]').getByTestId('host-fleet-connect')
      await expect(connect).toHaveText('Retry')
      await expect(connect).toHaveClass(/rh-connect-btn/)
      const releaseConnect = routes.gate('connect:farbox')
      await connect.click()
      await expect(connect).toHaveText('Retrying...')
      releaseConnect()
      const far = page.locator('[data-testid="host-fleet-card"][data-host="farbox"]')
      await expect(far).toBeVisible({ timeout: 10_000 })
      await expect(far.getByTestId('host-fleet-action-note')).toHaveText('Connected.')
      await expect(page.locator('[data-testid="host-fleet-offline"][data-host="farbox"]')).toHaveCount(0)
      await expectRing(page, far)
      expect(routes.callsTo('POST', '/api/hosts/farbox/connect')).toHaveLength(1)
      ran('Overview/button#host-fleet-connect')
    })

    await test.step('Hosts: Edit, keep switches, Use, Remove', async () => {
      const alpha = page.locator('#rh-host-devbox')
      // Found by its place: its name is Edit, then Done.
      const edit = alpha.locator('button.settings-button[aria-expanded]')
      await expect(edit).toHaveText('Edit')
      await expect(page.getByTestId('host-profile-toggle-devbox')).toHaveCount(0)
      await edit.click()
      await expect(edit).toHaveText('Done')
      await expect(edit).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('input[id^="rh-alias-"]')).toHaveValue('devbox')
      await expect(page.locator('input[id^="rh-hostname-"]')).toHaveValue('alpha.example.com')
      await sweep()
      for (const what of ['notes', 'attachments', 'memory', 'skills'] as const) {
        const sw = pane(page).getByRole('switch', { name: `Keep ${what} on Alpha box` })
        const base = routes.callsTo('PUT', '/api/config').length
        let k = 0
        await flip(sw, async (on) => {
          const put = await routes.nth('PUT', '/api/config', base + ++k)
          expect((put.body as { hosts: Record<string, { keep?: unknown }> }).hosts.devbox.keep).toEqual(on ? undefined : { [what]: false })
        })
        ran(`Hosts/switch:Keep ${what} on <host>`)
      }
      await edit.click()
      await expect(edit).toHaveText('Edit')
      await expect(page.locator('input[id^="rh-alias-"]')).toHaveCount(0)
      ran('Hosts/button:Edit')

      await expect(alpha.locator('.rh-use-label')).toHaveText('Use')
      const use = alpha.getByRole('switch', { name: 'Use Alpha box' })
      const base = routes.callsTo('PUT', '/api/config').length
      let k = 0
      await flip(use, async (on) => {
        const put = await routes.nth('PUT', '/api/config', base + ++k)
        expect((put.body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(on)
      })
      ran('Hosts/switch:Use <host>')
      const remove = alpha.locator('button[data-armed]')
      await expect(remove).toHaveClass(/settings-button-text/)
      await armThenCancel(routes, remove, 'Remove', 'Confirm remove')
      await expect(alpha).toBeVisible()
    })

    await test.step('Hosts: an alias another host has is refused, and nothing is saved over it', async () => {
      const puts = routes.callsTo('PUT', '/api/config').length
      await page.locator('[data-testid="remote-hosts-add"]:visible').first().click()
      await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
      const alias = page.locator('input[id^="rh-alias-"]')
      await alias.fill('devbox')
      await page.locator('input[id^="rh-hostname-"]').fill('dup.example.com')
      const refusal = pane(page).locator('.settings-row-error', { hasText: 'devbox is already Alpha box. Pick another alias.' })
      await expect(refusal).toBeVisible()
      await expect(alias).toHaveAttribute('aria-invalid', 'true')
      await expect(pane(page).locator('.rh-host-row:not([data-host-alias])')).toContainText('Not saved until it has an alias of its own.')
      // Alpha box keeps its row (and its status): one row has its id.
      await expect(page.locator('[id="rh-host-devbox"]')).toHaveCount(1)
      await expect(page.locator('#rh-host-devbox')).toContainText('alpha.example.com')
      // Three times the autosave's wait: nothing went out.
      await page.waitForTimeout(1_800)
      expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)

      await alias.fill('labbox')
      await expect(refusal).toHaveCount(0)
      const saved = (await routes.nth('PUT', '/api/config', puts + 1)).body as { hosts: Record<string, Record<string, unknown>> }
      expect(saved.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
      expect(saved.hosts.labbox).toMatchObject({ hostname: 'dup.example.com' })
      const row = page.locator('[data-host-alias="labbox"]')
      const remove = row.locator('button[data-armed]')
      await remove.click()
      await remove.click()
      await expect(row).toHaveCount(0)
      const after = (await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, Record<string, unknown>> }
      expect(Object.keys(after.hosts)).not.toContain('labbox')
      expect(after.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
    })

    await test.step('Hosts: a host found in ~/.ssh/config', async () => {
      const lab = page.locator('#rh-host-lab-mac')
      const q = lab.getByTestId('rh-found-question')
      await expect(q).toHaveText('Walnut found lab-mac in ~/.ssh/config. Connect to it?')
      await lab.getByTestId('rh-found-not-now').click()
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 1)).body).toEqual({ answer: 'not_now' })
      await expect(q).toHaveText('Found in ~/.ssh/config. Walnut does not connect to it.')
      await expect(lab.getByTestId('rh-found-not-now')).toHaveCount(0)
      await sweep()
      await lab.getByTestId('rh-found-connect').click()
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 2)).body).toEqual({ answer: 'yes' })
      await expect(q).toHaveCount(0)
      await expect(lab.getByRole('switch', { name: 'Use lab-mac' })).toHaveAttribute('aria-checked', 'true')
      ran('Hosts/button#rh-found-not-now', 'Hosts/button#rh-found-connect')
    })

    await test.step('Hosts: What Walnut knows (under Edit)', async () => {
      const edit = page.locator('#rh-host-devbox button.settings-button[aria-expanded]')
      await edit.click()
      const toggle = page.getByTestId('host-profile-toggle-devbox')
      const before = routes.callsTo('POST', '/api/v1/hosts/refresh').length
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const body = page.getByTestId('host-profile-devbox')
      await expect(body.getByTestId('host-profile-system')).toHaveText('Ubuntu 24.04 · x64 · 16 CPUs · 64 GB memory · 200 GB free')
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 1)).body).toEqual({ hosts: ['devbox'] })
      await sweep()
      const kind = body.getByRole('button', { name: 'Kind of Alpha box' })
      await expect(kind).toHaveText('Dev box (automatic) ▾')
      const list = page.getByRole('listbox', { name: 'Kind of Alpha box' })
      await kind.click()
      await expect(list).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(list).toHaveCount(0)
      await expectRing(page, kind)
      await kind.click()
      await expect(list.getByRole('option')).toHaveText(['Automatic', 'Laptop', 'Cloud VM (public)', 'Cloud VM (private)', 'Dev box', 'Unknown'].map((t) => new RegExp(`${t.replace(/[()]/g, '\\$&')}$`)))
      await list.getByRole('option', { name: /Laptop$/ }).click()
      await expect(list).toHaveCount(0)
      expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 1)).body).toEqual({ kind: 'laptop' })
      await expect(kind).toHaveText('Laptop ▾')
      await expect(kind).toBeFocused()
      await body.getByRole('button', { name: 'Probe again' }).click()
      expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 2)).body).toEqual({ refresh: true })
      await expect(body.getByTestId('host-profile-system')).toContainText('32 CPUs')
      await toggle.click()
      await expect(body).toHaveCount(0)
      await edit.click()
      await expect(toggle).toHaveCount(0)
      ran('Hosts/button#host-profile-toggle-<host>', 'Hosts/button:Kind of <host>', 'Hosts/button:Probe again')
    })

    await test.step('Hosts: a failed host (details, Show again, Retry)', async () => {
      const beta = page.locator('#rh-host-downbox')
      const details = beta.locator('button.hft-details')
      await details.click()
      await expect(details).toHaveAttribute('aria-expanded', 'true')
      await expect(beta.locator('.hft-more')).toContainText('Connection timed out')
      await details.click()
      await expect(beta.locator('.hft-more')).toHaveCount(0)
      ran('Hosts/button.hft-details')

      await expect(beta.locator('.rh-banner-hidden')).toContainText('You hid this problem on the home page.')
      await beta.locator('button.rh-show-again-btn').click()
      await expect(beta.locator('.rh-banner-hidden')).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('open-walnut-host-banner-dismissed') ?? '')).not.toContain('downbox')
      ran('Hosts/button.rh-show-again-btn')

      await hostFixture(request, { action: 'set-next-connect', host: 'downbox', result: 'ok' })
      const retry = beta.locator('button.rh-connect-btn')
      await expect(retry).toHaveText('Retry')
      const tries = (await fixtureCounters(request)).connect.downbox ?? 0
      await retry.click()
      await expect(beta.locator('.rh-status-short')).toHaveText('Connected', { timeout: 15_000 })
      expect((await fixtureCounters(request)).connect.downbox).toBe(tries + 1)
    })

    await test.step('Hosts: Claude Code is missing (Copy, Other ways, Check again, Install)', async () => {
      const block = page.locator('.rh-readiness-block[data-host="devbox"]')
      const copy = block.locator('button.setup-copy-btn').first()
      await copy.click()
      await expect(copy).toHaveAccessibleName(/^(Copied|Copy failed)$/)
      const other = block.locator('button.hc-other')
      await other.click()
      await expect(other).toHaveAttribute('aria-expanded', 'true')
      await expect(block.locator('.hc-other-list')).toContainText('npm install -g @anthropic-ai/claude-code')
      await sweep()
      await other.click()
      await expect(block.locator('.hc-other-list')).toHaveCount(0)
      ran('Hosts/button.setup-copy-btn', 'Hosts/button.hc-other')

      const check = block.getByTestId('rh-readiness-recheck')
      const checks = (await fixtureCounters(request)).check.devbox ?? 0
      await check.click()
      await expect(check).toHaveText('Checking...')
      await expect(check).toHaveText('Check again', { timeout: 10_000 })
      expect((await fixtureCounters(request)).check.devbox).toBe(checks + 1)
      ran('Hosts/button#rh-readiness-recheck')

      // Installing..., and then where it ended: Installed (the server's fix note), the problem gone.
      const install = block.getByTestId('rh-readiness-fix-claude_missing')
      await expect(install).toHaveText('Install')
      const asked = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith('/api/hosts/devbox/connect'))
      await install.click()
      expect((await asked).postDataJSON()).toEqual({ agents: true })
      await expect(page.locator('#rh-host-devbox')).toContainText('Installing Claude Code on Alpha box')
      await expect(block.locator('.rh-readiness-note')).toContainText('Installed Claude Code', { timeout: 20_000 })
      await expect(install).toHaveCount(0)
      await expect(page.locator('#rh-host-devbox')).not.toContainText('Installing Claude Code')
      ran('Hosts/button#rh-readiness-fix-claude_missing')
    })

    await test.step('Hosts: the join link, and a machine that joined with one', async () => {
      await checkJoinLink(ctx)
      const gpu = page.locator('[data-row-key="net:gpu-box"]')
      await expect(gpu).toContainText('Link')
      const connectNow = gpu.locator('button.rh-connect-btn')
      await expect(connectNow).toHaveText('Connect now')
      const release = routes.gate('connect:gpu-box')
      await connectNow.click()
      await expect(connectNow).toHaveText('Retrying...')
      release()
      await expect(gpu.locator('.rh-status-short')).toHaveText('Connected')
      ran('Hosts/button.rh-connect-btn')
      const remove = gpu.locator('button[data-armed]')
      await armThenCancel(routes, remove, 'Remove', 'Confirm remove')
      await expect(gpu).toBeVisible()
      await remove.click()
      await remove.click()
      await routes.nth('DELETE', '/api/hosts/net/machines/gpu-box', 1)
      await expect(gpu).toHaveCount(0)
      // The focus goes to the row before it, never to the page.
      await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^ssh:/)
    })

    await test.step('More settings: Relay', async () => { await checkMoreSettings(ctx) })
    await test.step('More settings: Walnut on a host', async () => { await checkHostServers(ctx) })
    await test.step('More settings: Tasks using other hosts', async () => { await checkExecGrants(ctx) })
    await test.step('More settings: Secrets', async () => { await checkSecrets(ctx) })

    await test.step('Removals to confirm', async () => {
      const confirm = page.getByTestId('replica-removal-confirm-host:devbox/notes')
      await armThenCancel(routes, confirm, 'Remove them there', 'Confirm remove')
      await confirm.click()
      await confirm.click()
      expect((await routes.nth('POST', '/api/replicas/confirm-removal', 1)).body).toEqual({ target: 'host:devbox', kind: 'notes', entries: 80, keys: 'k80' })
      await expect(page.getByTestId('replica-removal-host:devbox/notes')).toHaveAttribute('data-removal', 'armed')
      await expect(confirm).toHaveCount(0)
      ran('Removals to confirm/button#replica-removal-confirm-host:<host>/notes')
    })

    await test.step('More settings: Session limits', async () => { await checkSessionLimits(ctx) })

    await test.step('Hosts: the note\'s mic (last: it leaves the pane)', async () => {
      await page.locator('#rh-host-devbox button.settings-button[aria-expanded]').click()
      await page.getByTestId('host-profile-toggle-devbox').click()
      const mic = page.getByTestId('host-profile-devbox').locator('button.mic-btn')
      await expect(page.getByTestId('host-profile-system')).toBeVisible()
      // Linux WebKit has no recorder, so no mic; Chromium must show it.
      if (isChromium(page)) await expect(mic).toHaveCount(1)
      else if (await mic.count() === 0) return
      await sweep()
      await expect(mic).toHaveAttribute('aria-label', 'Set up dictation')
      await mic.click()
      await expect.poll(() => new URL(page.url()).hash).toBe('#stt')
      ran('Hosts/button.mic-btn')
    })

    await test.step('every button seen has a check that ran, and every registered button was seen', async () => {
      const unseen = Object.keys(REGISTRY).filter((k) => !REGISTRY[k].optional && !ctx.seen.has(k))
      expect(unseen, `REGISTRY names buttons the pane never showed: ${unseen.join(', ')}`).toEqual([])
      const unchecked = [...ctx.seen].filter((k) => !ctx.ranKeys.has(k))
      expect(unchecked, `buttons seen whose check never ran: ${unchecked.join(', ')}`).toEqual([])
      const skipped = Object.keys(REGISTRY).filter((k) => !ctx.ranKeys.has(k))
      console.log(`[remote-hosts-every-button] ${ctx.ranKeys.size} of ${Object.keys(REGISTRY).length} keys checked${skipped.length ? `; not shown in this engine: ${skipped.join(', ')}` : ''}`)
      expect(errors).toEqual([])
    })
  })

  test('Add host lands each way in view and focused, on a short window, again and again; the sweep names a new button', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 640 })
    const ctx = await setUp(page, request)
    for (let round = 1; round <= 2; round++) {
      await page.locator('#remote-hosts').evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await checkAddHost(ctx)
    }
    // The guard: a button nobody registered is named, so a new one cannot slip in unchecked; a
    // Cancel in Hosts is not the Secrets editor's Cancel (keys are scoped by their group).
    const plant = (where: ReturnType<Page['locator']>, text: string) => where.evaluate((el, t) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = t
      el.appendChild(b)
    }, text)
    await plant(pane(page).locator('.settings-card-body').first(), 'Mystery')
    await plant(page.locator('.settings-group-block').filter({ has: page.locator('.settings-group-title', { hasText: /^Hosts$/ }) }).locator('.settings-group').first(), 'Cancel')
    expect(unknownKeys(await paneKeys(page)).sort()).toEqual(['Hosts/button:Cancel', 'Pane/button:Mystery'])
  })
})
