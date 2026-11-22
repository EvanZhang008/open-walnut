import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { openAllSections, openTasksBy, taskRow } from './org-view-helpers'
import { expectRestored, expectStill, expectWidensInPlace, followingOf, openInRow, topsOf } from './truncation-peek-helpers'

// Real list/card components with long team names, at both panel widths and themes: each widens
// as a whole at its own height (2026-11-15, the user: wider, not taller), and nothing beside moves.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

test('Org rows and Board cards widen whole at their own height, at narrow and wide panel widths', async ({ page, request }, info) => {
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
    const boardRes = await request.get(`/api/v1/tasks/${leader}/board?team=1`)
    expect(boardRes.ok()).toBe(true)
    const board = await boardRes.json()
    expect((await request.put(`/api/v1/tasks/${leader}/board/lanes`, { data: { lanes: board.lanes_effective } })).ok()).toBe(true)
    await home(page)
    await page.getByTestId('sidebar-org').click()
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
    await openTasksBy(page, 'all')
    await openAllSections(page)
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
        // A task title never cuts (standard.md, "Text that does not fit"): it wraps in full, so
        // there is nothing to peek, and hovering leaves the row and the one below where they are.
        const title = row.locator('.org-task-title')
        expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis'), `org ${theme} ${width}: the title is whole`).toBe(true)
        await row.hover({ position: { x: 16, y: 5 } })
        if (next) await expectStill([next], tops, `org ${theme} ${width}: the row below`)
        await page.screenshot({ path: info.outputPath(`org-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        await expectRestored(row, before, `org ${theme} ${width}`)
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
        const titleBox = (await card.locator('.kanban-card-title').boundingBox())!
        // The title is a three-line clamp; at both widths this real title must be cut.
        expect(await card.locator('.kanban-card-title').evaluate((el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)).toBe(true)
        const next = await followingOf(card, `board-${theme}-${width}`)
        const tops = next ? await topsOf([next]) : []
        await card.hover({ position: { x: titleBox.x - before.x + 5, y: titleBox.y - before.y + 5 } })
        // The clamped title opens on one line in its own box; the card is as tall as it was.
        await expectWidensInPlace(card, before, { label: `board ${theme} ${width}`, theme })
        await expect.poll(() => openInRow(card.locator('.kanban-card-title'))).toBe(true)
        if (next) await expectStill([next], tops, `board ${theme} ${width}: the card below`)
        await page.screenshot({ path: info.outputPath(`board-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        await expectRestored(card, before, `board ${theme} ${width}`)
      }
    }
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`)
  }
})
