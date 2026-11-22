import { expect, test } from '@playwright/test'
import { home } from './inbox-items-helpers'
import { expectStill, fits, topsOf } from './truncation-peek-helpers'

// No model turn or production write: all letters live in the fixture server.
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
test.setTimeout(120_000)

test('split inbox keeps both panels, density, selection and per-letter reply drafts', async ({ page, request }, info) => {
  const ids: string[] = []
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    for (let i = 0; i < 30; i++) {
      const r = await request.post('/api/v1/human-inbox', { data: { subject: `Split letter ${i}: ${'The complete garden plan with every tool and every next step. '.repeat(3)}`, type: 'info', user_asked: true, markdown: `Letter ${i} body\n\n${'Review the garden schedule and confirm the full list. '.repeat(40)}` } })
      expect(r.status()).toBe(201)
      ids.push((await r.json()).id)
    }
    await home(page)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await panel.getByRole('button', { name: 'Split', exact: true }).click()
    const pane = panel.locator('.hib-inbox-pane')
    await expect(pane).toHaveAttribute('data-layout', 'split')
    await expect(pane.getByTestId('inbox-reader-empty')).toContainText('No letter open')
    const row = (id: string) => pane.locator(`[data-letter-id="${id}"]`)
    const reader = pane.locator('.hib-inbox-reader')
    await row(ids[29]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-view')).toBeVisible()
    await expect(reader.locator('.hib-reader-body')).toContainText('Letter 29 body')
    await expect(row(ids[29])).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('.hib-reader-overlay')).toHaveCount(0)
    const listBox = (await pane.locator('.hib-inbox-index').boundingBox())!
    const readerBox = (await reader.boundingBox())!
    expect(listBox.x + listBox.width).toBeLessThanOrEqual(readerBox.x + 1)
    expect(readerBox.width).toBeGreaterThan(300)
    const reply = reader.locator('.hib-composer textarea').first()
    await expect(reply).toBeVisible()
    await reply.fill('Keep this draft for letter 29')
    await page.mouse.move(1200, 780)
    const roomy = (await row(ids[29]).boundingBox())!.height
    await pane.getByRole('button', { name: 'Compact', exact: true }).click()
    await page.mouse.move(1200, 780)
    expect((await row(ids[29]).boundingBox())!.height).toBeLessThan(roomy)
    await expect(reply).toHaveValue('Keep this draft for letter 29')
    await row(ids[28]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-reader-body')).toContainText('Letter 28 body')
    await expect(reader.locator('.hib-composer textarea').first()).toHaveValue('')
    await row(ids[29]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-composer textarea').first()).toHaveValue('Keep this draft for letter 29')
    // Both density modes show the subject whole: it wraps (2026-11-21, standard.md "Text that does not
    // fit"), so the row has nothing cut, the hover opens nothing and the next letter stays put.
    for (const mode of ['Roomy', 'Compact']) {
      await pane.getByRole('button', { name: mode, exact: true }).click()
      await page.mouse.move(1200, 780)
      const before = (await row(ids[29]).boundingBox())!
      const tops = await topsOf([row(ids[28])])
      expect(await fits(row(ids[29]).locator('.hib-subject')), `split ${mode}: the subject is whole`).toBe(true)
      await row(ids[29]).hover({ position: { x: before.width - 6, y: 6 } })
      await page.waitForTimeout(400)
      const hovered = (await row(ids[29]).boundingBox())!
      expect(Math.abs(hovered.width - before.width), `split ${mode}: nothing to widen`).toBeLessThanOrEqual(1)
      await expectStill([row(ids[28])], tops, `split ${mode}: the next letter`)
      await page.screenshot({ path: info.outputPath(`split-${mode.toLowerCase()}.png`) })
      await page.mouse.move(1200, 780)
    }
    await row(ids[28]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-reader-body')).toContainText('Letter 28 body')
    await expect(row(ids[28])).toHaveAttribute('data-selected', 'true')
    await expect(row(ids[28])).toBeVisible()
    await row(ids[29]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-composer textarea').first()).toHaveValue('Keep this draft for letter 29')
    await pane.getByRole('button', { name: 'Compact', exact: true }).click()
    // First Escape closes the letter, second the center. Reopening restores view choices.
    await page.keyboard.press('Escape')
    await expect(reader.locator('.hib-view')).toHaveCount(0)
    await expect(panel).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    await page.locator('.notification-panel .nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await expect(pane).toHaveAttribute('data-layout', 'split')
    await expect(pane).toHaveAttribute('data-density', 'compact')
    await row(ids[29]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-composer textarea').first()).toHaveValue('Keep this draft for letter 29')
    // Changing layout or leaving Inbox is not a request to turn the reader into a modal.
    await pane.getByRole('button', { name: 'Cards', exact: true }).click()
    await expect(page.locator('.hib-reader-overlay')).toHaveCount(0)
    await row(ids[29]).locator('.hib-subject').click()
    await expect(page.locator('.hib-reader-overlay .hib-composer textarea').first()).toHaveValue('Keep this draft for letter 29')
    await page.getByRole('button', { name: 'Close letter', exact: true }).click()
    await pane.getByRole('button', { name: 'Split', exact: true }).click()
    await row(ids[29]).locator('.hib-subject').click()
    await panel.locator('.nfc-rail-btn').filter({ hasText: /^All$/ }).click()
    await expect(page.locator('.hib-reader-overlay')).toHaveCount(0)
    await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await expect(reader.locator('.hib-view')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await row(ids[29]).locator('.hib-subject').click()
    await expect(reader.locator('.hib-view')).toBeVisible()
    const narrowList = (await pane.locator('.hib-inbox-index').boundingBox())!
    const narrowReader = (await reader.boundingBox())!
    expect(narrowReader.y).toBeGreaterThanOrEqual(narrowList.y + narrowList.height - 1)
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath('split-phone.png') })
    expect(errors).toEqual([])
  } finally {
    for (const id of ids) await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  }
})

test('split reader stays usable through empty unread filters and a failed letter load', async ({ page, request }) => {
  const r = await request.post('/api/v1/human-inbox', { data: { subject: `Split recovery ${Date.now()}`, type: 'info', user_asked: true, markdown: 'Recovery body' } })
  expect(r.status()).toBe(201)
  const id = (await r.json()).id as string
  try {
    await home(page)
    await page.getByRole('button', { name: /^Notifications/ }).click()
    const panel = page.locator('.notification-panel')
    await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
    await panel.getByRole('button', { name: 'Split', exact: true }).click()
    let fail = true
    await page.route(`**/api/v1/human-inbox/${id}`, async route => {
      if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Temporarily unavailable"}' })
      else await route.continue()
    })
    await panel.locator(`[data-letter-id="${id}"] .hib-subject`).click()
    await expect(panel.locator('.hib-inbox-reader .hib-note-error')).toBeVisible()
    fail = false
    await panel.getByRole('button', { name: 'Close letter', exact: true }).click()
    await panel.locator(`[data-letter-id="${id}"] .hib-subject`).click()
    await expect(panel.locator('.hib-inbox-reader .hib-reader-body')).toContainText('Recovery body')
    await panel.getByRole('button', { name: 'Unread', exact: true }).click()
    // Reading or filtering must not take the user's selected letter away.
    await expect(panel.locator('.hib-inbox-reader .hib-reader-body')).toContainText('Recovery body')
    await panel.getByRole('button', { name: 'Archived', exact: true }).click()
    await expect(panel.locator('.hib-inbox-reader .hib-reader-body')).toContainText('Recovery body')
  } finally {
    await request.post(`/api/v1/human-inbox/${id}/archive`, { data: { archived: true } })
  }
})
