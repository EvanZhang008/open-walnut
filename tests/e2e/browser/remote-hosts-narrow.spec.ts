/**
 * Settings > Remote Hosts at 700 px (the phone layout): one column, every row's one action
 * inside its row and in one column with the others, the row buttons as tall as on a wide window
 * when a mouse drives them (2026-11-05 review: every one grew to a 44 px box, and Refresh sat on
 * its own line), the pinned bar one row, the join card's system picker inset and its Copy as tall
 * as the command, More settings' groups inside the window, a host's own settings (This host, in
 * its Details) inside the window, and a secret's form, new or edited, in view at 700x800 (Sol
 * review: only its Name showed, at the window's foot; 2026-11-05 review: Edit opened it at the
 * window's foot with the pinned Save across its first row). The same fixture fleet as
 * remote-hosts-every-button.spec.ts.
 * Navigation by clicks; the window narrows once the pane is open (the phone layout opens the
 * list of panes first).
 * WebKit: `PW_WEBKIT=1 ... --project=webkit`.
 */
import { expect, test, type Locator } from '@playwright/test'
import { openHostParts, resetServerHostFixture } from './host-problems-fixture-helpers'
import { MORE_GROUPS, openFixturePane, pick, row, shot } from './remote-hosts-every-button-helpers'
import { expectFormLanded, shotPart } from './remote-hosts-said-once'

test.setTimeout(180_000)

type Box = { x: number; y: number; width: number; height: number }
const box = async (l: Locator): Promise<Box> => (await l.boundingBox())!

