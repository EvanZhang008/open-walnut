/**
 * Cut-off text widens on hover only in a narrow side list of tasks (`data-peek-zone`: Home's task
 * panel), never in a header there (utils/truncation-peek-find.ts peekAllowed). Everywhere else
 * nothing opens: the cut text shows its full text as a native tooltip. 2026-11-23, the user on the
 * Org page head ("这个 title 不要，就是放上去之后还要放大") and on a question card that opened down over
 * the reply box ("但所有东西都放大真的是不太舒服"). The zone list itself: tests/web/truncation-peek-zones.test.ts.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { openTaskSession } from './agent-text-entry-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

test.setTimeout(180_000)

const LONG = 'A long line about the garden rebuild schedule, every supplier and each weekend it is booked for'
const peekOpen = (page: Page) => page.evaluate(() => document.querySelectorAll('[data-peek-open], [data-peek-expanded]').length)

async function openOrg(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await expect(page.locator('.org-list-head')).toBeVisible()
}

/** A cut line of text, as a row, a header or a card head would hold it, put into `parent`. */
async function probe(page: Page, id: string, cls: string, parent: string, top: number): Promise<void> {
  await page.evaluate(({ id, cls, parent, top, long }) => {
    const row = document.createElement('div')
    row.id = id
    row.className = cls
    row.style.cssText = `position:fixed;left:20px;top:${top}px;width:240px;display:flex;background:#fff;z-index:99999;font:13px system-ui`
    row.innerHTML = `<span class="probe-text" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${long}</span>`
    document.querySelector(parent)!.appendChild(row)
  }, { id, cls, parent, top, long: LONG })
}

test('cut text widens only in the Home task panel; anywhere else, and in a header, it keeps its place with a tooltip', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  await probe(page, 'probe-zone-row', 'probe-line', '.todo-panel', 160)
  await probe(page, 'probe-zone-head', 'probe-panel-header', '.todo-panel', 200)
  await probe(page, 'probe-page-line', 'probe-line', 'body', 240)
  await probe(page, 'probe-page-card', 'probe-card-head', 'body', 280)
  await probe(page, 'probe-page-fit', 'probe-strip', 'body', 320)
  await page.locator('#probe-page-fit').evaluate((el) => el.setAttribute('data-fit-header', ''))
  // A question card outside the task panel (a session's ask, the user's 2026-11-23 screenshot): a
  // card with a box to type in, which opens downward only inside the task panel.
  await probe(page, 'probe-page-ask', 'probe-ask', 'body', 360)
  await page.locator('#probe-page-ask').evaluate((el) => {
    el.setAttribute('data-peek-row', ''); el.setAttribute('data-peek-grow', 'down')
    const t = el.querySelector('.probe-text') as HTMLElement
    t.style.cssText = 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal'
    t.textContent = Array(6).fill(t.textContent).join(' ')
    const box = document.createElement('textarea'); el.appendChild(box)
  })
  // In the zone: a line widens.
  await page.locator('#probe-zone-row .probe-text').hover()
  await expect.poll(() => peekOpen(page), 'a line in the task panel widens').toBeGreaterThan(0)
  await page.mouse.move(1, 1)
  await expect.poll(() => peekOpen(page)).toBe(0)
  for (const id of ['probe-zone-head', 'probe-page-line', 'probe-page-card', 'probe-page-fit', 'probe-page-ask']) {
    const text = page.locator(`#${id} .probe-text`)
    const before = await text.boundingBox()
    await text.hover()
    await page.waitForTimeout(400)
    expect(await peekOpen(page), `${id}: nothing opens`).toBe(0)
    expect(await text.boundingBox(), `${id}: nothing moves`).toEqual(before)
    await expect(text, `${id}: the full text is its tooltip`).toHaveAttribute('title', id === 'probe-page-ask' ? /^A long line/ : LONG)
    await page.mouse.move(1, 1)
  }
  await page.evaluate(() => document.querySelectorAll('[id^="probe-"]').forEach((el) => el.remove()))
})

test('the real pages: hovering every cut text outside the task panel opens nothing (a session head, the Org page)', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  await openTaskSession(page, 'Outline fixture task', 'pw-task-pins', 'pw-pins-session')
  const hoverEveryCutText = async (where: string) => {
    const spots = await page.evaluate(() => {
      const out: { x: number; y: number }[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        if (el.closest('[data-peek-zone], [data-peek="off"]') || !(el.textContent ?? '').trim()) continue
        const r = el.getBoundingClientRect()
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
        const cs = getComputedStyle(el)
        const clamped = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 4
        if ((cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) || clamped) out.push({ x: r.x + Math.min(r.width / 2, 20), y: r.y + r.height / 2 })
      }
      return out.slice(0, 40)
    })
    for (const s of spots) {
      await page.mouse.move(s.x, s.y)
      await page.waitForTimeout(250)
      expect(await peekOpen(page), `${where}: hover at ${Math.round(s.x)},${Math.round(s.y)} opens nothing`).toBe(0)
    }
    return spots.length
  }
  await page.locator('.main-page-session-column .session-panel-header').first().evaluate((el) => { (el as HTMLElement).style.width = '260px' })
  let hovered = await hoverEveryCutText('Home with a session head at 260 px')
  // The Org page head the user showed, narrowed until its line of facts cuts.
  await openOrg(page)
  await page.locator('.org-list').evaluate((el) => { (el as HTMLElement).style.width = '200px' })
  const detail = page.locator('.org-detail-head').first()
  await expect(detail).toBeVisible()
  await detail.evaluate((el) => { (el as HTMLElement).style.width = '220px' })
  hovered += await hoverEveryCutText('Org page, its list at 200 px and its detail head at 220 px')
  expect(hovered, 'some real text was cut and hovered').toBeGreaterThan(0)
})
