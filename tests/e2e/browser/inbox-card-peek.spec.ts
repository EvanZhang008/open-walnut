import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { openInRow, peekPill } from './truncation-peek-helpers'

test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

const SUBJECT = 'A letter with a full-length subject: review the neighbourhood garden schedule, the tool inventory and all the next steps before the weekend'
const PREVIEW = 'The garden group needs a reply about the whole schedule. Check the tools, confirm the available dates, and bring the inventory notes from the last meeting. '.repeat(4)

test('dense inbox cards grow as a whole, preserve actions, and recover after leaving and resizing', async ({ page, request }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const ids: string[] = []
  try {
    for (let i = 0; i < 12; i++) {
      const response = await request.post('/api/v1/human-inbox', { data: { subject: `${SUBJECT} (${i})`, type: 'review', markdown: PREVIEW } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await home(page)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    const card = panel.locator(`[data-letter-id="${ids[11]}"]`)
    const following = panel.locator(`[data-letter-id="${ids[10]}"]`)
    await card.scrollIntoViewIfNeeded()
    await page.mouse.move(1, 1)
    const before = (await card.boundingBox())!
    const below = (await following.boundingBox())!.y
    expect(await card.locator('.hib-subject').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath('before.png') })
    for (let round = 0; round < 3; round++) {
      // Blank card padding is enough, not only the text itself.
      await card.hover({ position: { x: before.width - 6, y: 6 } })
      await expect.poll(() => openInRow(card.locator('.hib-subject'))).toBe(true)
      await expect.poll(() => openInRow(card.locator('.hib-preview'))).toBe(true)
      const after = (await card.boundingBox())!
      expect(after.height).toBeGreaterThan(before.height + 20)
      expect(after.y).toBeCloseTo(before.y, 0)
      expect(after.width).toBeCloseTo(before.width, 0)
      expect((await following.boundingBox())!.y).toBeGreaterThan(below + 20)
      await expect(peekPill(page)).toHaveCount(0)
      await expect(card.locator('.hib-card-toggle')).toHaveAttribute('aria-expanded', 'false')
      if (round === 0) await page.screenshot({ path: info.outputPath('whole-card.png') })
      await page.mouse.move(1, 1)
      await expect(card).not.toHaveAttribute('data-peek-expanded')
      expect((await card.boundingBox())!.height).toBeCloseTo(before.height, 0)
    }
    // A button press must not move its target or open the reader accidentally.
    await card.hover({ position: { x: before.width - 6, y: 6 } })
    await expect(card).toHaveAttribute('data-peek-expanded', '')
    await card.getByRole('button', { name: 'Pin', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible()
    await expect(page.locator('.hib-reader')).toHaveCount(0)
    await card.getByRole('button', { name: 'Read letter', exact: true }).click()
    await expect(card.locator('.hib-card-toggle')).toHaveAttribute('aria-expanded', 'true')
    await page.mouse.move(1, 1)
    await expect(card.locator('.hib-card-expand')).toHaveClass(/is-expanded/)
    await card.getByRole('button', { name: 'Collapse', exact: true }).click()
    await page.mouse.move(1, 1)
    await page.setViewportSize({ width: 720, height: 800 })
    await card.scrollIntoViewIfNeeded()
    await card.hover({ position: { x: 5, y: 5 } })
    await expect.poll(() => openInRow(card.locator('.hib-subject'))).toBe(true)
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.mouse.move(1, 1)
    await card.locator('.hib-subject').focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.hib-reader')).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    for (const id of ids) await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  }
})

test('new unmarked components and rows with more than eight texts have no floating fallback', async ({ page }) => {
  await home(page)
  await page.mouse.move(1, 1)
  await page.evaluate(() => {
    const fixture = document.createElement('section')
    fixture.id = 'peek-class-fixture'
    fixture.style.cssText = 'position:fixed;left:40px;top:100px;width:260px;z-index:9999;background:var(--bg)'
    fixture.innerHTML = `<div data-peek-row="" id="many-texts" style="height:216px;overflow:visible">${Array.from({ length: 12 }, (_, i) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Row ${i}: ${'A detailed entry with all of its words shown inside this component. '.repeat(2)}</div>`).join('')}</div><div id="new-container"><span id="new-text" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${'A new component also grows in flow. '.repeat(5)}</span></div><div id="following">Following component</div><div role="listbox"><div role="option" id="option-a" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A long option name with many words that should only expand this option, never the whole list</div><div role="option" id="option-b" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A second long option that must remain truncated while the first option is hovered</div></div><div id="icon-line" style="display:flex;width:240px;gap:8px"><span id="line-icon" style="flex:none">○</span><span id="line-text" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">A long status text must keep its own icon beside the first line while wrapping inside the available space</span></div>`
    document.body.appendChild(fixture)
  })
  const many = page.locator('#many-texts')
  await many.hover({ position: { x: 5, y: 5 } })
  await expect(many.locator('[data-peek-open]')).toHaveCount(12)
  await page.mouse.move(1000, 100)
  await expect(many).not.toHaveAttribute('data-peek-expanded')
  const before = (await page.locator('#following').boundingBox())!.y
  await page.locator('#new-text').hover()
  await expect(page.locator('#new-container')).toHaveAttribute('data-peek-expanded', '')
  await expect.poll(() => openInRow(page.locator('#new-text'))).toBe(true)
  expect((await page.locator('#following').boundingBox())!.y).toBeGreaterThan(before)
  await expect(peekPill(page)).toHaveCount(0)
  // A live text replacement drops stale marks, then the current text can open again.
  await page.locator('#new-text').evaluate((el) => { el.textContent = 'Changed entry: '.repeat(20) })
  await page.mouse.move(1000, 100)
  await expect(page.locator('#new-container')).not.toHaveAttribute('data-peek-expanded')
  await page.locator('#new-text').hover()
  await expect.poll(() => openInRow(page.locator('#new-text'))).toBe(true)
  await page.mouse.move(1000, 100)
  await page.locator('#option-a').hover()
  await expect(page.locator('#option-a')).toHaveAttribute('data-peek-expanded', '')
  await expect(page.locator('#option-b')).not.toHaveAttribute('data-peek-open')
  await page.mouse.move(1000, 100)
  await page.locator('#line-text').hover()
  await expect.poll(() => openInRow(page.locator('#line-text'))).toBe(true)
  const icon = (await page.locator('#line-icon').boundingBox())!
  const text = (await page.locator('#line-text').boundingBox())!
  expect(text.y).toBeCloseTo(icon.y, 0)
  expect(text.x).toBeGreaterThan(icon.x + icon.width)
})


test('a long worker lead uses the whole metadata line, never a narrow column over the title', async ({ page, request }, info) => {
  const { presetPanelDesign, setStatusSectionOpen } = await import('./status-section-helpers')
  const { showAllSections } = await import('./todo-panel-helpers')
  const made: string[] = []
  const create = async (title: string, extra = {}) => {
    const res = await request.post('/api/tasks', { data: { title, project: 'Garden Insights', source: 'local', ...extra } })
    expect(res.status()).toBe(201)
    const id = (await res.json()).task.id as string
    made.push(id)
    if ('phase' in extra) expect((await request.patch(`/api/tasks/${id}`, { data: { phase: extra.phase } })).ok()).toBe(true)
    return id
  }
  try {
    const lead = await create('Garden Re-Architecture As Platform - Platform Lead with the complete plan and the inventory of every tool')
    const worker = await create('Garden org demo Friday: garden insight end to end, with the complete planting schedule and all the next steps', { parent_task_id: lead, phase: 'NEED_ACTION' })
    await create('Next garden task below the worker', { phase: 'NEED_ACTION' })
    await presetPanelDesign(page, 'status')
    await home(page)
    await showAllSections(page)
    await setStatusSectionOpen(page.locator('.todo-panel').first(), 'needs', true)
    const row = page.locator(`.status-section-card[data-task-id="${worker}"]`).first()
    await expect(row).toBeVisible()
    await row.scrollIntoViewIfNeeded()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      for (const width of [640, 300]) {
        await page.mouse.move(1, 1)
        // Change the real panel width, not the font or the chip, so this tests the cramped layout.
        await row.evaluate((el, w) => { const panel = el.closest<HTMLElement>('#home-task-navigation')!; panel.style.width = `${w}px`; panel.style.minWidth = `${w}px`; panel.style.maxWidth = `${w}px`; }, width)
        await row.scrollIntoViewIfNeeded()
        const before = (await row.boundingBox())!
        const chipBefore = (await row.locator('.task-worker-parent').boundingBox())!
        const metaBefore = (await row.locator('.status-card-meta').boundingBox())!
        const following = await row.evaluate((el) => el.nextElementSibling?.getBoundingClientRect().top ?? null)
        const timeBefore = await row.locator('.todo-recent-ago').boundingBox()
        await row.locator('.todo-pinned-title').hover({ position: { x: 12, y: 6 } })
        await expect.poll(() => openInRow(row.locator('.task-worker-parent'))).toBe(true)
        await expect.poll(() => openInRow(row.locator('.todo-pinned-title'))).toBe(true)
        const meta = (await row.locator('.status-card-meta').boundingBox())!
        const title = (await row.locator('.todo-pinned-title').boundingBox())!
        const chip = (await row.locator('.task-worker-parent').boundingBox())!
        const after = (await row.boundingBox())!
        expect(chip.width).toBeGreaterThan(chipBefore.width + 40)
        expect(meta.width).toBeCloseTo(metaBefore.width, 0)
        expect(meta.y + meta.height).toBeLessThanOrEqual(title.y + 1)
        const timeAfter = await row.locator('.todo-recent-ago').boundingBox()
        if (timeBefore && timeAfter) expect(timeAfter.x + timeAfter.width).toBeCloseTo(timeBefore.x + timeBefore.width, 0)
        const workerLabel = (await row.locator('.task-pill-long').boundingBox())!
        expect(chip.y).toBeCloseTo(workerLabel.y, 0)
        expect(title.y + title.height).toBeLessThanOrEqual(after.y + after.height + 1)
        expect(after.height).toBeGreaterThan(before.height + 15)
        expect(after.width).toBeCloseTo(before.width, 0)
        if (following !== null) expect(await row.evaluate((el) => el.nextElementSibling!.getBoundingClientRect().top)).toBeGreaterThan(following)
        await expect(peekPill(page)).toHaveCount(0)
        await page.screenshot({ path: info.outputPath(`worker-${theme}-${width}.png`) })
        await page.mouse.move(1, 1)
        await expect(row).not.toHaveAttribute('data-peek-expanded')
      }
    }
  } finally {
    for (const id of made.reverse()) await request.delete(`/api/tasks/${id}?force=true`)
  }
})