test.describe('Settings > Remote Hosts at 700 px', () => {
  test.describe.configure({ mode: 'serial' })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('one column; each row keeps its action inside it; the bar stays one row; the join card, This host and More settings fit', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openFixturePane(page, request)
    await page.setViewportSize({ width: 700, height: 900 })
    const list = page.getByTestId('remote-hosts-list')
    await expect(list).toBeVisible()

    // One column: the list spans the pane, and nothing on the page is wider than the window.
    const listBox = await box(list)
    expect(listBox.width).toBeGreaterThan(640)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700)

    // The counts, then when it was read and Refresh right after them: no line of its own with a
    // wide gap, and Refresh no taller than on a wide window.
    const line = await box(page.locator('[data-testid="rh-summary"] .rh-summary-line'))
    const refresh = await box(page.getByTestId('host-fleet-refresh'))
    const spend = await box(page.getByTestId('rh-summary-spend'))
    const counts = await box(page.locator('[data-testid="rh-summary"] .rh-summary-counts'))
    const read = await box(page.locator('[data-testid="rh-summary"] .rh-summary-read'))
    expect(refresh.height).toBeLessThanOrEqual(30)
    expect(read.y, 'no blank line before Read and Refresh').toBeLessThanOrEqual(spend.y + spend.height + 8)
    // Wrapped, they start the next line at the counts' left edge; else they follow on the line.
    if (read.y > spend.y + spend.height - 2) expect(Math.abs(read.x - counts.x)).toBeLessThanOrEqual(2)
    expect(line.height).toBeLessThanOrEqual(3 * 24)
    // Refresh reads as a link: its words sit next to "Read ..." (no box padding around them).
    const readAt = await box(page.getByTestId('host-fleet-read'))
    expect(refresh.x - (readAt.x + readAt.width)).toBeLessThanOrEqual(24)
    // The header's Add host is no taller than the row buttons with a mouse.
    expect((await box(page.locator('#remote-hosts .settings-pane-header [data-testid="remote-hosts-add"]'))).height).toBeLessThanOrEqual(30)

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
      expect(more.height, `More of ${await row.getAttribute('data-row-key')} as tall as on a wide window`).toBeLessThanOrEqual(30)
      const primary = row.locator('.rh-row-primary .settings-button')
      if (await primary.count()) {
        const p = await box(primary)
        expect(p.height, `action of ${await row.getAttribute('data-row-key')} as tall as on a wide window`).toBeLessThanOrEqual(30)
        expect(p.y, `action inside ${await row.getAttribute('data-row-key')}`).toBeGreaterThanOrEqual(r.y + 2)
        expect(p.y + p.height).toBeLessThanOrEqual(r.y + r.height + 0.5)
        rights.add(Math.round(p.x + p.width))
      }
    }
    expect(rights.size).toBe(1)
    expect(mores.size).toBe(1)
    await shot(page, 'narrow-700-first-look')

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

    // A host's own settings (2026-11-04 review: they moved from More settings into its Details,
    // under This host): every row of the part inside the window, its controls too.
    const alpha = row(page, 'devbox')
    await alpha.scrollIntoViewIfNeeded()
    await pick(page, alpha, 'Details')
    const details = page.locator('[data-testid="rh-details"][data-host="devbox"]')
    // A fresh page: Status open, This host and What Walnut knows folded (2026-11-05 reviews).
    await expect(details.getByTestId('rh-details-part-status')).toHaveAttribute('aria-expanded', 'true')
    for (const id of ['this-host', 'knows']) await expect(details.getByTestId(`rh-details-part-${id}`)).toHaveAttribute('aria-expanded', 'false')
    await expect(details.getByTestId('rh-this-host-devbox')).toHaveCount(0)
    await openHostParts(details, ['this-host'])
    // Each part's chevron inside the card (it hung in an indent the phone layout does not have).
    for (const chev of await details.locator('.rh-details-part-toggle .settings-disclosure-chevron').all()) {
      expect((await box(chev)).x).toBeGreaterThanOrEqual(listBox.x + 4)
    }
    const part = details.getByTestId('rh-this-host-devbox')
    // Scrolled, the name and Hide details hold right under the phone bar.
    await page.locator('.settings-pane').first().evaluate((el) => { el.scrollTop += 400 })
    const topbar = await box(page.locator('.phone-topbar, [data-testid="phone-topbar"]').first())
    await expect.poll(async () => Math.round((await box(details.locator('.rh-details-head'))).y - (topbar.y + topbar.height))).toBeGreaterThanOrEqual(-1)
    expect(Math.round((await box(details.locator('.rh-details-head'))).y - (topbar.y + topbar.height))).toBeLessThanOrEqual(2)
    await expect(part.locator('#rh-limit-devbox')).toBeVisible()
    await expect(part.getByTestId('host-server-devbox')).toBeVisible()
    for (const control of await part.locator('.settings-row input, .settings-row [role="switch"], .settings-row button').all()) {
      if (!(await control.isVisible())) continue
      const c = await box(control)
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x + c.width).toBeLessThanOrEqual(700)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(700)
    // Hide details, at the top of Details, is as small as the row's buttons.
    expect((await box(details.getByTestId('rh-details-hide'))).height).toBeLessThanOrEqual(30)
    await shot(page, 'narrow-700-details')
    await pick(page, alpha, 'Hide details')

    // More settings: the page's own groups (the relay, the secrets), plain groups inside the one
    // box, each inside the window.
    const more = page.getByTestId('remote-hosts-more-toggle')
    await more.scrollIntoViewIfNeeded()
    await more.click()
    for (const id of MORE_GROUPS) {
      await expect(page.getByTestId(`${id}-toggle`)).toHaveCount(0)
      const g = await box(page.getByTestId(id))
      expect(g.x).toBeGreaterThanOrEqual(0)
      expect(g.x + g.width, `${id} inside the window`).toBeLessThanOrEqual(700)
    }

    // A secret's form at 700x800, new or edited: its start right below the page bar, its first
    // control focused, Save and Cancel whole at its own end, over no row of it.
    await page.setViewportSize({ width: 700, height: 800 })
    const editor = page.getByTestId('secret-editor')
    const addSecret = page.getByTestId('secret-add')
    await addSecret.scrollIntoViewIfNeeded()
    await addSecret.click()
    const name = page.getByTestId('secret-name')
    await expectFormLanded(page, editor, name)
    await shotPart(page, 'narrow-700x800-secret-add', editor)
    await name.press('Escape')
    await expect(editor).toHaveCount(0)
    const edit = page.getByRole('button', { name: 'Edit github-read' })
    await edit.scrollIntoViewIfNeeded()
    await edit.click()
    await expectFormLanded(page, editor, editor.getByRole('button', { name: 'Replace' }))
    await shotPart(page, 'narrow-700x800-secret-edit', editor)
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(edit).toBeFocused()
  })
})
