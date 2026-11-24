import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { openSection, openTasksBy, taskRow } from './org-view-helpers'
import { expectStill, followingOf, peekMarks, peekPill, topsOf } from './truncation-peek-helpers'

// Real list/card components with long team names, at both panel widths and themes. The Org page and
// a Board are no peek zone (2026-11-23, the user: only very narrow places widen; widening everything
// is uncomfortable): hovering cut-off text there opens nothing, the row or card keeps its box, nothing beside
// moves, and the full text is in a native title; a click opens the task.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

type Box = { x: number; y: number; width: number; height: number }
function expectSameBox(now: Box, before: Box, label: string): void {
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(now[k] - before[k]), `${label}: ${k} did not move (${now[k]} vs ${before[k]})`).toBeLessThanOrEqual(0.5)
}

test('Org rows and Board cards open nothing on hover and show cut text in a native title, at narrow and wide panel widths', async ({ page, request }, info) => {
  const project = `Peek surfaces ${Date.now().toString(36)}`
  const title = 'Garden org demo Friday: insight end to end with the complete schedule, every tool and all the next steps for the platform rewrite'
  const made: string[] = []
  try {
    const first = await request.post('/api/tasks', { data: { title, project, source: 'local' } })
    expect(first.status()).toBe(201)
    const firstId = (await first.json()).task.id as string
    made.push(firstId)
    const contact = await request.post('/api/v1/org/contact', { data: { to: project } })
    expect(contact.ok(), await contact.text()).toBe(true)
    const leader = (await contact.json()).task.id as string
    made.push(leader)
    await request.patch(`/api/tasks/${leader}`, { data: { title: 'Garden Re-Architecture As Platform - Platform Lead with the full plan' } })
    for (let i = 0; i < 4; i++) {
      const response = await request.post('/api/tasks', { data: { title: `${title} (${i})`, project, source: 'local', parent_task_id: leader } })
      expect(response.status()).toBe(201)
      made.push((await response.json()).task.id)
    }
    // A task title never cuts (standard.md, "Text that does not fit": it wraps whole), so the row
    // that peeks carries metadata that is still cut: a long note of what it waits on (outside
    // Walnut, so the row stays a Waiting row and is not turned into an ask to the user).
    const NOTE = 'Waiting on the garden supplier to confirm the lumber delivery, the paint colours and the weekend each step of the rebuild is booked for'
    expect((await request.put(`/api/v1/tasks/${made[2]}/report`, { data: { state: 'waiting', waiting_on: NOTE, waiting_kind: 'outside' } })).ok()).toBe(true)
    await expect.poll(async () => ((await (await request.get(`/api/tasks/${made[2]}`)).json()).task.user_status?.state), { timeout: 30_000 }).toBe('waiting')
    const boardRes = await request.get(`/api/v1/tasks/${leader}/board?team=1`)
    expect(boardRes.ok()).toBe(true)
    const board = await boardRes.json()
    expect((await request.put(`/api/v1/tasks/${leader}/board/lanes`, { data: { lanes: board.lanes_effective } })).ok()).toBe(true)
    await home(page)
    await page.getByTestId('sidebar-org').click()
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
    await openTasksBy(page, 'all')
    // Only its own section: the others come and go while the fixture's tasks settle.
    await openSection(page, 'waiting')
    const row = taskRow(page, made[2])
    await expect(row).toBeVisible()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      for (const width of [520, 280]) {
        await page.mouse.move(1, 1)
        await row.evaluate((el, w) => { const list = el.closest<HTMLElement>('.org-task-list')!; list.style.width = `${w}px`; list.style.maxWidth = '100%'; }, width)
        await row.scrollIntoViewIfNeeded()
        const before = (await row.boundingBox())!
        const next = await followingOf(row, `org-${theme}-${width}`)
        const tops = next ? await topsOf([next]) : []
        // The title wraps whole, and the row is its name alone (no line under it, 2026-11-23).
        const title = row.locator('.org-task-title')
        expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis'), `org ${theme} ${width}: the title is whole`).toBe(true)
        await expect(row.getByTestId('org-task-note')).toHaveCount(0)
        await page.screenshot({ path: info.outputPath(`org-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        expectSameBox((await row.boundingBox())!, before, `org ${theme} ${width}: the row`)
        if (next) await expectStill([next], tops, `org ${theme} ${width}: the row below`)
      }
    }
    await openTasksBy(page, 'board')
    const pane = page.getByTestId('task-board-pane')
    await pane.getByTestId('board-view-cards').click()
    const card = pane.locator(`[data-testid="kanban-card"][data-task-id="${made[2]}"]`)
    await expect(card).toBeVisible()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      for (const width of [400, 240]) {
        await page.mouse.move(1, 1)
        await card.evaluate((el, w) => { el.style.width = `${w}px`; el.style.maxWidth = '100%'; }, width)
        await card.scrollIntoViewIfNeeded()
        const before = (await card.boundingBox())!
        // The title wraps whole since d670f86000 dropped its three-line clamp (titles never cut):
        // at both widths it takes the lines it needs, with no clamp and no ellipsis.
        expect(await card.locator('.kanban-card-title').evaluate((el) => {
          const cs = getComputedStyle(el)
          return el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.getPropertyValue('-webkit-line-clamp') === 'none'
        }), `board ${theme} ${width}: the title is whole`).toBe(true)
        const next = await followingOf(card, `board-${theme}-${width}`)
        const tops = next ? await topsOf([next]) : []
        // Hovering the whole title opens nothing and moves nothing. Nothing is cut, so no native
        // title is needed: its words, the end too, are on the card itself.
        const cardTitle = card.locator('.kanban-card-title')
        await expect(cardTitle).toContainText('all the next steps for the platform rewrite')
        const titleBox = (await cardTitle.boundingBox())!
        await cardTitle.hover({ position: { x: 5, y: 5 } })
        await page.waitForTimeout(400) // past the row's open delay (truncation-peek.ts ROW_OPEN_MS)
        expect(await peekMarks(page), `board ${theme} ${width}: hovering opens nothing`).toBe(0)
        await expect(peekPill(page), `board ${theme} ${width}: no floating text pill`).toHaveCount(0)
        expectSameBox((await cardTitle.boundingBox())!, titleBox, `board ${theme} ${width}: the title`)
        await page.screenshot({ path: info.outputPath(`board-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        expectSameBox((await card.boundingBox())!, before, `board ${theme} ${width}: the card`)
        if (next) await expectStill([next], tops, `board ${theme} ${width}: the card below`)
      }
    }
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`)
  }
})
