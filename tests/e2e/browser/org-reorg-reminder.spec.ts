/**
 * The Org page's reorg reminder (web/src/components/org/OrgReorgReminder.tsx; 2026-11-12, the
 * user: "if the VP more than 6 remind them to do reorg, if they select close we keep remind each
 * one more vp created, like remind in 6, 7, 8 but if they close, we at least don't remind in
 * current load, they can also choose never remind"):
 *   - from 6 VPs one line suggests merging some, with Org chart, Close and Never remind me
 *   - Close hides it for this load: leaving the page and coming back keeps it hidden
 *   - one more VP brings it back in the same load
 *   - a reload is a new load: it shows again
 *   - Never remind me hides it for good, a reload included
 * The fixture is shared, so this file makes its own VPs (enough to reach 6) and removes them.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const made: string[] = []

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

async function makeVp(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/v1/org/vps', { data: { name } })
  expect(res.ok(), await res.text()).toBe(true)
  made.push(((await res.json()) as { task: { id: string } }).task.id)
}

async function vpCount(page: Page): Promise<number> {
  const head = page.getByTestId('org-vps-head')
  await expect(head).toBeVisible()
  return Number(/VPs · (\d+)/.exec((await head.textContent()) ?? '')?.[1] ?? NaN)
}

async function openOrg(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
}

test.afterAll(async ({ request }) => {
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  for (let i = 0; i < made.length + 2; i++) {
    await request.delete(`/api/v1/projects/${encodeURIComponent(`Reorg ${i} ${STAMP}`)}`).catch(() => undefined)
  }
})

test('the reorg reminder: shows from 6 VPs, Close holds for the load, a new VP brings it back, Never ends it', async ({ page, request }) => {
  await isolateUiPrefs(page)
  await loadHome(page)
  await page.evaluate(() => localStorage.removeItem('open-walnut-org-reorg-reminder'))
  await openOrg(page)

  // Reach 6 VPs, whatever the shared fixture holds.
  let n = await vpCount(page)
  let next = 0
  while (n < 6) {
    await makeVp(request, `Reorg ${next++} ${STAMP}`)
    n++
  }
  await expect.poll(() => vpCount(page), { timeout: 30_000 }).toBe(n)
  const note = page.getByTestId('org-reorg-reminder')
  await expect(note).toBeVisible()
  await expect(note).toContainText(`You have ${n} VPs.`)
  await expect(note.getByTestId('org-reorg-chart')).toBeVisible()

  // Close: gone, and still gone after leaving the page and coming back in this load.
  await note.getByTestId('org-reorg-close').click()
  await expect(note).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-home').click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await openOrg(page)
  await expect(page.getByTestId('org-vps-head')).toBeVisible()
  await expect(page.getByTestId('org-reorg-reminder')).toHaveCount(0)

  // One more VP: back, in the same load.
  await makeVp(request, `Reorg ${next++} ${STAMP}`)
  n++
  await expect.poll(() => vpCount(page), { timeout: 30_000 }).toBe(n)
  await expect(page.getByTestId('org-reorg-reminder')).toBeVisible()
  await expect(page.getByTestId('org-reorg-reminder')).toContainText(`You have ${n} VPs.`)

  // A reload is a new load: a close from before does not hold.
  await page.getByTestId('org-reorg-close').click()
  await expect(page.getByTestId('org-reorg-reminder')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('org-reorg-reminder')).toBeVisible({ timeout: 30_000 })

  // Never remind me: gone for good, a reload and another VP included.
  await page.getByTestId('org-reorg-never').click()
  await expect(page.getByTestId('org-reorg-reminder')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('open-walnut-org-reorg-reminder'))).toBe('never')
  await makeVp(request, `Reorg ${next++} ${STAMP}`)
  n++
  await expect.poll(() => vpCount(page), { timeout: 30_000 }).toBe(n)
  await expect(page.getByTestId('org-reorg-reminder')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('org-vps-head')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('org-reorg-reminder')).toHaveCount(0)
})
