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
 * armed and then cancelled (Escape), or answered by the route. Navigation is by clicks.
 *
 * Run: walnut-dev run env PW_WEBKIT=1 npx playwright test remote-hosts-every-button --project=webkit
 *      walnut-dev run npx playwright test remote-hosts-every-button --project=chromium-host-fixture
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fixtureCounters, hostFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import {
  ALPHA_URL, PaneRoutes, WINDOWS_APP, armThenCancel, expectCopied, expectOpensTab, flip, isChromium, netCommand, netLink, netWindows,
  openFixturePane, paneKeys, shot,
} from './remote-hosts-every-button-helpers'

test.setTimeout(300_000)
// A button that is not there fails in seconds, not at the end of the test's budget.
test.use({ actionTimeout: 15_000 })

/** Every button the pane may show, and the check that clicks it. `optional`: it depends on the engine. */
const REGISTRY: Record<string, { check: string; optional?: true }> = {
  'Header/button#remote-hosts-add': { check: 'a menu with the two ways in; each lands in view with its first control focused' },
  'Header/button#remote-hosts-copy-diagnostics': { check: 'reads /api/diagnostics; says Copied or why not' },
  'Overview/button#host-fleet-toggle': { check: 'folds and opens the Overview; opening reads every host again' },
  'Overview/button#host-fleet-refresh': { check: 'asks to read every host again' },
  'Overview/button#host-fleet-topo-node': { check: 'each node focuses its host card' },
  'Overview/button#host-fleet-details-toggle': { check: 'shows and hides each card\'s details, reading that host again' },
  'Overview/button#host-fleet-fix': { check: 'Setting up..., then the card reads as fixed' },
  'Overview/button#host-fleet-connect': { check: 'Connecting..., then reads that host again' },
  'Hosts/button:Remove <host>': { check: 'arms Confirm remove, Escape keeps the host; on a new empty row, confirm takes it away' },
  'Hosts/button:Edit': { check: 'opens the host\'s fields with its values (Done), and closes them' },
  'Hosts/switch:Use <host>': { check: 'flips and saves the host off, then on' },
  'Hosts/switch:Keep notes on <host>': { check: 'flips and saves keep.notes' },
  'Hosts/switch:Keep attachments on <host>': { check: 'flips and saves keep.attachments' },
  'Hosts/switch:Keep memory on <host>': { check: 'flips and saves keep.memory' },
  'Hosts/switch:Keep skills on <host>': { check: 'flips and saves keep.skills' },
  'Hosts/button#rh-found-not-now': { check: 'answers not_now; the question says Walnut does not connect' },
  'Hosts/button#rh-found-connect': { check: 'answers yes; the row becomes a host with its switch on' },
  'Hosts/button#host-profile-toggle-<host>': { check: 'opens What Walnut knows (reads the profile and the host), closes it' },
  'Hosts/button:Kind of <host>': { check: 'opens the kinds; a pick is saved and shown' },
  'Hosts/button:Probe again': { check: 'asks for a probe; the new system line shows' },
  'Hosts/button.mic-btn': { check: 'unconfigured voice: takes you to Settings > Voice', optional: true },
  'Hosts/button.setup-copy-btn': { check: 'says Copied or Copy failed' },
  'Hosts/button.hc-other': { check: 'shows and hides the other commands' },
  'Hosts/button#rh-readiness-recheck': { check: 'Checking..., then Check again; the server checked once' },
  'Hosts/button#rh-readiness-fix-claude_missing': { check: 'asks for the install (agents: true); Installing..., then the line goes' },
  'Hosts/button.rh-connect-btn': { check: 'Retry on a failed host: the server connects it once, the line says Connected' },
  'Hosts/button.hft-details': { check: 'shows and hides the failure details' },
  'Hosts/button.rh-show-again-btn': { check: 'the host is no longer hidden from the banner' },
  'Machines/button#host-network-add': { check: 'makes a new link, shown with its command' },
  'Machines/button#host-network-copy': { check: 'copies the command' },
  'Machines/button#host-network-windows-copy': { check: 'copies the PowerShell command' },
  'Machines/button#host-network-windows-link-copy': { check: 'copies the link' },
  'Machines/link:Walnut for Windows': { check: 'opens the download in a new tab' },
  'Machines/button:Remove <host>': { check: 'arms Confirm remove, Escape keeps it; confirm sends the DELETE (routed) and the row goes' },
  'Machines/button.rh-connect-btn': { check: 'Connect now on a machine with no status yet: Retrying..., then Connected' },
  'Relay/radio[relay=own]': { check: 'disabled without a companion, and says why' },
  'Relay/radio[relay=public]': { check: 'picked again: saved and checked' },
  'Relay/radio[relay=none]': { check: 'saved and checked' },
  'Walnut on a host/button#host-server-retry-<host>': { check: 'busy, then the host starts the new build' },
  'Walnut on a host/switch#host-server-enabled-<host>': { check: 'flips and saves off, then on' },
  'Walnut on a host/switch#host-server-copy-<host>-<kind>': { check: 'every copy switch flips and saves its kind, and back' },
  'Walnut on a host/switch#host-server-expose-<host>': { check: 'flips and saves the tunnel off, then on' },
  'Walnut on a host/link#host-server-url-<host>': { check: 'opens the host\'s address in a new tab' },
  'Walnut on a host/button#host-server-copy-url-<host>': { check: 'copies the address' },
  'Walnut on a host/button#host-server-tunnel-retry-<host>': { check: 'the tunnel starts again' },
  'Tasks using other hosts/switch:Tasks on other hosts may use <host>': { check: 'flips and saves the host closed, then open' },
  'Tasks using other hosts/button:Revoke <task> on <host>': { check: 'revokes (routed); the grant goes' },
  'Tasks using other hosts/button:Allow <task> on <host>': { check: 'allows (routed); it becomes a grant' },
  'Secrets/button:Edit <secret>': { check: 'opens the editor on that secret' },
  'Secrets/button:Replace': { check: 'a value field, focused' },
  'Secrets/button.secret-toggle': { check: 'shows the typed value, hides it again' },
  'Secrets/button:Cancel': { check: 'closes the editor, saves nothing' },
  'Secrets/button#secret-add': { check: 'opens the editor for a new secret' },
  'Secrets/button#secret-save': { check: 'refuses a blank name, and sessions without a variable, each with a reason; saves a valid one (routed)' },
  'Secrets/checkbox#secret-host-<host>': { check: 'ticks a host; the save copies to it' },
  'Secrets/checkbox#secret-sessions': { check: 'ticks; the save asks for the variable, then sends sessions: true' },
  'Secrets/button:Delete <secret>': { check: 'arms Confirm delete, Escape keeps it; confirm sends the DELETE (routed) and the row goes' },
  'Copies that held off/button#replica-removal-confirm-host:<host>/notes': { check: 'arms Confirm remove, Escape sends nothing; confirm sends what the row read (routed) and the row waits' },
  'Session limits/button:Remove the limit for <host>': { check: 'the limit row goes and the limits save without it' },
  'Session limits/button:Add': { check: 'off until a host and a number are typed; adds the limit row and saves it' },
}

