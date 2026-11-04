/**
 * Settings > Remote Hosts: every button and link on the pane, clicked, each with a result you
 * can see (2026-11-04, the user on Add host: "this button doesn't wrok can we make sure it
 * wroks?": it appended an empty row off screen, so a press looked like nothing happened).
 *
 * REGISTRY names every button the pane may show, by a stable key (data-testid, else a menu
 * item's key, else a known class, else role and accessible name, each host's name written
 * `<host>`), with the check that clicks it. The pane (its build line and any menu it opened
 * included) is swept after each step: a button the registry does not name fails the run with its
 * key, a registry key the run never saw fails it too, and so does a key whose check never ran.
 * Adding a button to the pane means adding its check here.
 *
 * SSH hosts are the server's host fixture (real status frames, real Retry, Check again and
 * Install). The rest is routed (remote-hosts-every-button-helpers.ts): nothing is saved to the
 * server's config, deleted, sent to a real host or started as an agent. Destructive buttons ask
 * first and are cancelled (Escape), or answered by the route. Navigation is by clicks. The
 * longer steps live in remote-hosts-every-button-steps.ts and -rows.ts.
 *
 * Run: walnut-dev run env PW_WEBKIT=1 npx playwright test remote-hosts-every-button --project=webkit
 *      walnut-dev run npx playwright test remote-hosts-every-button --project=chromium-host-fixture
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fixtureCounters, hostFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import { expectFocusKept, flip, isChromium, openFixturePane, paneKeys, pick, row } from './remote-hosts-every-button-helpers'
import {
  ADD_ITEMS, checkAddHost, checkExecGrants, checkHostServers, checkJoinLink, checkMoreSettings, checkSecrets, checkSessionLimits, expectRing, type StepCtx,
} from './remote-hosts-every-button-steps'
import { checkAlphaRow } from './remote-hosts-every-button-rows'

test.setTimeout(360_000)
// A button that is not there fails in seconds, not at the end of the test's budget.
test.use({ actionTimeout: 15_000 })

/** Every button the pane may show, and the check that clicks it. `optional`: it depends on the engine. */
const REGISTRY: Record<string, { check: string; optional?: true }> = {
  'Header/button#remote-hosts-add': { check: 'the one header action: a menu with the two ways in, under the button; each lands at the top of the list, in view, focused and ringed' },
  'Add host menu/menuitem[join]': { check: 'Making a link... at once, then the link with its Copy focused; a failure says why with Try again' },
  'Add host menu/menuitem[ssh]': { check: 'a new row at the top, Hostname focused; a second press goes to the same empty row' },
  'Footer/button#remote-hosts-copy-diagnostics': { check: 'the page-end link copies the hosts section: reads /api/diagnostics; says Copied or why not' },
  'Pane/button#host-fleet-refresh': { check: 'one Refreshing... for the page until the read ends' },
  'Pane/button#rh-summary-needs': { check: 'goes to the first row that needs a look, focused and ringed' },
  'Pane/button#remote-hosts-map-toggle': { check: 'opens and closes the network map' },
  'Pane/button#host-fleet-topo-node': { check: 'each node lands on its host\'s row, focused' },
  'Pane/button#remote-hosts-more-toggle': { check: 'closed: says what is inside and how much needs a look; open: one line per group' },
  'Hosts/button#rh-row-more': { check: 'opens the row\'s menu under it; Escape gives the focus back' },
  'Row menu/menuitem[edit]': { check: 'opens the fields in place (Done editing closes them); Escape closes them too' },
  'Row menu/menuitem[details]': { check: 'opens Details in place (Hide details closes them), reading that host again' },
  'Row menu/menuitem[turn-off]': { check: 'saves the host off; the row says Off and offers Turn on' },
  'Row menu/menuitem[not-now]': { check: 'answers not_now; the focus stays on the row' },
  'Row menu/menuitem[show-again]': { check: 'the host\'s problem shows on the home page again; the focus stays on the row' },
  'Row menu/menuitem[remove]': { check: 'last and red; asks "Remove <host>?" with Cancel focused' },
  'Hosts/button#rh-row-confirm-cancel': { check: 'keeps the host, sends nothing, the focus back on More' },
  'Hosts/button#rh-row-confirm-remove': { check: 'takes the host away and focuses the next row' },
  'Hosts/button#rh-row-connect': { check: 'Retry on a failed host (Retrying...) and Connect now on a machine (Connecting...), then Connected; the focus stays on the row' },
  'Hosts/button#rh-found-connect': { check: 'Connecting..., answers yes; the row becomes a host; the focus stays on the row' },
  'Hosts/button#rh-readiness-fix-claude_missing': { check: 'the row\'s one action: Installing..., then Installed, said once' },
  'Hosts/button#host-fleet-fix': { check: 'Setting up..., then the row says it is set up' },
  'Hosts/button#rh-turn-on': { check: 'saves the host on again' },
  'Hosts/button#rh-draft-cancel': { check: 'takes an untouched new row away with no confirm' },
  'Hosts/button#rh-edit-done': { check: 'closes the fields; the focus goes to More' },
  'Hosts/button#rh-more-options': { check: 'shows and hides label, shell setup and what it keeps' },
  'Hosts/switch:Keep notes on <host>': { check: 'flips and saves keep.notes' },
  'Hosts/switch:Keep attachments on <host>': { check: 'flips and saves keep.attachments' },
  'Hosts/switch:Keep memory on <host>': { check: 'flips and saves keep.memory' },
  'Hosts/switch:Keep skills on <host>': { check: 'flips and saves keep.skills' },
  'Hosts/button:Kind of <host>': { check: 'in Details: opens the kinds; Escape gives the focus back; a pick is saved and shown' },
  'Hosts/button:Probe again': { check: 'asks for a probe; the new system line shows' },
  'Hosts/button.mic-btn': { check: 'unconfigured voice: takes you to Settings > Voice', optional: true },
  'Hosts/button.setup-copy-btn': { check: 'says Copied or Copy failed' },
  'Hosts/button.hc-other': { check: 'shows and hides the other commands' },
  'Hosts/button#rh-readiness-recheck': { check: 'Checking..., then Check again; the server checked once' },
  'Hosts/button.hft-details': { check: 'shows and hides the failure details' },
  'Hosts/radio#host-network-os-mac': { check: 'the Terminal command for a Mac (the default)' },
  'Hosts/radio#host-network-os-linux': { check: 'the terminal command for Linux' },
  'Hosts/radio#host-network-os-windows': { check: 'the Windows app and its link' },
  'Hosts/button#host-network-copy': { check: 'copies the command; Add host focuses it' },
  'Hosts/button#host-network-windows-link-copy': { check: 'copies the link' },
  'Hosts/button#host-network-windows-copy': { check: 'copies the PowerShell command (under More about this link)' },
  'Hosts/link:Walnut for Windows': { check: 'opens the download in a new tab' },
  'Hosts/button#host-network-more': { check: 'shows and hides the notes about the link' },
  'Hosts/button#host-network-new-link': { check: 'an expired link: makes a new one, its Copy focused' },
  'Hosts/button#host-network-done': { check: 'puts the link away; the focus goes back to Add host' },
  'Hosts/button#host-network-try-again': { check: 'a link that could not be made: makes one, its Copy focused' },
  'Hosts/button#host-network-error-done': { check: 'puts the refusal away; the focus goes back to Add host' },
  'Relay/button#host-network-relay-toggle': { check: 'says which relay is in use; opens the choices' },
  'Relay/radio[relay=own]': { check: 'disabled without a companion, and says why' },
  'Relay/radio[relay=public]': { check: 'picked again: saved and checked' },
  'Relay/radio[relay=none]': { check: 'saved and checked' },
  'Walnut on a host/button#host-servers-toggle': { check: 'says how many hosts run Walnut and what needs a look; opens the group' },
  'Walnut on a host/button#host-server-retry-<host>': { check: '"Update to this build" on an older build: busy, then the host starts the new build' },
  'Walnut on a host/switch#host-server-enabled-<host>': { check: 'flips and saves off, then on' },
  'Walnut on a host/button#host-server-copies-toggle-<host>': { check: 'says how many kinds are copied; shows and hides the 11 switches' },
  'Walnut on a host/switch#host-server-copy-<host>-<kind>': { check: 'every copy switch flips and saves its kind, and back; the line counts it' },
  'Walnut on a host/switch#host-server-expose-<host>': { check: 'flips and saves the tunnel off, then on' },
  'Walnut on a host/link#host-server-url-<host>': { check: 'opens the host\'s address in a new tab' },
  'Walnut on a host/button#host-server-copy-url-<host>': { check: 'copies the address' },
  'Walnut on a host/button#host-server-tunnel-retry-<host>': { check: 'the tunnel starts again' },
  'Tasks using other hosts/button#host-exec-grants-toggle': { check: 'says how many tasks are allowed and declined; opens the group' },
  'Tasks using other hosts/switch:Tasks on other hosts may use <host>': { check: 'flips and saves the host closed (it says Off), then open' },
  'Tasks using other hosts/button:Revoke <task> on <host>': { check: 'revokes (routed); the grant goes' },
  'Tasks using other hosts/button:Allow <task> on <host>': { check: 'allows (routed); it becomes a grant' },
  'Secrets/button#fleet-secrets-toggle': { check: 'says how many secrets; opens the group' },
  'Secrets/button:Edit <secret>': { check: 'opens the editor on that secret' },
  'Secrets/button:Replace': { check: 'a value field, focused' },
  'Secrets/button.secret-toggle': { check: 'shows the typed value, hides it again' },
  'Secrets/button:Cancel': { check: 'closes the editor, saves nothing, and takes a refusal with it' },
  'Secrets/button#secret-add': { check: 'opens the editor for a new secret, Name focused, no old refusal' },
  'Secrets/button#secret-save': { check: 'refuses a blank name, and sessions without a variable, each under its field, focused; saves a valid one (routed)' },
  'Secrets/checkbox#secret-host-<host>': { check: 'ticks a host; the save copies to it' },
  'Secrets/checkbox#secret-sessions': { check: 'ticks; the save asks for the variable, then sends sessions: true' },
  'Secrets/button:Delete <secret>': { check: 'arms Confirm delete, Escape keeps it; confirm sends the DELETE (routed) and the row goes' },
  'Removals to confirm/button#replica-removal-confirm-host:<host>/notes': { check: 'arms Confirm remove, Escape sends nothing; confirm sends what the row read (routed) and the row waits' },
  'Session limits/button#rh-session-limits-toggle': { check: 'names each limit by host; opens the group' },
  'Session limits/button:Remove the limit for <host>': { check: 'the limit row goes and the limits save without it' },
  'Session limits/combobox#rh-limit-new-host': { check: 'a host picked from the list, by its name' },
  'Session limits/button:Add': { check: 'off until a host and a number are picked; adds the limit row and saves it' },
}

