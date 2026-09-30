/**
 * A task id a session writes in its reply renders as a clickable task pill.
 *
 * Reported 2026-09-29: a session cited other tasks by id only, one in backticks
 * and one bare inside CJK prose, and both showed as dead text. The pass that
 * fixes it (web/src/utils/bare-task-ids.ts) links an id only when the task store
 * knows it, shows the CURRENT title for a citation, keeps the id when its title
 * is already written beside it, and links an id inside a command in place.
 *
 * Seed: pw-idref-session (test-server.ts) replies with every one of those
 * shapes, naming mpwidref-7c2e (open, has a session) and mpwidrf2-9b10 (done).
 * Runs in Chromium; `PW_WEBKIT=1 … --project webkit` for the Mac app's engine.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-idref-session'
const TASK_ID = 'pw-task-idref'
const OPEN_ID = 'mpwidref-7c2e'
const DONE_ID = 'mpwidrf2-9b10'
const SHOTS = '/tmp/walnut-bare-task-id-pills'

test.setTimeout(120_000)

async function openSessionPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill('Task id refs fixture')
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible({ timeout: 20_000 })
  await task.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  return panel
}

test('task ids in a reply render as task pills and open the task', async ({ page }, info) => {
  let loads = 0
  page.on('load', () => { loads++ })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const loadsAfterOpen = loads

  const panel = await openSessionPanel(page)
  const reply = panel.locator('.markdown-body', { hasText: 'confirmed it: same class of problem' }).first()
  await expect(reply).toBeVisible({ timeout: 20_000 })

  // The backticked citation and the in-command id: one title pill, one link
  // inside the code that keeps the id text.
  const openPills = reply.locator(`a.task-link[data-task-id="${OPEN_ID}"]`)
  await expect(openPills).toHaveCount(2)
  const titlePill = reply.locator(`a.task-link:not(.task-link-code)[data-task-id="${OPEN_ID}"]`)
  await expect(titlePill).toHaveText('Quarterly invoice reconciliation')
  await expect(titlePill).toHaveAttribute('title', 'Walnut / Quarterly invoice reconciliation')
  const codeLink = reply.locator(`code a.task-link.task-link-code[data-task-id="${OPEN_ID}"]`)
  await expect(codeLink).toHaveText(OPEN_ID)
  await expect(codeLink.locator('..')).toHaveText(`walnut task show ${OPEN_ID}`)
  // The code keeps its monospace face: the link inherits it.
  const [codeFont, linkFont] = await codeLink.evaluate((a) => [
    getComputedStyle(a.parentElement!).fontFamily,
    getComputedStyle(a).fontFamily,
  ])
  expect(linkFont).toBe(codeFont)

  // The completed task: its title pill in the CJK sentence, and the id itself
  // where the reply already wrote the title beside it.
  const donePills = reply.locator(`a.task-link[data-task-id="${DONE_ID}"]`)
  await expect(donePills).toHaveCount(2)
  await expect(donePills.nth(0)).toHaveText('Rotate the staging API keys')
  await expect(donePills.nth(1)).toHaveText(DONE_ID)
  expect(await reply.textContent()).toContain(`From task ${DONE_ID} (Rotate the staging API keys)`)

  // id-shaped text that names no task stays text.
  await expect(reply.locator('a.task-link')).toHaveCount(4)
  await expect(reply).toContainText('550e8400-e29b-41d4-a716-446655440000')
  await expect(reply).toContainText('mzzzzzzz-0000')

  await reply.scrollIntoViewIfNeeded()
  await reply.screenshot({ path: `${SHOTS}/${info.project.name}-01-reply.png` })

  // Click the title pill: the cited task's session opens beside this one.
  await titlePill.click()
  const target = page.locator('.main-page-session-column .session-panel[data-session-id="pw-idref-target-session"]')
  await expect(target).toBeVisible({ timeout: 20_000 })
  await expect(target.getByText('IDREF_TARGET_MARKER')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  expect(loads - loadsAfterOpen, 'the page navigated away under the click').toBe(0)
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-02-target-opened.png` })

  // The in-code link and the done task's pill are in-app too: no page load.
  await codeLink.click()
  await donePills.nth(0).click()
  await page.waitForTimeout(500)
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
  expect(loads - loadsAfterOpen, 'the page navigated away under the click').toBe(0)
  await expect(target).toBeVisible()
})

test('an id in code in the user bubble stays readable', async ({ page }, info) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = await openSessionPanel(page)
  const bubble = panel.locator('.session-msg-user .markdown-body', { hasText: 'walnut task show' }).first()
  const link = bubble.locator(`code a.task-link.task-link-code[data-task-id="${OPEN_ID}"]`)
  await expect(link).toHaveText(OPEN_ID, { timeout: 20_000 })
  // Blue on the blue bubble was the 2026-08-15 invisible-pill trap.
  expect(await link.evaluate((a) => getComputedStyle(a).color)).toBe('rgb(255, 255, 255)')
  await bubble.screenshot({ path: `${SHOTS}/${info.project.name}-03-user-bubble.png` })
})

test('a task pill on a surface with no click handler navigates in-app', async ({ page }) => {
  let loads = 0
  page.on('load', () => { loads++ })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const before = loads
  // A surface that renders markdown but wires no entity click handler.
  await page.evaluate((id) => {
    const host = document.createElement('div')
    host.className = 'markdown-body'
    host.id = 'unwired-surface'
    host.innerHTML = `<a href="/tasks/${id}" class="task-link" data-task-id="${id}">pill</a>`
    document.body.appendChild(host)
  }, OPEN_ID)
  await page.locator('#unwired-surface a.task-link').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/tasks/${OPEN_ID}`)
  expect(loads - before, 'the pill click reloaded the page').toBe(0)
})
