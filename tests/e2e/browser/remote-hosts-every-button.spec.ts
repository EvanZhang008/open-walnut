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
 * longer steps live in remote-hosts-every-button-steps.ts, -rows.ts, -host.ts (a host's own
 * settings, under "This host" in its Details) and -drafts.ts.
 *
 * Run: walnut-dev run env PW_WEBKIT=1 npx playwright test remote-hosts-every-button --project=webkit
 *      walnut-dev run npx playwright test remote-hosts-every-button --project=chromium-host-fixture
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { fixtureCounters, hostFixture, openHostParts, resetServerHostFixture } from './host-problems-fixture-helpers'
import { askThenCancel, expectFocusKept, flip, isChromium, openFixturePane, paneKeys, pick, row, shot } from './remote-hosts-every-button-helpers'
import {
  checkAddHost, checkJoinLink, checkMoreSettings, checkSecrets, expectRing, joinPress, type StepCtx,
} from './remote-hosts-every-button-steps'
import { checkAlphaRow } from './remote-hosts-every-button-rows'
import { checkBetaThisHost } from './remote-hosts-every-button-host'
import { checkDraftKept, checkNewHost } from './remote-hosts-every-button-drafts'
import { REGISTRY } from './remote-hosts-every-button-registry'
import { expectRowLinesNotRepeated } from './remote-hosts-said-once'

