import { test, expect, type Page, type Route } from '@playwright/test'

const localCwd = '/Users/playwright/flat-fixture/a/very/long/parent/tree/that/forces/the/path/to/truncate/walnut'
const secondLocalCwd = '/Users/playwright/flat-fixture/projects/wallets'
const remoteCwd = '/home/playwright/flat-fixture/remote/repository'
const remoteLabel = 'Big remote host'
const now = new Date().toISOString()

async function fulfillWorkingDirs(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      dirs: [
        { cwd: localCwd, host: null, project: 'Passion', count: 25, lastUsed: now },
        { cwd: secondLocalCwd, host: null, project: 'Work', count: 10, lastUsed: now },
        { cwd: remoteCwd, host: 'remote-fixture', hostLabel: remoteLabel, project: 'Personal', count: 4, lastUsed: now },
      ],
      hosts: [],
    }),
  })
}

async function openPicker(page: Page): Promise<void> {
  await page.setViewportSize({ width: 520, height: 640 })
  await page.route('**/api/sessions/working-dirs', fulfillWorkingDirs)
  await page.goto('/')
  const pill = page.getByRole('button', { name: /Quick session|\+ Session/i })
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()
  await expect(page.locator('.sps-path-list')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.sps-path-item')).toHaveCount(3, { timeout: 20_000 })
}

test('history paths render as flat single-line rows with only remote host metadata', async ({ page }) => {
  await openPicker(page)

  const list = page.locator('.sps-path-list')
  const rows = list.locator('.sps-path-item')
  await expect(list.locator('.sps-group-head')).toHaveCount(0)

  for (let index = 0; index < 3; index++) {
    const row = rows.nth(index)
    const cwd = row.locator('.sps-path-cwd')
    await expect(cwd).toHaveAttribute('title', [localCwd, secondLocalCwd, remoteCwd][index])
    const layout = await row.evaluate(element => {
      const rowStyle = getComputedStyle(element)
      const cwdElement = element.querySelector('.sps-path-cwd') as HTMLElement
      const cwdStyle = getComputedStyle(cwdElement)
      return {
        flexDirection: rowStyle.flexDirection,
        rowHeight: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(rowStyle.lineHeight),
        whiteSpace: cwdStyle.whiteSpace,
        direction: cwdStyle.direction,
        overflowed: cwdElement.scrollWidth > cwdElement.clientWidth,
      }
    })
    expect(layout.flexDirection).toBe('row')
    if (index === 0) {
      // Default (keyboard-placed) selection: expanded — full multi-line path,
      // no truncation. The fixture path is long enough to need 2+ lines.
      expect(layout.whiteSpace).toBe('normal')
      expect(layout.direction).toBe('ltr')
      expect(layout.rowHeight).toBeGreaterThan(2 * layout.lineHeight)
      expect(layout.overflowed).toBe(false)
    } else {
      expect(layout.whiteSpace).toBe('nowrap')
      expect(layout.direction).toBe('rtl')
      expect(layout.rowHeight).toBeLessThan(2 * layout.lineHeight + 14)
    }
  }

  // Hover moves the highlight but must NOT expand the row under the pointer.
  await rows.nth(1).hover()
  await expect(rows.nth(1)).toHaveClass(/active/)
  const hoveredWhiteSpace = await rows.nth(1).locator('.sps-path-cwd')
    .evaluate(element => getComputedStyle(element).whiteSpace)
  expect(hoveredWhiteSpace).toBe('nowrap')
  // …and keyboard reclaims the expansion (ArrowDown moves highlight 1 → 2).
  await page.locator('.sps-search-input').press('ArrowDown')
  await expect(rows.nth(2)).toHaveClass(/sps-expanded/)

  const rowText = (await rows.allTextContents()).join(' ')
  expect(rowText).not.toMatch(/sessions?|ago|Passion|Work|Personal/i)

  // Local rows are labeled too — an unlabeled row is ambiguous about which machine it runs on.
  await expect(rows.nth(0).locator('.sps-path-host-tag')).toHaveText('local')
  await expect(rows.nth(1).locator('.sps-path-host-tag')).toHaveText('local')
  const remoteBadge = rows.nth(2).locator('.sps-path-host-tag')
  await expect(remoteBadge).toHaveText(remoteLabel.slice(0, 10))
  await expect(remoteBadge).toHaveAttribute('title', remoteLabel)
  expect((await remoteBadge.textContent())!.length).toBeLessThanOrEqual(10)

  await page.screenshot({ path: '/tmp/quick-start-flat/verify.png' })

  const input = page.locator('.sps-search-input')
  await rows.nth(1).click()
  await expect(input).toHaveValue(secondLocalCwd)
  await input.press('Shift+Enter')
  await expect(page.locator('.session-path-selector')).not.toBeVisible()
  await expect(page.locator('.qsb-path')).toHaveText(secondLocalCwd)
})

test('live rows: relative segments when idle, full path when highlighted, icon-only history marker', async ({ page }) => {
  await openPicker(page)
  const parent = '/Users/playwright/live-fixture'
  await page.route('**/api/sessions/list-dirs?*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      parent,
      exists: true,
      dirs: [`${parent}/src`, `${parent}/src/AcmeInsights`, `${parent}/src/AcmeWidgets`],
    }),
  }))
  await page.route('**/api/sessions/working-dirs', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      dirs: [{ cwd: `${parent}/src/AcmeInsights`, host: null, project: 'Work', count: 2, lastUsed: now }],
      hosts: [],
    }),
  }))

  await page.reload()
  await page.getByRole('button', { name: /Quick session|\+ Session/i }).click()
  const input = page.locator('.sps-search-input')
  await input.fill(`${parent}/Acm`)

  const rows = page.locator('.sps-path-item')
  await expect(rows).toHaveCount(2)

  // The highlighted row expands to the FULL path (~-shortened) so the target
  // is unambiguous before Enter; the other row stays relative with an "…/"
  // continuation marker (the typed prefix already sits in the input).
  const activeCwd = page.locator('.sps-path-item.active .sps-path-cwd')
  const idleCwd = page.locator('.sps-path-item:not(.active) .sps-path-cwd')
  await expect(activeCwd).toHaveText(/^~\/live-fixture\/src\/Acme(Insights|Widgets)\/$/)
  await expect(idleCwd).toHaveText(/^…\/src\/Acme(Insights|Widgets)\/$/)
  await expect(idleCwd).not.toContainText(parent)

  // Moving the highlight swaps which row is expanded.
  const activeBefore = await activeCwd.getAttribute('title')
  await input.press('ArrowDown')
  await expect(activeCwd).toHaveText(/^~\/live-fixture\/src\/Acme(Insights|Widgets)\/$/)
  const activeAfter = await activeCwd.getAttribute('title')
  expect(activeAfter).not.toBe(activeBefore)
  await expect(idleCwd).toHaveText(/^…\/src\/Acme(Insights|Widgets)\/$/)

  const histRow = page.locator('.sps-path-item', { hasText: 'AcmeInsights' }).first()
  await expect(histRow.locator('.sps-path-cwd')).toHaveAttribute('title', `${parent}/src/AcmeInsights/`)
  await expect(histRow.locator('.sps-hist-marker')).toHaveText('🕘')
  await expect(histRow.locator('.sps-hist-marker')).toHaveAttribute('title', 'In your session history')
})
