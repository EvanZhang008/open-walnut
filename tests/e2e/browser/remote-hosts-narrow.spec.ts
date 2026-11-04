/**
 * Settings > Remote Hosts at 700 px (the phone layout): one column, every row's one action
 * inside its row and in one column with the others, the summary's read part on its own line,
 * the pinned bar one row, the join card's system picker inset and its Copy as tall as the
 * command, and More settings' groups each one folded line. The same fixture fleet as
 * remote-hosts-every-button.spec.ts. Navigation by clicks; the window narrows once the pane
 * is open (the phone layout opens the list of panes first).
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { expect, test, type Locator } from '@playwright/test'
import { resetServerHostFixture } from './host-problems-fixture-helpers'
import { openFixturePane } from './remote-hosts-every-button-helpers'

test.setTimeout(180_000)

type Box = { x: number; y: number; width: number; height: number }
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!

test.describe('Settings > Remote Hosts at 700 px', () => {
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('one column; each row keeps its action inside it; the bar stays one row; the join card and More settings fit', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFixturePane(page, request)
    await page.setViewportSize({ width: 700, height: 900 })
    const list = page.getByTestId('remote-hosts-list')
    await expect(list).toBeVisible()

    // One column: the list spans the pane, and nothing on the page is wider than the window.
    const listBox = await box(list)
    expect(listBox.width).toBeGreaterThan(640)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700)

    // The counts on one line, when it was read and Refresh on the next.
    const counts = await box(page.getByTestId('rh-summary-online'))
    const refresh = await box(page.getByTestId('host-fleet-refresh'))
    expect(refresh.y).toBeGreaterThan(counts.y + counts.height - 1)

    // Every row: its action and More inside the row (never over the hairline above it), all
    // the actions ending on one right edge, and every More on one left edge.
    const rows = await list.locator('.rh-host-row').all()
    expect(rows.length).toBeGreaterThanOrEqual(5)
    const rights = new Set<number>()
    const mores = new Set<number>()
    for (const row of rows) {
      const r = await box(row)
      const more = await box(row.getByTestId('rh-row-more'))
      expect(more.y, `More inside ${await row.getAttribute('data-row-key')}`).toBeGreaterThanOrEqual(r.y + 2)
      expect(more.y + more.height).toBeLessThanOrEqual(r.y + r.height + 0.5)
      mores.add(Math.round(more.x))
      const primary = row.locator('.rh-row-primary .settings-button')
      if (await primary.count()) {
        const p = await box(primary)
        expect(p.y, `action inside ${await row.getAttribute('data-row-key')}`).toBeGreaterThanOrEqual(r.y + 2)
        expect(p.y + p.height).toBeLessThanOrEqual(r.y + r.height + 0.5)
        rights.add(Math.round(p.x + p.width))
      }
    }
    expect(rights.size).toBe(1)
    expect(mores.size).toBe(1)

    // Scrolled down, the pane's title and Add host share the one top bar.
    await page.getByTestId('remote-hosts-more-toggle').scrollIntoViewIfNeeded()
    const add = page.locator('[data-testid="remote-hosts-add"]:visible').first()
    await expect(add).toBeVisible()
    const bar = await box(page.locator('.phone-topbar, [data-testid="phone-topbar"]').first())
    expect(bar.height).toBeLessThanOrEqual(64)
    const addBox = await box(add)
    expect(addBox.y).toBeGreaterThanOrEqual(bar.y - 0.5)
    expect(addBox.y + addBox.height).toBeLessThanOrEqual(bar.y + bar.height + 0.5)

    // The join card: the system picker's segments inset in their track, Copy as tall as the command.
    await add.click()
    await page.getByRole('menuitem', { name: /^Join a machine with a link/ }).click()
    const card = page.getByTestId('host-network-invite')
    await expect(card).toBeVisible()
    const mac = await box(page.getByTestId('host-network-os-mac'))
    const track = await box(page.getByTestId('host-network-os-mac').locator('xpath=..'))
    expect(mac.x).toBeGreaterThanOrEqual(track.x + 1.5)
    expect(mac.y).toBeGreaterThanOrEqual(track.y + 1.5)
    const code = await box(page.getByTestId('host-network-command'))
    const copy = await box(page.getByTestId('host-network-copy'))
    expect(Math.abs(code.height - copy.height)).toBeLessThanOrEqual(1)
    expect(copy.height).toBeGreaterThanOrEqual(44)
    await page.getByTestId('host-network-done').click()
    await expect(card).toHaveCount(0)

    // More settings: each group one folded line, its summary under its name, inside the window.
    const more = page.getByTestId('remote-hosts-more-toggle')
    await more.scrollIntoViewIfNeeded()
    await more.click()
    for (const id of ['host-network-relay', 'host-servers', 'host-exec-grants', 'fleet-secrets', 'rh-session-limits']) {
      const toggle = page.getByTestId(`${id}-toggle`)
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      const t = await box(toggle.locator('.settings-fold-group-title'))
      const s = await box(page.getByTestId(`${id}-summary`))
      expect(s.y, `${id} summary under its name`).toBeGreaterThanOrEqual(t.y + t.height - 1)
      expect(s.x + s.width).toBeLessThanOrEqual(700)
    }
  })
})