interface Ctx { page: Page; request: APIRequestContext; routes: PaneRoutes; seen: Set<string>; ran: Set<string> }

const unknownKeys = (keys: string[]) => keys.filter((k) => !(k in REGISTRY))

/** Every button on the pane now must be in REGISTRY. */
async function sweep(ctx: Ctx): Promise<void> {
  const keys = await paneKeys(ctx.page)
  const unknown = unknownKeys(keys)
  expect(unknown, `buttons on Settings > Remote Hosts with no check in REGISTRY: ${unknown.join(', ')}`).toEqual([])
  for (const k of keys) ctx.seen.add(k)
}

function ran(ctx: Ctx, ...keys: string[]): void {
  for (const k of keys) {
    if (!(k in REGISTRY)) throw new Error(`ran() names a key REGISTRY does not have: ${k}`)
    ctx.ran.add(k)
  }
}

const pane = (page: Page) => page.locator('#remote-hosts')

async function setUp(page: Page, request: APIRequestContext): Promise<Ctx> {
  return { page, request, routes: await openFixturePane(page, request), seen: new Set(), ran: new Set() }
}

/** Add host: a menu with two ways in, each landing in view on its first control. */
async function checkAddHost(ctx: Ctx): Promise<void> {
  const { page, routes } = ctx
  // The pane header's, or the sticky bar's once the pane scrolled (the same button, moved).
  const add = page.locator('[data-testid="remote-hosts-add"]:visible').first()
  const menu = page.getByTestId('remote-hosts-add-menu')
  await add.click()
  await expect(menu).toBeVisible()
  await expect(add).toHaveAttribute('aria-expanded', 'true')
  await expect(menu.getByRole('menuitem')).toHaveText(['A machine, with a one-line command (no SSH)', 'An SSH host'])
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(add).toBeFocused()

  const n = routes.invites + 1
  await add.click()
  await menu.getByRole('menuitem', { name: 'A machine, with a one-line command (no SSH)' }).click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n))
  await expect(page.getByTestId('host-network-invite')).toBeInViewport()
  await expect(page.getByTestId('host-network-copy')).toBeFocused()
  expect(routes.invites).toBe(n)
  await shot(page, `add-host-join-${page.viewportSize()!.height}`)

  const puts = routes.callsTo('PUT', '/api/config').length
  await add.click()
  await menu.getByRole('menuitem', { name: 'An SSH host' }).click()
  const alias = page.locator('input[id^="rh-alias-"]')
  await expect(alias).toHaveCount(1)
  await expect(alias).toHaveValue('')
  await expect(alias).toBeFocused()
  await expect(alias).toBeInViewport()
  const draft = pane(page).locator('.rh-host-row').filter({ hasText: 'Add an alias and hostname to save this host.' })
  await expect(draft).toHaveCount(1)
  await sweep(ctx)
  await shot(page, `add-host-ssh-row-${page.viewportSize()!.height}`)
  // The empty row goes again with Remove's confirm, and nothing was saved for it.
  const remove = draft.locator('button[data-armed]')
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  await remove.click()
  await expect(draft).toHaveCount(0)
  await expect(alias).toHaveCount(0)
  expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)
  ran(ctx, 'Header/button#remote-hosts-add', 'Hosts/button:Remove <host>')
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
    const { routes } = ctx
    await sweep(ctx)

    await test.step('header: Add host and Copy host diagnostics', async () => {
      await checkAddHost(ctx)
      const diag = page.locator('[data-testid="remote-hosts-copy-diagnostics"]:visible').first()
      const read = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/diagnostics')
      await diag.click()
      await read
      await expect(diag.filter({ hasText: 'Copied' }).or(page.locator('.settings-copy-diagnostics-error:visible'))).toBeVisible({ timeout: 20_000 })
      ran(ctx, 'Header/button#remote-hosts-copy-diagnostics')
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
      const refresh = page.getByTestId('host-fleet-refresh')
      await refresh.click()
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', n + 2)).body).toEqual({})
      ran(ctx, 'Overview/button#host-fleet-toggle', 'Overview/button#host-fleet-refresh')

      const nodes = page.getByTestId('host-fleet-topo-node')
      const hosts = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('data-host')!))
      expect(hosts.length).toBeGreaterThanOrEqual(3)
      for (const host of hosts) {
        await page.locator(`[data-testid="host-fleet-topo-node"][data-host="${host}"]`).click()
        await expect(page.locator(`[id="hf-card-${host}"]`)).toBeFocused()
        await expect(page.locator(`[id="hf-card-${host}"]`)).toBeInViewport()
      }
      ran(ctx, 'Overview/button#host-fleet-topo-node')

      for (const host of ['__local__', 'devbox', 'farbox']) {
        const box = page.locator(`[id="hf-card-${host}"]`)
        const t = box.getByTestId('host-fleet-details-toggle')
        const before = reads()
        await t.click()
        await expect(t).toHaveText('Hide details')
        await expect(box.getByTestId('host-fleet-details')).toBeVisible()
        expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 1)).body).toEqual({ hosts: [host] })
      }
      await sweep(ctx)
      for (const host of ['__local__', 'devbox', 'farbox']) {
        const box = page.locator(`[id="hf-card-${host}"]`)
        await box.getByTestId('host-fleet-details-toggle').click()
        await expect(box.getByTestId('host-fleet-details')).toHaveCount(0)
      }
      ran(ctx, 'Overview/button#host-fleet-details-toggle')

      const alpha = page.locator('[id="hf-card-devbox"]')
      const fix = alpha.getByTestId('host-fleet-fix')
      await expect(fix).toHaveText('Set up')
      const releaseBoot = routes.gate('boot')
      await fix.click()
      await expect(fix).toHaveText('Setting up...')
      releaseBoot()
      await expect(alpha.getByTestId('host-fleet-problem')).toHaveCount(0)
      expect(routes.callsTo('POST', '/api/v1/hosts/devbox/boot-start')).toHaveLength(1)
      ran(ctx, 'Overview/button#host-fleet-fix')

      const connect = page.locator('[data-testid="host-fleet-offline"][data-host="farbox"]').getByTestId('host-fleet-connect')
      const releaseConnect = routes.gate('connect:farbox')
      const before = reads()
      await connect.click()
      await expect(connect).toHaveText('Connecting...')
      releaseConnect()
      await expect(connect).toHaveText('Connect')
      expect(routes.callsTo('POST', '/api/hosts/farbox/connect')).toHaveLength(1)
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 1)).body).toEqual({ hosts: ['farbox'] })
      // It reads that host once more 5 s later, when the link should be up: wait for it here, so it
      // never lands inside a later step's "nothing was sent" window.
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 2)).body).toEqual({ hosts: ['farbox'] })
      ran(ctx, 'Overview/button#host-fleet-connect')
    })

    await test.step('Hosts: Edit, keep switches, Use, Remove', async () => {
      const alpha = page.locator('#rh-host-devbox')
      // Found by its place: its name is Edit, then Done.
      const edit = alpha.locator('button.settings-button[aria-expanded]')
      await expect(edit).toHaveText('Edit')
      await edit.click()
      await expect(edit).toHaveText('Done')
      await expect(edit).toHaveAttribute('aria-expanded', 'true')
      await expect(page.locator('input[id^="rh-alias-"]')).toHaveValue('devbox')
      await expect(page.locator('input[id^="rh-hostname-"]')).toHaveValue('alpha.example.com')
      await sweep(ctx)
      for (const what of ['notes', 'attachments', 'memory', 'skills'] as const) {
        const sw = pane(page).getByRole('switch', { name: `Keep ${what} on Alpha box` })
        const base = routes.callsTo('PUT', '/api/config').length
        let k = 0
        await flip(sw, async (on) => {
          const put = await routes.nth('PUT', '/api/config', base + ++k)
          expect((put.body as { hosts: Record<string, { keep?: unknown }> }).hosts.devbox.keep).toEqual(on ? undefined : { [what]: false })
        })
        ran(ctx, `Hosts/switch:Keep ${what} on <host>`)
      }
      await edit.click()
      await expect(edit).toHaveText('Edit')
      await expect(page.locator('input[id^="rh-alias-"]')).toHaveCount(0)
      ran(ctx, 'Hosts/button:Edit')

      const use = alpha.getByRole('switch', { name: 'Use Alpha box' })
      const base = routes.callsTo('PUT', '/api/config').length
      let k = 0
      await flip(use, async (on) => {
        const put = await routes.nth('PUT', '/api/config', base + ++k)
        expect((put.body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(on)
      })
      ran(ctx, 'Hosts/switch:Use <host>')
      await armThenCancel(routes, alpha.locator('button[data-armed]'), 'Remove', 'Confirm remove')
      await expect(alpha).toBeVisible()
    })

    await test.step('Hosts: a host found in ~/.ssh/config', async () => {
      const lab = page.locator('#rh-host-lab-mac')
      const q = lab.getByTestId('rh-found-question')
      await expect(q).toHaveText('Walnut found lab-mac in ~/.ssh/config. Connect to it?')
      await lab.getByTestId('rh-found-not-now').click()
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 1)).body).toEqual({ answer: 'not_now' })
      await expect(q).toHaveText('Found in ~/.ssh/config. Walnut does not connect to it.')
      await expect(lab.getByTestId('rh-found-not-now')).toHaveCount(0)
      await sweep(ctx)
      await lab.getByTestId('rh-found-connect').click()
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 2)).body).toEqual({ answer: 'yes' })
      await expect(q).toHaveCount(0)
      await expect(lab.getByRole('switch', { name: 'Use lab-mac' })).toHaveAttribute('aria-checked', 'true')
      ran(ctx, 'Hosts/button#rh-found-not-now', 'Hosts/button#rh-found-connect')
    })

    await test.step('Hosts: What Walnut knows', async () => {
      const toggle = page.getByTestId('host-profile-toggle-devbox')
      const before = routes.callsTo('POST', '/api/v1/hosts/refresh').length
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const body = page.getByTestId('host-profile-devbox')
      await expect(body.getByTestId('host-profile-system')).toHaveText('Ubuntu 24.04 · x64 · 16 CPUs · 64 GB memory · 200 GB free')
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', before + 1)).body).toEqual({ hosts: ['devbox'] })
      await sweep(ctx)
      const kind = body.getByRole('button', { name: 'Kind of Alpha box' })
      await expect(kind).toHaveText('Dev box (automatic) ▾')
      await kind.click()
      const list = page.getByRole('listbox', { name: 'Kind of Alpha box' })
      await expect(list.getByRole('option')).toHaveText(['Automatic', 'Laptop', 'Cloud VM (public)', 'Cloud VM (private)', 'Dev box', 'Unknown'].map((t) => new RegExp(`${t.replace(/[()]/g, '\\$&')}$`)))
      await list.getByRole('option', { name: /Laptop$/ }).click()
      await expect(list).toHaveCount(0)
      expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 1)).body).toEqual({ kind: 'laptop' })
      await expect(kind).toHaveText('Laptop ▾')
      await body.getByRole('button', { name: 'Probe again' }).click()
      expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 2)).body).toEqual({ refresh: true })
      await expect(body.getByTestId('host-profile-system')).toContainText('32 CPUs')
      await toggle.click()
      await expect(body).toHaveCount(0)
      ran(ctx, 'Hosts/button#host-profile-toggle-<host>', 'Hosts/button:Kind of <host>', 'Hosts/button:Probe again')
    })

    await test.step('Hosts: a failed host (details, Show again, Retry)', async () => {
      const beta = page.locator('#rh-host-downbox')
      const details = beta.locator('button.hft-details')
      await details.click()
      await expect(details).toHaveAttribute('aria-expanded', 'true')
      await expect(beta.locator('.hft-more')).toContainText('Connection timed out')
      await details.click()
      await expect(beta.locator('.hft-more')).toHaveCount(0)
      ran(ctx, 'Hosts/button.hft-details')

      await expect(beta.locator('.rh-banner-hidden')).toContainText('Hidden from the banner.')
      await beta.locator('button.rh-show-again-btn').click()
      await expect(beta.locator('.rh-banner-hidden')).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('open-walnut-host-banner-dismissed') ?? '')).not.toContain('downbox')
      ran(ctx, 'Hosts/button.rh-show-again-btn')

      await hostFixture(request, { action: 'set-next-connect', host: 'downbox', result: 'ok' })
      const retry = beta.locator('button.rh-connect-btn')
      await expect(retry).toHaveText('Retry')
      const tries = (await fixtureCounters(request)).connect.downbox ?? 0
      await retry.click()
      await expect(beta.locator('.rh-status-short')).toHaveText('Connected', { timeout: 15_000 })
      expect((await fixtureCounters(request)).connect.downbox).toBe(tries + 1)
      ran(ctx, 'Hosts/button.rh-connect-btn')
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
      await sweep(ctx)
      await other.click()
      await expect(block.locator('.hc-other-list')).toHaveCount(0)
      ran(ctx, 'Hosts/button.setup-copy-btn', 'Hosts/button.hc-other')

      const check = block.getByTestId('rh-readiness-recheck')
      const checks = (await fixtureCounters(request)).check.devbox ?? 0
      await check.click()
      await expect(check).toHaveText('Checking...')
      await expect(check).toHaveText('Check again', { timeout: 10_000 })
      expect((await fixtureCounters(request)).check.devbox).toBe(checks + 1)
      ran(ctx, 'Hosts/button#rh-readiness-recheck')

      const install = block.getByTestId('rh-readiness-fix-claude_missing')
      await expect(install).toHaveText('Install')
      const asked = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith('/api/hosts/devbox/connect'))
      await install.click()
      expect((await asked).postDataJSON()).toEqual({ agents: true })
      await expect(page.locator('#rh-host-devbox')).toContainText('Installing Claude Code on Alpha box')
      await expect(install).toHaveCount(0, { timeout: 20_000 })
      ran(ctx, 'Hosts/button#rh-readiness-fix-claude_missing')
    })

    await test.step('Machines that joined with a link', async () => {
      const group = page.getByTestId('host-network-group')
      const n = routes.invites + 1
      await page.getByTestId('host-network-add').click()
      await expect(page.getByTestId('host-network-command')).toHaveText(netCommand(n))
      ran(ctx, 'Machines/button#host-network-add')
      await expectCopied(page, page.getByTestId('host-network-copy'), netCommand(n))
      await expectCopied(page, page.getByTestId('host-network-windows-copy'), netWindows(n))
      await expectCopied(page, page.getByTestId('host-network-windows-link-copy'), netLink(n))
      ran(ctx, 'Machines/button#host-network-copy', 'Machines/button#host-network-windows-copy', 'Machines/button#host-network-windows-link-copy')
      await expectOpensTab(page, group.getByRole('link', { name: 'Walnut for Windows' }), WINDOWS_APP)
      ran(ctx, 'Machines/link:Walnut for Windows')
      await sweep(ctx)

      const gpu = group.locator('[data-host-alias="gpu-box"]')
      const connectNow = gpu.locator('button.rh-connect-btn')
      await expect(connectNow).toHaveText('Connect now')
      const release = routes.gate('connect:gpu-box')
      await connectNow.click()
      await expect(connectNow).toHaveText('Retrying...')
      release()
      await expect(gpu.locator('.rh-status-short')).toHaveText('Connected')
      ran(ctx, 'Machines/button.rh-connect-btn')
      const remove = gpu.locator('button[data-armed]')
      await armThenCancel(routes, remove, 'Remove', 'Confirm remove')
      await expect(gpu).toBeVisible()
      await remove.click()
      await remove.click()
      await routes.nth('DELETE', '/api/hosts/net/machines/gpu-box', 1)
      await expect(gpu).toHaveCount(0)
      ran(ctx, 'Machines/button:Remove <host>')

      const relay = page.getByTestId('host-network-relay')
      const own = relay.locator('[data-relay="own"]')
      await expect(own).toBeDisabled()
      await expect(own).toContainText('Pair a cloud companion first')
      for (const pick of ['none', 'public'] as const) {
        const choice = relay.locator(`[data-relay="${pick}"]`)
        const puts = routes.callsTo('PUT', '/api/hosts/net/relay').length
        await choice.click()
        expect((await routes.nth('PUT', '/api/hosts/net/relay', puts + 1)).body).toEqual({ relay: pick })
        await expect(choice).toHaveAttribute('aria-checked', 'true')
      }
      ran(ctx, 'Relay/radio[relay=own]', 'Relay/radio[relay=public]', 'Relay/radio[relay=none]')
    })

    await test.step('Walnut on a host', async () => {
      const writes = (key: string) => routes.callsTo('PUT', `/api/host-servers/${key}`)
      const saw = (key: string, pick: (b: Record<string, unknown>) => unknown, want: (on: boolean) => unknown) => {
        const base = writes(key).length
        let k = 0
        return async (on: boolean) => { expect(pick((await routes.nth('PUT', `/api/host-servers/${key}`, base + ++k)).body as Record<string, unknown>)).toEqual(want(on)) }
      }
      await expectOpensTab(page, page.getByTestId('host-server-url-devbox'), ALPHA_URL)
      await expectCopied(page, page.getByTestId('host-server-copy-url-devbox'), ALPHA_URL)
      ran(ctx, 'Walnut on a host/link#host-server-url-<host>', 'Walnut on a host/button#host-server-copy-url-<host>')

      const copies = page.locator('[data-testid^="host-server-copy-devbox-"][role="switch"]')
      await expect(copies).toHaveCount(11)
      for (const id of await copies.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!))) {
        const kind = id.replace('host-server-copy-devbox-', '')
        await flip(page.getByTestId(id), saw('devbox', (b) => (b.copies as Record<string, boolean>)[kind], (on) => on))
      }
      ran(ctx, 'Walnut on a host/switch#host-server-copy-<host>-<kind>')
      await flip(page.getByTestId('host-server-expose-devbox'), saw('devbox', (b) => (b.expose as { enabled: boolean }).enabled, (on) => on))
      ran(ctx, 'Walnut on a host/switch#host-server-expose-<host>')
      await flip(page.getByTestId('host-server-enabled-downbox'), saw('downbox', (b) => b.enabled, (on) => on))
      ran(ctx, 'Walnut on a host/switch#host-server-enabled-<host>')

      const tunnelRetry = page.getByTestId('host-server-tunnel-retry-downbox')
      await tunnelRetry.click()
      await expect(page.getByTestId('host-server-tunnel-state-downbox')).toHaveText('Starting Test tunnel...')
      expect(routes.callsTo('POST', '/api/host-servers/downbox/expose/retry')).toHaveLength(1)
      ran(ctx, 'Walnut on a host/button#host-server-tunnel-retry-<host>')

      const retry = page.getByTestId('host-server-retry-devbox')
      const release = routes.gate('host-server')
      await retry.click()
      await expect(page.getByTestId('host-server-enabled-devbox')).toHaveAttribute('aria-busy', 'true')
      release()
      await expect(page.getByTestId('host-server-state-devbox')).toHaveText('Starting the new build...')
      await expect(retry).toHaveCount(0)
      ran(ctx, 'Walnut on a host/button#host-server-retry-<host>')
    })

    await test.step('Tasks using other hosts', async () => {
      const ex = page.getByTestId('host-exec-grants')
      const sw = ex.getByRole('switch', { name: 'Tasks on other hosts may use Alpha box' })
      const base = routes.callsTo('PUT', '/api/v1/host-exec/hosts/devbox').length
      let k = 0
      await flip(sw, async (on) => {
        expect((await routes.nth('PUT', '/api/v1/host-exec/hosts/devbox', base + ++k)).body).toEqual({ closed: !on })
        await expect(ex.locator('[data-exec-host="devbox"]')).toContainText(on ? 'On: they start' : 'Off: nothing new starts')
      })
      ran(ctx, 'Tasks using other hosts/switch:Tasks on other hosts may use <host>')
      await ex.getByRole('button', { name: 'Revoke Nightly build on Alpha box' }).click()
      await routes.nth('DELETE', '/api/v1/host-exec/grants/g-1', 1)
      await expect(ex.locator('[data-grant-id="g-1"]')).toHaveCount(0)
      ran(ctx, 'Tasks using other hosts/button:Revoke <task> on <host>')
      await ex.getByRole('button', { name: 'Allow Lint job on Beta box' }).click()
      expect((await routes.nth('POST', '/api/v1/host-exec/grants', 1)).body).toEqual({ task_id: 'task-lint', host: 'downbox' })
      await expect(ex.locator('[data-denied]')).toHaveCount(0)
      await expect(ex.getByRole('button', { name: 'Revoke Lint job on Beta box' })).toBeVisible()
      ran(ctx, 'Tasks using other hosts/button:Allow <task> on <host>')
      await sweep(ctx)
    })

    await test.step('Secrets', async () => {
      const sec = page.getByTestId('fleet-secrets')
      const editor = sec.getByTestId('secret-editor')
      await sec.getByRole('button', { name: 'Edit github-read' }).click()
      await expect(editor).toContainText('Value of github-read')
      await expect(editor.getByTestId('secret-value-saved')).toContainText('Saved in secrets, never synced.')
      await sweep(ctx)
      ran(ctx, 'Secrets/button:Edit <secret>')
      await editor.getByRole('button', { name: 'Replace' }).click()
      const value = editor.getByTestId('secret-value')
      await expect(value).toBeFocused()
      ran(ctx, 'Secrets/button:Replace')
      await value.fill('s3cret-value')
      const eye = editor.locator('button.secret-toggle')
      await eye.click()
      await expect(value).toHaveAttribute('type', 'text')
      await expect(eye).toHaveText('Hide')
      await sweep(ctx)
      await eye.click()
      await expect(value).toHaveAttribute('type', 'password')
      ran(ctx, 'Secrets/button.secret-toggle')
      await editor.getByRole('button', { name: 'Cancel' }).click()
      await expect(editor).toHaveCount(0)
      ran(ctx, 'Secrets/button:Cancel')

      await sec.getByTestId('secret-add').click()
      await expect(editor.getByTestId('secret-name')).toBeVisible()
      ran(ctx, 'Secrets/button#secret-add')
      await editor.getByTestId('secret-save').click()
      await expect(sec.locator('.hf-error')).toContainText('A name is lower case letters')
      await editor.getByTestId('secret-name').fill('deploy-key')
      await editor.getByTestId('secret-value').fill('v4lue')
      const toAlpha = editor.getByTestId('secret-host-devbox')
      await toAlpha.click()
      await expect(toAlpha).toBeChecked()
      const sessions = editor.getByTestId('secret-sessions')
      await sessions.click()
      await expect(sessions).toBeChecked()
      await sweep(ctx)
      await editor.getByTestId('secret-save').click()
      await expect(sec.locator('.hf-error')).toContainText('give its name (GH_TOKEN)')
      await editor.getByTestId('secret-env').fill('deploy_token')
      await editor.getByTestId('secret-save').click()
      expect((await routes.nth('PUT', '/api/v1/secrets/deploy-key', 1)).body).toEqual({ value: 'v4lue', create: true, hosts: ['devbox'], env: 'DEPLOY_TOKEN', sessions: true, description: '' })
      await expect(editor).toHaveCount(0)
      const added = sec.locator('[data-secret-name="deploy-key"]')
      await expect(added).toBeVisible()
      ran(ctx, 'Secrets/button#secret-save', 'Secrets/checkbox#secret-host-<host>', 'Secrets/checkbox#secret-sessions')
      await armThenCancel(routes, sec.locator('[data-secret-name="github-read"] button[data-armed]'), 'Delete', 'Confirm delete')
      await sweep(ctx)
      const del = added.locator('button[data-armed]')
      await del.click()
      await del.click()
      await routes.nth('DELETE', '/api/v1/secrets/deploy-key', 1)
      await expect(added).toHaveCount(0)
      ran(ctx, 'Secrets/button:Delete <secret>')
    })

    await test.step('Copies that held off', async () => {
      const confirm = page.getByTestId('replica-removal-confirm-host:devbox/notes')
      await armThenCancel(routes, confirm, 'Remove them there', 'Confirm remove')
      await confirm.click()
      await confirm.click()
      expect((await routes.nth('POST', '/api/replicas/confirm-removal', 1)).body).toEqual({ target: 'host:devbox', kind: 'notes', entries: 80, keys: 'k80' })
      await expect(page.getByTestId('replica-removal-host:devbox/notes')).toHaveAttribute('data-removal', 'armed')
      await expect(confirm).toHaveCount(0)
      ran(ctx, 'Copies that held off/button#replica-removal-confirm-host:<host>/notes')
    })

    await test.step('Session limits', async () => {
      const row = page.locator('[data-limit-host="devbox"]')
      const puts = routes.callsTo('PUT', '/api/config').length
      await row.getByRole('button', { name: 'Remove the limit for devbox' }).click()
      await expect(row).toHaveCount(0)
      expect((await routes.nth('PUT', '/api/config', puts + 1)).body as { session_limits: unknown }).toHaveProperty('session_limits', {})
      ran(ctx, 'Session limits/button:Remove the limit for <host>')
      const add = page.locator('.rh-limit-add').getByRole('button', { name: 'Add', exact: true })
      await expect(add).toBeDisabled()
      await page.locator('#rh-limit-new-host').fill('devbox')
      await page.locator('#rh-limit-new-max').fill('4')
      await add.click()
      await expect(page.locator('#rh-limit-devbox')).toHaveValue('4')
      expect(((await routes.nth('PUT', '/api/config', puts + 2)).body as { session_limits: unknown }).session_limits).toEqual({ devbox: 4 })
      ran(ctx, 'Session limits/button:Add')
      await sweep(ctx)
    })

    await test.step('Hosts: the note\'s mic (last: it leaves the pane)', async () => {
      await page.getByTestId('host-profile-toggle-devbox').click()
      const mic = page.getByTestId('host-profile-devbox').locator('button.mic-btn')
      await expect(page.getByTestId('host-profile-system')).toBeVisible()
      // Linux WebKit has no recorder, so no mic; Chromium must show it.
      if (isChromium(page)) await expect(mic).toHaveCount(1)
      else if (await mic.count() === 0) return
      await sweep(ctx)
      await expect(mic).toHaveAttribute('aria-label', 'Set up dictation')
      await mic.click()
      await expect.poll(() => new URL(page.url()).hash).toBe('#stt')
      ran(ctx, 'Hosts/button.mic-btn')
    })

    await test.step('every button seen has a check that ran, and every registered button was seen', async () => {
      const unseen = Object.keys(REGISTRY).filter((k) => !REGISTRY[k].optional && !ctx.seen.has(k))
      expect(unseen, `REGISTRY names buttons the pane never showed: ${unseen.join(', ')}`).toEqual([])
      const unchecked = [...ctx.seen].filter((k) => !ctx.ran.has(k))
      expect(unchecked, `buttons seen whose check never ran: ${unchecked.join(', ')}`).toEqual([])
      const skipped = Object.keys(REGISTRY).filter((k) => !ctx.ran.has(k))
      console.log(`[remote-hosts-every-button] ${ctx.ran.size} of ${Object.keys(REGISTRY).length} keys checked${skipped.length ? `; not shown in this engine: ${skipped.join(', ')}` : ''}`)
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