test.setTimeout(360_000)
// A button that is not there fails in seconds, not at the end of the test's budget.
test.use({ actionTimeout: 15_000 })

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
  // The tests load the server's one host fixture: never two at once (the webkit project has no workers: 1).
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('every button and link on the pane does something you can see', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const ctx = await setUp(page, request)
    const { routes, sweep, ran } = ctx
    // The fleet's counts, as the summary line says them: every row in one of them.
    const counts = page.locator('[data-testid="rh-summary"] .rh-summary-line')
    await sweep()

    await test.step('the list: one line for the fleet, one row per machine, one action each', async () => {
      // One fleet: the summary counts the rows the list shows, each row once, so the counts add up
      // to the rows (2026-11-04 review: two fixtures; 2026-11-05: "2 of 4 online, 1 off" over 6 rows).
      await expect(counts).toContainText('6 hosts: 2 online, 2 not connected, 1 off, 1 found in ~/.ssh/config, ')
      await expect(page.locator('[data-testid="remote-hosts-list"] .rh-host-row')).toHaveCount(6)
      await expect(page.getByTestId('rh-summary-sessions')).toHaveText('4 sessions open')
      await expect(page.getByTestId('rh-summary-spend')).toHaveText('$241 in 30 days')
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
      // The header: the one count and Add host.
      await expect(page.locator('#remote-hosts .settings-pane-header button')).toHaveCount(2)

      // The page's ONE "need a look" count, in the header: each row it counts says so, and each
      // press shows the next one, in view, the focus kept on the count (2026-11-04 review: it
      // always went to the first host, scrolled away, and More settings had a second count).
      const looks = page.locator('[data-testid="remote-hosts-list"] .rh-host-row[data-needs-look="true"]')
      const n = await looks.count()
      expect(n).toBeGreaterThanOrEqual(2)
      await expect(page.locator('[data-testid="remote-hosts-list"] [data-testid="rh-look-tag"]')).toHaveCount(n)
      await expect(page.locator('[data-testid="remote-hosts-list"] [data-testid="rh-look-tag"]').first()).toHaveText('Needs a look')
      const needs = page.getByTestId('rh-needs-look')
      await expect(needs).toHaveText(`${n} need a look`)
      await expect(page.getByTestId('rh-summary-needs')).toHaveCount(0)
      await expect(page.getByTestId('remote-hosts-more-needs')).toHaveCount(0)
      for (let i = 0; i <= n; i++) {
        const at = i % n
        await needs.click()
        await expect(needs).toHaveText(`${at + 1} of ${n} need a look`)
        const name = (await looks.nth(at).locator('.rh-host-name').textContent())!
        await expect(needs).toHaveAccessibleName(`${at + 1} of ${n} need a look: showing ${name}`)
        await expect(looks.nth(at)).toBeInViewport()
        await expect(needs).toBeFocused()
      }
      ran('Header/button#rh-needs-look')

      // One Refreshing... for the whole page: Refresh itself, in place and keeping the focus while
      // the read runs, then Refresh again.
      const reads = routes.callsTo('POST', '/api/v1/hosts/refresh').length
      const refresh = page.getByTestId('host-fleet-refresh')
      await refresh.focus()
      await page.keyboard.press('Enter')
      await expect(refresh).toHaveText('Refreshing...')
      await expect(refresh).toHaveAttribute('aria-busy', 'true')
      await expect(page.getByText('Refreshing...', { exact: true })).toHaveCount(1)
      await expect(refresh).toBeFocused()
      expect((await routes.nth('POST', '/api/v1/hosts/refresh', reads + 1)).body).toEqual({})
      await expect(refresh).toHaveText('Refresh', { timeout: 10_000 })
      await expect(refresh).toBeFocused()
      await refresh.click()
      await expect.poll(() => routes.callsTo('POST', '/api/v1/hosts/refresh').length).toBe(reads + 2)
      await expect(refresh).toHaveText('Refresh', { timeout: 10_000 })
      ran('Pane/button#host-fleet-refresh')
    })

    await test.step('header: Add host (a slow link, the SSH draft, one draft per way in, Cancel and Escape)', async () => {
      await checkAddHost(ctx)
    })

    await test.step('the network map: every machine of the list, as its row says it', async () => {
      const map = page.getByTestId('remote-hosts-map')
      const toggle = page.getByTestId('remote-hosts-map-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toContainText('How this Mac reaches each host.')
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      // One box: the heading and the drawing inside the same card.
      expect(await map.evaluate((el) => !!el.querySelector('.settings-fold-group-heading') && !!el.querySelector('[data-testid="host-fleet-topology"]'))).toBe(true)
      const nodes = page.getByTestId('host-fleet-topo-node')
      const hosts = await nodes.evaluateAll((els) => els.map((el) => el.getAttribute('data-host')!))
      // 2026-11-04 review: the map drew 3 of the 6 hosts.
      expect([...hosts].sort()).toEqual(['__local__', 'devbox', 'downbox', 'fixture-remote', 'gpu-box'])
      const node = (h: string) => page.locator(`[data-testid="host-fleet-topo-node"][data-host="${h}"]`)
      const link = (h: string) => page.locator(`[data-testid="host-fleet-topo-link"][data-host="${h}"]`)
      await expect(node('__local__').locator('.hf-topo-name')).toHaveText('This Mac')
      // A host switched off is drawn off, whatever an old reading said (it drew one green).
      await expect(node('fixture-remote')).toHaveAttribute('data-kind', 'off')
      await expect(link('fixture-remote')).toHaveText('Off')
      await expect(node('downbox')).toHaveAttribute('data-kind', 'failed')
      await expect(link('downbox')).toHaveText('Not connected')
      await expect(link('devbox')).toHaveText('SSH tunnel, 38 ms')
      await sweep()
      for (const host of hosts) {
        await node(host).click()
        const target = page.locator(`[id="rh-host-${host}"]`)
        await expectRing(page, target)
        await expect(target).toBeInViewport()
      }
      // Acting on another row takes the mark away: only the row whose menu is open is marked
      // (2026-11-04 review: the map's row kept its ring while Alpha box's menu was open).
      const landed = page.locator(`[id="rh-host-${hosts.at(-1)}"]`)
      await row(page, 'devbox').getByTestId('rh-row-more').click()
      await expect(page.locator('[data-menu-open="true"]')).toHaveCount(1)
      await expect(row(page, 'devbox')).toHaveAttribute('data-menu-open', 'true')
      await expect(landed).not.toHaveAttribute('data-landed', 'true')
      await expect(landed).not.toBeFocused()
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-menu-open="true"]')).toHaveCount(0)
      await toggle.click()
      await expect(nodes.first()).toBeHidden()
      ran('Network map/button#remote-hosts-map-toggle', 'Network map/button#host-fleet-topo-node')
    })

    await test.step('Alpha box: its menu, Details with This host, Install, Set up', async () => { await checkAlphaRow(ctx) })

    await test.step('Alpha box: Edit (Escape closes), keep switches, Turn off and on (the summary and the map move at once), Remove asks', async () => {
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

      // Turn off saves it off, and the summary and the map say so at once (2026-11-04 review:
      // "2 of 4 online" through Turn off, Add and Remove); Turn on, its one action now, saves it on.
      const puts = routes.callsTo('PUT', '/api/config').length
      await pick(page, alpha, 'Turn off')
      expect(((await routes.nth('PUT', '/api/config', puts + 1)).body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(false)
      await expect(alpha.getByTestId('rh-row-state')).toHaveText('Off: Walnut does not connect to it.')
      await expect(counts).toContainText('6 hosts: 1 online, 2 not connected, 2 off, 1 found in ~/.ssh/config, ')
      // An Off host is off on purpose: no Needs a look, no look line, not in the header's count
      // (2026-11-05 review: a host turned off still read "Needs a look").
      await expect(alpha.getByTestId('rh-look-tag')).toHaveCount(0)
      await expect(alpha).not.toHaveAttribute('data-needs-look', 'true')
      await expect(alpha).not.toContainText('needs a look')
      // It says it is off, and nothing older (its Set up note went with it).
      await expect(alpha.locator('.rh-row-line')).toHaveCount(0)
      // Its name keeps its contrast (second-model review: the off row's name was drawn at 45%).
      expect(Number(await alpha.locator('.rh-host-name').evaluate((el) => getComputedStyle(el).opacity))).toBe(1)
      await shot(page, 'alpha-turned-off')
      await expect(page.locator('[data-testid="host-fleet-topo-node"][data-host="devbox"]')).toHaveAttribute('data-kind', 'off')
      await sweep()
      await alpha.getByTestId('rh-turn-on').click()
      expect(((await routes.nth('PUT', '/api/config', puts + 2)).body as { hosts: Record<string, { enabled: boolean }> }).hosts.devbox.enabled).toBe(true)
      await expect(alpha.getByTestId('rh-turn-on')).toHaveCount(0)
      await expect(counts).toContainText('6 hosts: 2 online, 2 not connected, 1 off, 1 found in ~/.ssh/config, ')
      await expectFocusKept(page)
      ran('Row menu/menuitem[turn-off]')

      // Remove: last, red, and it asks, naming the host; Cancel (focused) and Escape keep it.
      const calls = routes.calls.length
      await pick(page, alpha, 'Remove')
      const confirm = page.getByTestId('rh-row-confirm')
      await expect(confirm).toContainText('Remove Alpha box?')
      await expect(confirm.getByTestId('rh-row-confirm-remove')).toHaveClass(/settings-button-danger/)
      await expect(confirm.getByTestId('rh-row-confirm-cancel')).toBeFocused()
      // No timer puts it back (the old armed buttons turned back after 3 s).
      await page.waitForTimeout(3_300)
      await expect(confirm).toBeVisible()
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

    await test.step('a new host: its alias follows the hostname; a taken one is refused; Saved, and counted at once', async () => {
      await checkNewHost(ctx)
    })

    await test.step('lab-mac, found in ~/.ssh/config: Not now in its menu; Connect: Connecting..., then Connected', async () => {
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
      const release = routes.gate('found:lab-mac')
      await connect.focus()
      await page.keyboard.press('Enter')
      await expect(connect).toHaveText('Connecting...')
      release()
      expect((await routes.nth('POST', '/api/hosts/lab-mac/found-answer', 2)).body).toEqual({ answer: 'yes' })
      await expect(q).toHaveCount(0)
      await expect(lab.getByTestId('host-fleet-action-note')).toHaveText('Connected.')
      await expectFocusKept(page)
      ran('Hosts/button#rh-found-connect')
    })

    await test.step('Beta box, not connected: Details with This host, Show again, Retry SSH, Turn off and on', async () => {
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
      // The timeout is said once, on the row (2026-11-05 review: on the row, as a heading, and as a
      // red Connection line; then on the row and as the Details' headline), its ssh output folded in
      // Details, and a host Walnut cannot reach is not judged for long jobs (the review: "Not for
      // jobs that must keep running" twice).
      await expect(beta.getByTestId('rh-row-state')).toHaveText('Connecting to Beta box timed out')
      expect(await details.evaluate((el) => (el.textContent!.match(/timed out/gi) ?? []).length)).toBe(0)
      await expect(details.locator('[data-row="connection"]')).toHaveCount(0)
      await expect(details.getByTestId('host-fleet-fit')).toHaveCount(0)
      expect(await details.evaluate((el) => /must keep running/.test(el.textContent!))).toBe(false)
      // Nothing its row says is said again in them (the row's warning lines and its state line).
      await openHostParts(details, ['status', 'this-host'])
      expect(await expectRowLinesNotRepeated(beta, details)).toContain('Connecting to Beta box timed out')
      await checkBetaThisHost(ctx, details)
      await details.scrollIntoViewIfNeeded()
      await shot(page, 'beta-details')
      // Hide details at their top closes them, the focus back on the row's More (the review: they
      // closed only from the row's menu).
      await details.getByTestId('rh-details-hide').click()
      await expect(details).toHaveCount(0)
      await expect(beta.getByTestId('rh-row-more')).toBeFocused()
      ran('Hosts/button#rh-details-hide')

      // Hidden from the home page: said once, its way back beside it (the review: "You hid this
      // problem on the home page." with the fix in the row's menu).
      const hiddenLine = beta.getByTestId('rh-banner-hidden')
      await expect(hiddenLine).toHaveText('Hidden from the home page. Show it there again')
      await expect(menu(page)).toHaveCount(0)
      await sweep()
      await hiddenLine.getByTestId('rh-show-again').click()
      await expect(hiddenLine).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('open-walnut-host-banner-dismissed') ?? '')).not.toContain('downbox')
      await expectFocusKept(page)
      ran('Hosts/button#rh-show-again')

      // Its retry says it is an SSH one (2026-11-04 review: two "Retry" buttons on the page);
      // it fails the same way again, and the row keeps the focus and the reason.
      const retry = beta.getByTestId('rh-row-connect')
      await expect(retry).toHaveText('Retry SSH')
      const tries = (await fixtureCounters(request)).connect.downbox ?? 0
      await retry.focus()
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await fixtureCounters(request)).connect.downbox).toBe(tries + 1)
      await expect(retry).toHaveText('Retry SSH', { timeout: 15_000 })
      await expect(beta.getByTestId('host-fleet-action-note')).toHaveCount(0)
      await expectFocusKept(page)

      // Turn on dials it: Retrying... while its save lands, then Connected. The summary moves at
      // once each way, every row in one count (lab-mac's fixture status may flip back from the
      // Connected its routed answer seeded: read the off count and the sum, not fixed numbers).
      const num = async (id: string) => { const el = page.getByTestId(id); return (await el.count()) ? Number((await el.textContent())!.match(/^(\d+)/)![1]) : 0 }
      const fleetNow = async () => ({ online: await num('rh-summary-online'), down: await num('rh-summary-down'), off: await num('rh-summary-off'), found: await num('rh-summary-found'), hosts: await num('rh-summary-hosts') })
      const adds = (f: Awaited<ReturnType<typeof fleetNow>>) => f.online + f.down + f.off + f.found === f.hosts
      const before = await fleetNow()
      expect(adds(before)).toBe(true)
      const puts = routes.callsTo('PUT', '/api/config').length
      await pick(page, beta, 'Turn off')
      await routes.nth('PUT', '/api/config', puts + 1)
      await expect.poll(async () => (await fleetNow()).off).toBe(before.off + 1)
      expect(adds(await fleetNow())).toBe(true)
      await hostFixture(request, { action: 'set-next-connect', host: 'downbox', result: 'ok' })
      const saving = routes.gate('config-put')
      await beta.getByTestId('rh-turn-on').click()
      await expect(beta.getByTestId('rh-row-connect')).toHaveText('Retrying...')
      saving()
      await expect(beta.getByTestId('host-fleet-action-note')).toHaveText('Connected.', { timeout: 15_000 })
      expect((await fixtureCounters(request)).connect.downbox).toBe(tries + 2)
      await expect.poll(async () => (await fleetNow()).off).toBe(before.off)
      expect(adds(await fleetNow())).toBe(true)
      await expectFocusKept(page)
      ran('Hosts/button#rh-turn-on')
    })

    await test.step('the join link, and gpu-box, a machine that joined with one', async () => {
      await joinPress(page)
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
      const confirm = page.getByTestId('rh-row-confirm')
      await expect(confirm).toContainText('Remove gpu-box?')
      // A removal that fails keeps the question open, its error on the row, the focus on Remove
      // (review: the question closed at once, the focus fell, and the error had nothing to retry).
      routes.failMachineRemoves = ['walnut-net did not answer']
      const confirmRemove = confirm.getByTestId('rh-row-confirm-remove')
      // The question opens with Cancel focused (one confirm style for every removal).
      await expect(confirm.getByTestId('rh-row-confirm-cancel')).toBeFocused()
      await confirmRemove.focus()
      await page.keyboard.press('Enter')
      await routes.nth('DELETE', '/api/hosts/net/machines/gpu-box', 1)
      await expect(gpu.getByRole('alert')).toHaveText('walnut-net did not answer')
      await expect(confirm).toBeVisible()
      await expect(confirmRemove).toBeFocused()
      // While one runs it says Removing... and keeps the focus; Escape does not take it back.
      const released = routes.gate('machine-remove')
      await page.keyboard.press('Enter')
      await expect(confirmRemove).toHaveText('Removing...')
      await expect(confirmRemove).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(confirm).toBeVisible()
      released()
      await routes.nth('DELETE', '/api/hosts/net/machines/gpu-box', 2)
      await expect(gpu).toHaveCount(0)
      // The focus goes to the row before it, never to the page.
      await expect(page.locator(':focus')).toHaveAttribute('data-row-key', /^(ssh|fleet|net):/)
    })

    await test.step('This Mac: its reading and its own settings in Details', async () => {
      const mac = row(page, '__local__')
      await mac.getByTestId('rh-row-more').click()
      await expect(menu(page).getByRole('menuitem')).toHaveText(['Details'])
      await menu(page).getByRole('menuitem', { name: 'Details' }).click()
      const details = page.locator('[data-testid="rh-details"][data-host="__local__"]')
      await expect(details.getByTestId('host-fleet-card')).toBeVisible()
      // Details in parts (2026-11-05 review: one long page): Status, This host (and, on a saved
      // SSH host, What Walnut knows), each folding on its own; which are open is remembered for
      // the browser session (Alpha box's and Beta box's opened This host here; a fresh page has
      // it folded: remote-hosts-narrow.spec.ts). Folded, a part says what is inside.
      const partToggle = (id: string) => details.getByTestId(`rh-details-part-${id}`)
      await expect(partToggle('status')).toHaveAttribute('aria-expanded', 'true')
      if ((await partToggle('this-host').getAttribute('aria-expanded')) === 'true') await partToggle('this-host').click()
      await expect(partToggle('this-host')).toHaveAttribute('aria-expanded', 'false')
      await expect(partToggle('this-host')).toContainText('Session limit, tasks from other hosts, secrets')
      await expect(details.getByTestId('rh-this-host-__local__')).toHaveCount(0)
      await sweep()
      await partToggle('status').click()
      await expect(details.getByTestId('host-fleet-card')).toHaveCount(0)
      await partToggle('status').click()
      await expect(details.getByTestId('host-fleet-card')).toBeVisible()
      await openHostParts(details)
      await expectRowLinesNotRepeated(mac, details)
      const part = details.getByTestId('rh-this-host-__local__')
      // An empty limit reads as the default, not as a field turned off (the review: "Empty: 7").
      await expect(part.locator('#rh-limit-__local__')).toHaveAttribute('placeholder', '7 (default)')
      await expect(part.getByRole('switch', { name: 'Tasks on other hosts may use This Mac' })).toBeVisible()
      // Ticking This Mac gives a secret to the sessions here (secretsForHost(LOCAL)): said so. The
      // Mac keeps every secret either way, so each state of its switch is said in words about
      // its sessions, never a copy or a send (2026-11-05 review: "Not copied here", "Sending it
      // here..."): off, saving, on, saving off, and a refused change.
      const give = part.getByRole('switch', { name: 'Give github-read to sessions on This Mac' })
      await expect(give).toBeVisible()
      const giveLine = part.locator('[data-secret-copy="github-read"]')
      const words = async (want: string) => {
        await expect(giveLine).toContainText(want)
        expect(await part.locator('[data-secret-copy]').allTextContents()).not.toContainEqual(expect.stringMatching(/cop(y|ied)|send/i))
      }
      await expect(give).toHaveAttribute('aria-checked', 'false')
      await words('Not given to sessions here.')
      routes.copyOnShare = true
      for (const [to, saving, done] of [['true', 'Turning on...', 'Sessions here get it.'], ['false', 'Turning off...', 'Not given to sessions here.']] as const) {
        const held = routes.gate('secret')
        await give.click()
        await expect(give).toHaveAttribute('aria-busy', 'true')
        await words(saving)
        held()
        await expect(give).not.toHaveAttribute('aria-busy', 'true')
        await expect(give).toHaveAttribute('aria-checked', to)
        await words(done)
        if (to === 'true') await shot(page, 'this-mac-secret-on')
      }
      routes.failSecretPuts.push('the local session helper did not answer')
      await give.click()
      await expect(part.locator('[data-secret-copy="github-read"] + .settings-row-error')).toHaveText('Could not change it: the local session helper did not answer')
      await expect(give).toHaveAttribute('aria-checked', 'false')
      await words('Not given to sessions here.')
      await shot(page, 'this-mac-secret-refused')
      routes.copyOnShare = false
      // Walnut runs here already: no "Walnut on this host" part for this Mac.
      await expect(part.getByTestId('host-server-part')).toHaveCount(0)
      await sweep()
      await shot(page, 'this-mac-details-parts')
      ran('Hosts/button#rh-details-part-status', 'Hosts/button#rh-details-part-this-host')
      // The name and Hide details stay at the top while Details scroll (sticky head).
      const head = details.locator('.rh-details-head')
      await page.locator('.settings-pane').first().evaluate((el, y) => { el.scrollTop += y }, 500)
      await expect(details.getByTestId('rh-details-hide')).toBeInViewport()
      expect(await head.evaluate((el) => getComputedStyle(el).position)).toBe('sticky')
      // Held right under the pane's bar, never under it or with a gap the parts show through.
      const bar = (await page.locator('.settings-pane-stickybar.is-compact .settings-pane-stickybar-inner').boundingBox())!
      await expect.poll(async () => Math.round((await head.boundingBox())!.y - (bar.y + bar.height))).toBeGreaterThanOrEqual(-1)
      expect(Math.round((await head.boundingBox())!.y - (bar.y + bar.height))).toBeLessThanOrEqual(2)
      await shot(page, 'this-mac-details-scrolled')
      // Escape inside Details closes them, the focus back on More.
      await part.locator('#rh-limit-__local__').focus()
      await page.keyboard.press('Escape')
      await expect(details).toHaveCount(0)
      await expect(mac.getByTestId('rh-row-more')).toBeFocused()
    })

    await test.step('Big remote host, off: Turn on, and a dial that fails says why, in the words of Turn on', async () => {
      // 2026-11-05 review: after Turn on the row said only "Could not retry right now.", for a Retry
      // nobody pressed. (Here the save stays in the page's routes, so the server still has the
      // host off and refuses the dial: the words say that.)
      const big = row(page, 'fixture-remote')
      const turnOn = big.getByTestId('rh-turn-on')
      await expect(turnOn).toHaveText('Turn on')
      const puts = routes.callsTo('PUT', '/api/config').length
      await turnOn.click()
      expect(((await routes.nth('PUT', '/api/config', puts + 1)).body as { hosts: Record<string, { enabled: boolean }> }).hosts['fixture-remote'].enabled).toBe(true)
      await expect(big.getByTestId('host-fleet-action-error')).toHaveText(/^Turned on, but Walnut could not connect: Walnut has it turned off here\.( .+ tries again\.)?$/, { timeout: 15_000 })
      await expect(big).not.toContainText('Could not retry right now')
      await expectFocusKept(page)
      // Off again, as the rest of the run has it.
      await pick(page, big, 'Turn off')
      await routes.nth('PUT', '/api/config', puts + 2)
      await expect(big.getByTestId('rh-turn-on')).toBeVisible()
    })

    await test.step('More settings: Relay', async () => { await checkMoreSettings(ctx) })
    await test.step('More settings: Secrets', async () => { await checkSecrets(ctx) })

    await test.step('Removals to confirm: the page\'s one way of asking', async () => {
      const confirm = page.getByTestId('replica-removal-confirm-host:devbox/notes')
      const id = 'replica-removal-ask-host:devbox/notes'
      await expect(confirm).toHaveText('Remove them there')
      await askThenCancel(page, routes, confirm, id, 'Remove them from the copy on Alpha box?')
      await confirm.click()
      const ask = page.getByTestId(id)
      await expect(ask).toContainText('They are gone there too; this Mac keeps its own.')
      await sweep()
      await ask.getByTestId(`${id}-remove`).click()
      expect((await routes.nth('POST', '/api/replicas/confirm-removal', 1)).body).toEqual({ target: 'host:devbox', kind: 'notes', entries: 80, keys: 'k80' })
      await expect(page.getByTestId('replica-removal-host:devbox/notes')).toHaveAttribute('data-removal', 'armed')
      await expect(confirm).toHaveCount(0)
      await expectFocusKept(page)
      ran('Removals to confirm/button#replica-removal-confirm-host:<host>/notes', `Removals to confirm/button#replica-removal-ask-host:<host>/notes-cancel`, `Removals to confirm/button#replica-removal-ask-host:<host>/notes-remove`)
    })

    await test.step('the page end: Copy diagnostics copies the hosts section, the focus kept', async () => {
      const diag = page.getByTestId('remote-hosts-copy-diagnostics')
      await diag.scrollIntoViewIfNeeded()
      await expect(diag).toHaveText('Copy diagnostics')
      await sweep()
      const read = page.waitForRequest((r) => new URL(r.url()).pathname === '/api/diagnostics' && new URL(r.url()).searchParams.get('section') === 'hosts')
      // From the keyboard: busy, it keeps the focus (2026-11-04 review: it fell to the page).
      await diag.focus()
      await page.keyboard.press('Enter')
      await read
      await expect(diag.filter({ hasText: 'Copied' }).or(page.locator('.settings-build-line-error:visible'))).toBeVisible({ timeout: 20_000 })
      await expect(diag).toBeFocused()
      ran('Footer/button#remote-hosts-copy-diagnostics')
    })

    await test.step('Details\' note mic (last: it leaves the pane)', async () => {
      await pick(page, row(page, 'devbox'), 'Details')
      await openHostParts(page.locator('[data-testid="rh-details"][data-host="devbox"]'), ['knows'])
      const mic = page.getByTestId('host-profile-devbox').locator('button.mic-btn')
      await expect(page.locator('[data-testid="rh-details"][data-host="devbox"]').getByTestId('host-system-line')).toBeVisible()
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
      // Settled first: the header's actions move into the sticky bar on the scroll's event, a frame
      // later (half a second in WebKit under load), and a menu opened before that went with them.
      await expect(page.locator('.settings-pane-stickybar.is-compact .settings-pane-stickybar-inner')).toBeVisible()
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
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

  test('what was typed in a new host outlives leaving the pane; the page grows on a wide window', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await checkDraftKept(await setUp(page, request))
  })
})