interface Ctx extends StepCtx { seen: Set<string>; ranKeys: Set<string> }

const unknownKeys = (keys: string[]) => keys.filter((k) => !(k in REGISTRY))

const pane = (page: Page) => page.locator('#remote-hosts')
const menu = (page: Page) => page.getByTestId('rh-row-menu')

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

    await test.step('the list: one line for the fleet, one row per machine, one action each', async () => {
      // One fleet: the summary counts the machines the list shows (2026-11-04 review: two fixtures).
      await expect(page.getByTestId('rh-summary-online')).toHaveText('2 of 4 online')
      await expect(page.getByTestId('rh-summary-sessions')).toHaveText('4 sessions open')
      await expect(page.getByTestId('rh-summary-spend')).toHaveText('$241 in 30 days')
      await expect(page.getByTestId('rh-summary-needs')).toHaveText(/^\d need a look$/)
      for (const alias of ['__local__', 'devbox', 'downbox', 'gpu-box', 'lab-mac', 'fixture-remote']) await expect(row(page, alias)).toHaveCount(1)
      await expect(row(page, '__local__').locator('.rh-host-name')).toHaveText('This Mac')
      // At most one action per row, every one in one column beside its name line.
      const boxes = await page.locator('[data-testid="remote-hosts-list"] .rh-host-row').evaluateAll((rows) => rows.map((r) => {
        const more = r.querySelector('[data-testid="rh-row-more"]')!.getBoundingClientRect()
        const name = r.querySelector('.rh-row-name-line')!.getBoundingClientRect()
        return { primaries: r.querySelectorAll('.rh-row-primary > button').length, right: Math.round(more.right), dy: Math.abs(more.top + more.height / 2 - (name.top + name.height / 2)) }
      }))
      for (const b of boxes) expect(b.primaries).toBeLessThanOrEqual(1)
      expect(new Set(boxes.map((b) => b.right)).size).toBe(1)
      for (const b of boxes) expect(b.dy).toBeLessThanOrEqual(2)
      // The header has one action.
      await expect(page.locator('#remote-hosts .settings-pane-header button')).toHaveCount(1)

      // "need a look" goes to the first row that does.
      await page.getByTestId('rh-summary-needs').click()
      await expectRing(page, page.locator('[data-testid="remote-hosts-list"] [data-needs-look="true"]').first())
      ran('Pane/button#rh-summary-needs')

      // One Refreshing... for the whole page, then Refresh is back.
      const reads = routes.callsTo('POST', '/api/v1/hosts/refresh').length
      const refresh = page.getByTestId('host-fleet-refresh')
      await refresh.click()
      await expect(page.getByTestId('host-fleet-refreshing')).toHaveText('Refreshing...')
      await expect(page.getByText('Refreshing...', { exact: true })).toHaveCount(1)
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', reads + 1)).body).toEqual({})
      await expect(refresh).toBeVisible({ timeout: 10_000 })
      ran('Pane/button#host-fleet-refresh')
    })

    await test.step('header: Add host (a slow link, the SSH draft, Cancel and Escape)', async () => {
      await checkAddHost(ctx)
    })

    await test.step('the network map', async () => {
      const toggle = page.getByTestId('remote-hosts-map-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toContainText('How this Mac reaches each host.')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      const nodes = page.getByTestId('host-fleet-topo-node')
      const hosts = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('data-host')!))
      expect(hosts.sort()).toEqual(['__local__', 'devbox', 'downbox', 'gpu-box'])
      // The map names this machine as the list does.
      await expect(page.locator('[data-testid="host-fleet-topo-node"][data-host="__local__"] .hf-topo-name')).toHaveText('This Mac')
      await sweep()
      for (const host of hosts) {
        await page.locator(`[data-testid="host-fleet-topo-node"][data-host="${host}"]`).click()
        const target = page.locator(`[id="rh-host-${host}"]`)
        await expectRing(page, target)
        await expect(target).toBeInViewport()
      }
      await toggle.click()
      await expect(nodes.first()).toBeHidden()
      ran('Pane/button#remote-hosts-map-toggle', 'Pane/button#host-fleet-topo-node')
    })

    await test.step('Alpha box: its menu, Details, Install, Set up', async () => { await checkAlphaRow(ctx) })

    await test.step('Alpha box: Edit (Escape closes), keep switches, Turn off and on, Remove asks', async () => {
      const alpha = row(page, 'devbox')
      const more = alpha.getByTestId('rh-row-more')
      await pick(page, alpha, 'Edit')
      const hostname = page.locator('input[id^="rh-hostname-"]')
      await expect(hostname).toHaveValue('alpha.example.com')
      await expect(hostname).toBeFocused()
      await expect(page.locator('input[id^="rh-alias-"]')).toHaveValue('devbox')
      // The rest is folded under More options.
      const opts = page.getByTestId('rh-more-options')
      await expect(page.getByRole('switch', { name: 'Keep notes on Alpha box' })).toBeHidden()
      await opts.click()
      await expect(opts).toHaveAttribute('aria-expanded', 'true')
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
      await opts.click()
      ran('Hosts/button#rh-more-options')
      // Escape closes the fields, and the focus goes to the row's More.
      await hostname.focus()
      await page.keyboard.press('Escape')
      await expect(hostname).toHaveCount(0)
      await expectRing(page, more)
      // Done does the same.
      await pick(page, alpha, 'Edit')
      await page.getByTestId('rh-edit-done').click()
      await expect(hostname).toHaveCount(0)
      await expectRing(page, more)
      ran('Row menu/menuitem[edit]', 'Hosts/button#rh-edit-done')

      // Turn off saves it off; Turn on, its row's one action now, saves it on.
      const puts = routes.callsTo('PUT', '/api/config').length
      await pick(page, alpha, 'Turn off')
      expect(((await routes.nth('PUT', '/api/config', puts + 1)).body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(false)
      await expect(alpha.getByTestId('rh-row-state')).toHaveText('Off: Walnut does not connect to it.')
      await sweep()
      await alpha.getByTestId('rh-turn-on').click()
      expect(((await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(true)
      await expect(alpha.getByTestId('rh-turn-on')).toHaveCount(0)
      await expectFocusKept(page)
      ran('Row menu/menuitem[turn-off]', 'Hosts/button#rh-turn-on')

      // Remove: last, red, and it asks, naming the host; Cancel (focused) and Escape keep it.
      const calls = routes.calls.length
      await pick(page, alpha, 'Remove')
      const confirm = page.getByTestId('rh-row-confirm')
      await expect(confirm).toContainText('Remove Alpha box?')
      await expect(confirm.getByTestId('rh-row-confirm-remove')).toHaveClass(/settings-button-danger/)
      await expect(confirm.getByTestId('rh-row-confirm-cancel')).toBeFocused()
      await sweep()
      await page.keyboard.press('Escape')
      await expect(confirm).toHaveCount(0)
      await expect(more).toBeFocused()
      await pick(page, alpha, 'Remove')
      await confirm.getByTestId('rh-row-confirm-cancel').click()
      await expect(confirm).toHaveCount(0)
      await expect(more).toBeFocused()
      expect(routes.calls.slice(calls).filter((c) => c.method !== 'GET')).toEqual([])
      await expect(alpha).toBeVisible()
      ran('Row menu/menuitem[remove]', 'Hosts/button#rh-row-confirm-cancel')
    })

    await test.step('a new host: an alias another host has is refused; Saved, and no Connect now before', async () => {
      const puts = routes.callsTo('PUT', '/api/config').length
      await page.locator('[data-testid="remote-hosts-add"]:visible').first().click()
      await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[1] }).click()
      const hostname = page.locator('input[id^="rh-hostname-"]')
      const alias = page.locator('input[id^="rh-alias-"]')
      await hostname.fill('dup.example.com')
      await alias.fill('devbox')
      const refusal = pane(page).locator('.settings-row-error', { hasText: 'devbox is already Alpha box. Pick another alias.' })
      await expect(refusal).toBeVisible()
      await expect(alias).toHaveAttribute('aria-invalid', 'true')
      await expect(pane(page).locator('.rh-host-row:not([data-host-alias])')).toContainText('Not saved until it has an alias of its own.')
      // Alpha box keeps its row (and its status): one row has its id.
      await expect(page.locator('[id="rh-host-devbox"]')).toHaveCount(1)
      // Three times the autosave's wait: nothing went out.
      await page.waitForTimeout(1_800)
      expect(routes.callsTo('PUT', '/api/config').length).toBe(puts)

      // Until the save lands the row says Saving..., with no Connect now (2026-11-04 review).
      const release = routes.gate('config-put')
      await alias.fill('labbox')
      await expect(refusal).toHaveCount(0)
      const lab = row(page, 'labbox')
      await expect(lab.getByTestId('rh-row-state')).toHaveText('Saving...')
      await routes.nth('PUT', '/api/config', puts + 1)
      await expect(lab.getByTestId('rh-row-connect')).toHaveCount(0)
      release()
      await expect(lab.getByTestId('rh-row-saved')).toHaveText('Saved.')
      const saved = routes.callsTo('PUT', '/api/config')[puts].body as { hosts: Record<string, Record<string, unknown>> }
      expect(saved.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
      expect(saved.hosts.labbox).toMatchObject({ hostname: 'dup.example.com' })
      await expect(lab.getByTestId('rh-row-saved')).toHaveCount(0, { timeout: 6_000 })

      // Remove asks, then takes it away; the focus goes to the next row.
      await pick(page, lab, 'Done editing')
      await pick(page, lab, 'Remove')
      await page.getByTestId('rh-row-confirm').getByTestId('rh-row-confirm-remove').click()
      await expect(lab).toHaveCount(0)
      const after = (await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, Record<string, unknown>> }
      expect(Object.keys(after.hosts)).not.toContain('labbox')
      expect(after.hosts.devbox).toMatchObject({ hostname: 'alpha.example.com', label: 'Alpha box' })
      await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^(ssh|fleet|net):/)
      ran('Hosts/button#rh-row-confirm-remove')
    })

    await test.step('lab-mac, found in ~/.ssh/config: Connect, Not now in its menu, the focus kept', async () => {
      const lab = row(page, 'lab-mac')
      const q = lab.getByTestId('rh-found-question')
      await expect(q).toHaveText('Walnut found lab-mac in ~/.ssh/config. Connect to it?')
      await pick(page, lab, 'Not now', sweep)
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 1)).body).toEqual({ answer: 'not_now' })
      await expect(q).toHaveText('Found in ~/.ssh/config. Walnut does not connect to it.')
      await expectFocusKept(page)
      ran('Row menu/menuitem[not-now]')
      await sweep()
      const connect = lab.getByTestId('rh-found-connect')
      await connect.focus()
      await page.keyboard.press('Enter')
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 2)).body).toEqual({ answer: 'yes' })
      await expect(q).toHaveCount(0)
      await expectFocusKept(page)
      ran('Hosts/button#rh-found-connect')
    })

    await test.step('Beta box, not connected: Details, Show again, Retry', async () => {
      const beta = row(page, 'downbox')
      await pick(page, beta, 'Details')
      const details = page.locator('[data-testid="rh-details"][data-host="downbox"]')
      const output = details.locator('button.hft-details')
      await expect(output).toBeVisible()
      await sweep()
      await output.click()
      await expect(output).toHaveAttribute('aria-expanded', 'true')
      await expect(details.locator('.hft-more')).toContainText('Connection timed out')
      await output.click()
      await expect(details.locator('.hft-more')).toHaveCount(0)
      ran('Hosts/button.hft-details')
      await pick(page, beta, 'Hide details')

      await expect(beta.getByTestId('rh-banner-hidden')).toHaveText('You hid this problem on the home page.')
      await pick(page, beta, 'Show again on the home page', sweep)
      await expect(beta.getByTestId('rh-banner-hidden')).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('open-walnut-host-banner-dismissed') ?? '')).not.toContain('downbox')
      await expectFocusKept(page)
      ran('Row menu/menuitem[show-again]')

      await hostFixture(request, { action: 'set-next-connect', host: 'downbox', result: 'ok' })
      const retry = beta.getByTestId('rh-row-connect')
      await expect(retry).toHaveText('Retry')
      const tries = (await fixtureCounters(request)).connect.downbox ?? 0
      await retry.focus()
      await page.keyboard.press('Enter')
      await expect(beta.getByTestId('host-fleet-action-note')).toHaveText('Connected.', { timeout: 15_000 })
      expect((await fixtureCounters(request)).connect.downbox).toBe(tries + 1)
      await expectFocusKept(page)
    })

    await test.step('the join link, and gpu-box, a machine that joined with one', async () => {
      await page.locator('[data-testid="remote-hosts-add"]:visible').first().click()
      await page.getByTestId('remote-hosts-add-menu').getByRole('menuitem', { name: ADD_ITEMS[0] }).click()
      await expectRing(page, page.getByTestId('host-network-copy'))
      await checkJoinLink(ctx)
      const gpu = row(page, 'gpu-box')
      await expect(gpu).toContainText('Link')
      const connectNow = gpu.getByTestId('rh-row-connect')
      await expect(connectNow).toHaveText('Connect now')
      const release = routes.gate('connect:gpu-box')
      await connectNow.click()
      await expect(connectNow).toHaveText('Connecting...')
      release()
      await expect(gpu.getByTestId('rh-row-state')).toHaveText(/^Online/)
      await expectFocusKept(page)
      ran('Hosts/button#rh-row-connect')
      await pick(page, gpu, 'Remove')
      await expect(page.getByTestId('rh-row-confirm')).toContainText('Remove gpu-box?')
      await page.getByTestId('rh-row-confirm-remove').click()
      await routes.nth('DELETE', '/api/hosts/net/machines/gpu-box', 1)
      await expect(gpu).toHaveCount(0)
      // The focus goes to the row before it, never to the page.
      await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^(ssh|fleet|net):/)
    })

    await test.step('This Mac: its reading in Details', async () => {
      const mac = row(page, '__local__')
      await mac.getByTestId('rh-row-more').click()
      await expect(menu(page).getByRole('menuitem')).toHaveText(['Details'])
      await menu(page).getByRole('menuitem', { name: 'Details' }).click()
      await expect(page.locator('[data-testid="rh-details"][data-host="__local__"] [data-testid="host-fleet-card"]')).toBeVisible()
      await pick(page, mac, 'Hide details')
    })

    await test.step('More settings: Relay', async () => { await checkMoreSettings(ctx) })
    await test.step('More settings: Walnut on a host', async () => { await checkHostServers(ctx) })
    await test.step('More settings: Tasks using other hosts', async () => { await checkExecGrants(ctx) })
    await test.step('More settings: Secrets', async () => { await checkSecrets(ctx) })

    await test.step('Removals to confirm', async () => {
      const confirm = page.getByTestId('replica-removal-confirm-host:devbox/notes')
      const calls = routes.calls.length
      await expect(confirm).toHaveText('Remove them there')
      await confirm.click()
      await expect(confirm).toHaveText('Confirm remove')
      await confirm.press('Escape')
      await expect(confirm).toHaveText('Remove them there', { timeout: 1_000 })
      expect(routes.calls.slice(calls).filter((c) => c.method !== 'GET')).toEqual([])
      await confirm.click()
      await confirm.click()
      expect((await routes.nth('POST', '/api/replicas/confirm-removal', 1)).body).toEqual({ target: 'host:devbox', kind: 'notes', entries: 80, keys: 'k80' })
      await expect(page.getByTestId('replica-removal-host:devbox/notes')).toHaveAttribute('data-removal', 'armed')
      await expect(confirm).toHaveCount(0)
      ran('Removals to confirm/button#replica-removal-confirm-host:<host>/notes')
    })

    await test.step('More settings: Session limits', async () => { await checkSessionLimits(ctx) })

    await test.step('the page end: Copy diagnostics copies the hosts section', async () => {
      const diag = page.getByTestId('remote-hosts-copy-diagnostics')
      await diag.scrollIntoViewIfNeeded()
      await expect(diag).toHaveText('Copy diagnostics')
      await sweep()
      const read = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/diagnostics' && new URL(r.url()).searchParams.get('section') === 'hosts')
      await diag.click()
      await read
      await expect(diag.filter({ hasText: 'Copied' }).or(page.locator('.settings-build-line-error:visible'))).toBeVisible({ timeout: 20_000 })
      ran('Footer/button#remote-hosts-copy-diagnostics')
    })

    await test.step('Details\' note mic (last: it leaves the pane)', async () => {
      await pick(page, row(page, 'devbox'), 'Details')
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
      // Scrolled to the end first: whatever Add host makes still lands in view.
      await page.locator('.settings-pane').first().evaluate((el) => { el.scrollTop = el.scrollHeight })
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
