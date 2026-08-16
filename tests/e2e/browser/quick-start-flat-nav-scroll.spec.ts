import { test, expect, type Page, type Route } from '@playwright/test'
import { openDraft } from './draft-helpers'
const fixtureRoot = '/Users/playwright/quick-nav-fixture'
const now = new Date().toISOString()
const parents = [
  'parent-a', 'parent-a',
  'parent-b',
  'parent-a', 'parent-a',
  'parent-c', 'parent-c',
  'parent-d', 'parent-d',
  'parent-e', 'parent-e',
  'parent-f', 'parent-f',
  'parent-g', 'parent-g',
  'parent-h', 'parent-h',
  'parent-i',
]
const fixtureDirs = parents.map((parent, index) => ({
  cwd: `${fixtureRoot}/${parent}/nav-${String(index + 1).padStart(2, '0')}`,
  host: null,
  count: 200 - index,
  lastUsed: now,
}))

async function fulfillWorkingDirs(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ dirs: fixtureDirs, hosts: [] }),
  })
}

async function openPicker(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 640 })
  await page.route('**/api/sessions/working-dirs', fulfillWorkingDirs)
  await page.goto('/')
  // "+ Session" grows a DRAFT column now; the picker opens from its cwd pill
  // and pops out centered over a scrim (same `.sps-*` markup inside).
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()
  await expect(page.locator('.sps-path-list')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.sps-path-item')).toHaveCount(fixtureDirs.length, { timeout: 20_000 })
}

async function activePath(page: Page): Promise<string> {
  return (await page.locator('.sps-path-item.active .sps-path-cwd').getAttribute('title')) ?? ''
}

test('flat history visits every row once in DOM order and keeps the active row visible', async ({ page }) => {
  await openPicker(page)

  const list = page.locator('.sps-path-list')
  const input = page.locator('.sps-search-input')
  const rows = list.locator('.sps-path-item')
  const expectedOrder = await rows.locator('.sps-path-cwd').evaluateAll(elements =>
    elements.map(element => element.getAttribute('title') ?? ''),
  )
  expect(expectedOrder).toEqual(fixtureDirs.map(dir => dir.cwd))

  const visited = [await activePath(page)]
  for (let index = 1; index < expectedOrder.length; index++) {
    await input.press('ArrowDown')
    await expect.poll(() => activePath(page)).toBe(expectedOrder[index])
    visited.push(await activePath(page))

    if (index === 10) {
      const [activeBox, listBox, scrollMetrics] = await Promise.all([
        list.locator('.sps-path-item.active').boundingBox(),
        list.boundingBox(),
        list.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight })),
      ])
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight)
      expect(scrollMetrics.scrollTop).toBeGreaterThan(0)
      expect(activeBox).not.toBeNull()
      expect(listBox).not.toBeNull()
      expect(activeBox!.y).toBeGreaterThanOrEqual(listBox!.y - 1)
      expect(activeBox!.y + activeBox!.height).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1)
    }
  }
  expect(visited).toEqual(expectedOrder)
  expect(new Set(visited).size).toBe(expectedOrder.length)
  expect(await page.evaluate(() => document.activeElement?.classList.contains('sps-search-input'))).toBe(true)
  await expect(list.locator('.sps-group-head')).toHaveCount(0)

  await input.fill('nav')
  await expect(rows).toHaveCount(fixtureDirs.length)
  const filteredOrder = await rows.locator('.sps-path-cwd').evaluateAll(elements =>
    elements.map(element => element.getAttribute('title') ?? ''),
  )
  expect(filteredOrder).toEqual(expectedOrder)

  const filteredVisited = [await activePath(page)]
  for (let index = 1; index < filteredOrder.length; index++) {
    await input.press('ArrowDown')
    await expect.poll(() => activePath(page)).toBe(filteredOrder[index])
    filteredVisited.push(await activePath(page))
  }
  expect(filteredVisited).toEqual(filteredOrder)
  expect(new Set(filteredVisited).size).toBe(filteredOrder.length)

  await rows.nth(7).hover()
  await expect.poll(() => activePath(page)).toBe(expectedOrder[7])
})
