/**
 * A phone (390 px) shows one pane where a desktop shows two: no page keeps a desktop column beside
 * another so narrow that its words stand one to a line. 2026-11-26 audit: Memory kept a 110px
 * reader beside its 270px list, its "No file open / Pick a memory file from the list." one word a
 * line. `squeezedPanes` checks every row of tall panes on the page, so a new list-and-reader page,
 * or a phone rule that brings the second column back, fails here.
 * An open reader is the whole screen too: `narrowReaders` fails a document column under 3/4 of
 * the screen (2026-11-26: Memory's file kept the desktop's 54 px gutters, a 225 px column in 390,
 * under a header row that held only the width button).
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE } from './phone-helpers'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})
test.setTimeout(180_000)

/** Each visible pane under 160px wide that holds words and sits beside another tall pane. */
async function squeezedPanes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const tall = innerHeight * 0.4
    for (const row of document.querySelectorAll<HTMLElement>('body *')) {
      const cs = getComputedStyle(row)
      if (!cs.display.includes('flex') && !cs.display.includes('grid')) continue
      if (cs.display.includes('flex') && cs.flexDirection.startsWith('column')) continue
      const panes = [...row.children].filter((c): c is HTMLElement => {
        const r = c.getBoundingClientRect()
        return r.width > 0 && r.height >= tall && getComputedStyle(c).visibility !== 'hidden'
      })
      if (panes.length < 2) continue
      const top = panes[0].getBoundingClientRect().top
      const beside = panes.filter((p) => Math.abs(p.getBoundingClientRect().top - top) < 4)
      if (beside.length < 2) continue
      for (const p of beside) {
        const w = p.getBoundingClientRect().width
        const words = (p.innerText || '').trim()
        if (w < 160 && words.length >= 4) out.push(`${p.className || p.tagName} is ${Math.round(w)}px beside ${beside.length - 1} other pane(s): "${words.slice(0, 40)}"`)
      }
    }
    return out
  })
}

/** Each visible editor document whose text column is under 3/4 of the screen. */
async function narrowReaders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('.notes-editor .tiptap')) {
      if (el.getBoundingClientRect().width === 0) continue
      const cs = getComputedStyle(el)
      const column = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      if (column < innerWidth * 0.75) out.push(`text column is ${Math.round(column)}px of ${innerWidth} (padding ${cs.paddingLeft} / ${cs.paddingRight})`)
    }
    return out
  })
}

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 60_000 })
}

const MENU_PAGES = ['Notes', 'Mail', 'Routines', 'Passwords', 'Apps']
const MANAGE_PAGES = ['agents', 'commands', 'memory']

test('pages from the menu show no squeezed pane at 390', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.goto('/')
  for (const name of MENU_PAGES) {
    await openMenu(page)
    await page.locator('#primary-sidebar').getByRole('link', { name, exact: true }).click()
    await page.waitForTimeout(1500)
    expect(await squeezedPanes(page), name).toEqual([])
  }
})

test('Agents, Commands and Memory show no squeezed pane at 390, and Memory opens a file over its list', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.goto('/')
  for (const id of MANAGE_PAGES) {
    await openMenu(page)
    await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
    await page.getByTestId(`settings-nav-${id}`).click()
    await page.waitForTimeout(1500)
    expect(await squeezedPanes(page), id).toEqual([])
  }
  // Memory, the page that showed it: the list fills the page; a file fills it in turn, and Back
  // returns to the list.
  const list = page.locator('.memory-list-pane')
  await expect(list).toBeVisible()
  const whole = (await page.locator('.memory-split-view').boundingBox())!.width
  expect(Math.abs((await list.boundingBox())!.width - whole), 'the list is the whole page').toBeLessThan(2)
  await expect(page.locator('.memory-detail-pane')).toBeHidden()
  await page.locator('.memory-list-pane').getByText(/USER\.md|MEMORY\.md/).first().click()
  const detail = page.locator('.memory-detail-pane')
  await expect(detail).toBeVisible()
  expect(whole - (await detail.boundingBox())!.width, 'the file is the whole page (less a scroll bar)').toBeLessThan(20)
  await expect(list).toBeHidden()
  expect(await squeezedPanes(page)).toEqual([])
  // Its text fills the screen, and no row stands empty for a width button a phone has no use for.
  await expect(detail.locator('.notes-editor .tiptap')).toBeVisible()
  expect(await narrowReaders(page)).toEqual([])
  await expect(detail.locator('.notes-width-btn')).toHaveCount(0)
  await expect(detail.locator('.notes-editor-header')).toHaveCount(0)
  // The top bar names the file and its Back returns to the list.
  await page.getByRole('button', { name: /back/i }).first().click()
  await expect(list).toBeVisible()
  await expect(detail).toBeHidden()
})

test('an open note on the Notes page fills the screen at 390', async ({ page }) => {
  await isolateUiPrefs(page)
  const name = `phone-reader-${test.info().project.name}`
  const res = await page.request.put(`/api/notes-v2/content/${name}.md`, { data: { content: `# ${name}\n\nA note long enough to wrap across a few lines on a phone, so its column shows.` } })
  expect(res.ok(), await res.text()).toBe(true)
  await page.goto('/')
  await openMenu(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Notes', exact: true }).click()
  const item = page.locator('.notes-tree-pane').getByText(name, { exact: true }).first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.click()
  await expect(page.locator('.notes-editor-pane .ProseMirror')).toBeVisible({ timeout: 15_000 })
  expect(await narrowReaders(page)).toEqual([])
  expect(await squeezedPanes(page)).toEqual([])
})
