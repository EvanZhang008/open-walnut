/**
 * The grouped inbox while mail arrives (design v2): new unread mail waits in Important while the
 * model sorts it, then moves into its group; the group order holds while the pointer is over the
 * list and follows the server once it leaves; Important gains only the mail that is Important; loaded
 * older pages and the scroll stay.
 */
import os from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import {
  ALL_INBOXES, FERRY, MARINA, deliver, getGroups, groupLine, groupOfMessage, openGroupLine, openGrouped,
  startGroupsFixture, waitLabeled,
} from './mail-grouping-helpers'
import { openMail, smartRow, type MailFixture, type MailFixtureServer } from './mail-review-helpers'
import { cpuBudget, FAST_CORE_REFERENCE_MS, machineQuiet, referenceDrawMs } from './cpu-reference'
import { serveProductionBundle } from './production-bundle'

test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

async function lineIds(page: Page): Promise<string[]> {
  return page.getByTestId('mail-group-row').evaluateAll((rows) => rows.map((one) => one.getAttribute('data-group-id')!))
}

/** The pointer rests on the list (below the last group line), as a person reading it would. */
async function pointerOnList(page: Page): Promise<void> {
  // With a summary line under every group, Important sits below the fold at 720px: bring it in first,
  // or the pointer lands outside the page and nothing is held.
  const head = page.getByTestId('mail-important-head')
  await head.scrollIntoViewIfNeeded()
  const box = (await head.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * The grouped draw's main-thread CPU, in reference draws (cpu-reference.ts cpuBudget). Measured
 * 2026-11-02 on the production bundle over 17 runs: in an 8 CPU container (reference 125 to 142 ms)
 * 267 to 362 ms, 2.0 to 2.9 references; with 4 CPUs and 4 workers (reference 132 to 160) 182 to 426,
 * 1.4 to 2.7; median 2.4. React's development build read 673 to 756 beside 161 to 176 (3.8 to 4.7;
 * 2026-11-01: 3 to 6.4 at load 10 to 30), and the old budget, 1.5 s grown past a 180 ms reference
 * (8.3 references), carried that. 3.6 references is 1.25 times the worst read: a draw grown by half
 * fails from its median up. As written: the same at the fastest reference read (125 ms).
 */
const DRAW_CPU_REFS = 3.6
const DRAW_CPU_MS = 450

test.describe('the ordinary fixture', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(240_000)
    ;({ server, fixture } = await startGroupsFixture())
    await waitLabeled(fixture, ALL_INBOXES, 120_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('new mail changes numbers under the pointer and moves no line; the group moves up once the pointer leaves', async ({ page }) => {
    await openGrouped(page, fixture)
    await pointerOnList(page)
    const order = await lineIds(page)
    const pay = (await getGroups(fixture, ALL_INBOXES)).groups.find((one: { label: string }) => one.label === 'Pay & statements')
    expect(order.indexOf(pay.id)).toBeGreaterThan(0)
    const headY = (await page.getByTestId('mail-important-head').boundingBox())!.y
    // ferry's delivered mail is a payroll notice: the model files it under Pay & statements.
    const made = (await deliver(fixture, 1, { account: 'ferry' })).delivered[0]!
    await waitLabeled(fixture, ALL_INBOXES)
    await expect.poll(() => groupOfMessage(fixture, FERRY, made.messageId), { timeout: 30_000 }).toBe(pay.id)
    // The server now puts it first; the screen follows the number on its own, not the order.
    expect((await getGroups(fixture, ALL_INBOXES)).groups[0].id).toBe(pay.id)
    await expect(groupLine(page, pay.id)).toHaveAttribute('data-unread', String(pay.unread + 1), { timeout: 30_000 })
    expect(await lineIds(page)).toEqual(order)
    expect((await page.getByTestId('mail-important-head').boundingBox())!.y).toBe(headY)
    // The pointer leaves the list: the order is the server's again.
    await page.mouse.move(2, 2)
    await expect.poll(() => lineIds(page), { timeout: 20_000 }).toEqual((await getGroups(fixture, ALL_INBOXES)).groups.map((one: { id: string }) => one.id))
    expect((await lineIds(page))[0]).toBe(pay.id)
  })

  test('an open group keeps the rows it shows while more mail lands in it', async ({ page }) => {
    await openGrouped(page, fixture, MARINA)
    const builds = (await getGroups(fixture, { accountId: MARINA, mailboxId: 'INBOX' })).groups.find((one: { label: string }) => one.label === 'Build results')
    const group = await openGroupLine(page, builds.id)
    const shown = await group.locator('[data-testid="mail-row"]').evaluateAll((rows) => rows.map((one) => one.getAttribute('data-message-id')))
    // After the pointer is in place: bringing Important into view scrolls the list.
    await pointerOnList(page)
    const firstY = (await group.locator('[data-testid="mail-row"]').first().boundingBox())!.y
    await deliver(fixture, 2, { account: 'marina' })
    await waitLabeled(fixture, ALL_INBOXES)
    await expect(groupLine(page, builds.id)).toHaveAttribute('data-unread', String(builds.unread + 2), { timeout: 30_000 })
    const after = await group.locator('[data-testid="mail-row"]').evaluateAll((rows) => rows.map((one) => one.getAttribute('data-message-id')))
    for (const id of shown) expect(after).toContain(id)
    expect((await group.locator(`[data-testid="mail-row"][data-message-id="${shown[0]}"]`).boundingBox())!.y).toBe(firstY)
  })
})

test.describe('the dense fixture', () => {
  let server: MailFixtureServer
  let fixture: MailFixture
  test.beforeAll(async () => {
    test.setTimeout(300_000)
    ;({ server, fixture } = await startGroupsFixture({ dense: true }))
    await waitLabeled(fixture, ALL_INBOXES, 180_000)
  })
  test.afterAll(async () => { await server?.stop() })

  test('3,000 mails: the group lines and the first Important page draw inside a second and a half', async ({ page, browserName }) => {
    // Two clocks. The page's main-thread CPU (thread ticks) is the work the draw costs and no
    // other process can inflate it; the wall clock is what a person waits, and on a saturated
    // machine it is mostly the CPU queue (measured: 0.2 to 0.8s of CPU took 2.5 to 4.8s of wall at
    // load 240 to 340), so it is judged only below one runnable process per core.
    // The CPU clock is a Chromium protocol call; another engine is judged by the wall clock alone.
    // Judged on the bundle users run (production-bundle.ts), not React's development build.
    await serveProductionBundle(page)
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
    await cdp?.send('Performance.enable', { timeDomain: 'threadTicks' })
    const taskSeconds = async () => cdp ? (await cdp.send('Performance.getMetrics')).metrics.find((one) => one.name === 'TaskDuration')?.value ?? 0 : 0
    await openMail(page, fixture.port)
    // A slower or busier machine (a CI runner's: 1,502 and 1,909 ms of CPU on 2026-11-01, on the
    // development build, for a draw that took 700 to 870 here) gets the CPU budget in proportion to
    // a fixed reference draw read with the same clock. The wall clock is the title's second and a
    // half (it holds the server's answer too), grown the same way past a fast desktop core's reference.
    const reference = cdp ? await referenceDrawMs(page, async () => (await taskSeconds()) * 1000) : 0
    const cpuLimit = cpuBudget(DRAW_CPU_MS, DRAW_CPU_REFS, reference)
    const budget = Math.round(1_500 * Math.max(1, reference / FAST_CORE_REFERENCE_MS))
    const cpuBefore = await taskSeconds()
    const started = Date.now()
    await smartRow(page, 'inbox').click()
    await expect(page.getByTestId('mail-group-row').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.mail-important [data-testid="mail-row"]').first()).toBeVisible({ timeout: 60_000 })
    const took = Date.now() - started
    const cpu = Math.round((await taskSeconds() - cpuBefore) * 1000)
    const load = os.loadavg()[0]
    const saturated = !machineQuiet()
    const measured = `wall ${took}, main-thread cpu ${cdp ? cpu : 'n/a'}, reference draw ${cdp ? reference : 'n/a'}, cpu budget ${cpuLimit}, wall budget ${budget}, load ${load.toFixed(0)}${saturated ? ' (wall not judged)' : ''}`
    test.info().annotations.push({ type: 'groups-first-paint-ms', description: measured })
    console.log(`[mail-grouping-live] 3,000 mails ${measured}`)
    if (cdp) expect(cpu, measured).toBeLessThan(cpuLimit)
    if (!saturated) expect(took, measured).toBeLessThan(budget)
    const groups = await getGroups(fixture, ALL_INBOXES)
    expect(groups.cachedTotal).toBeGreaterThanOrEqual(3_000)
    expect(await page.getByTestId('mail-group-row').count()).toBe(groups.groups.length)
    expect(await page.locator('.mail-important [data-testid="mail-row"]').count()).toBeLessThanOrEqual(50)
  })

  test('40 mails arrive, 3 of them from people: Important gains exactly those 3, older pages and scroll stay', async ({ page }) => {
    await openGrouped(page, fixture)
    await page.getByTestId('mail-load-older').click()
    await expect(page.locator('.mail-important [data-testid="mail-row"]')).toHaveCount(100, { timeout: 30_000 })
    const scroller = page.locator('.mail-rows.mail-grouped')
    await scroller.evaluate((el) => { el.scrollTop = 900 })
    const idsBefore = await page.locator('.mail-important [data-testid="mail-row"]').evaluateAll((els) => els.map((one) => one.getAttribute('data-message-id')))
    const groupsBefore = await getGroups(fixture, ALL_INBOXES)
    const made = await deliver(fixture, 40, { people: 3, account: 'marina' })
    const people = made.delivered.slice(0, 3).map((one) => one.messageId)
    await expect.poll(async () => (await getGroups(fixture, ALL_INBOXES)).cachedTotal, { timeout: 30_000 }).toBe(groupsBefore.cachedTotal + 40)
    await waitLabeled(fixture, ALL_INBOXES, 60_000)
    await expect.poll(async () => page.locator('.mail-important [data-testid="mail-row"]').count(), { timeout: 30_000 }).toBe(103)
    const idsAfter = await page.locator('.mail-important [data-testid="mail-row"]').evaluateAll((els) => els.map((one) => one.getAttribute('data-message-id')))
    expect(idsAfter.slice(0, 3).sort()).toEqual([...people].sort())
    expect(idsAfter.slice(3)).toEqual(idsBefore)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(800)
    // The other 37 only moved group numbers.
    const groupsAfter = await getGroups(fixture, ALL_INBOXES)
    const unreadIn = (g: { groups: Array<{ unread: number }> }) => g.groups.reduce((acc, one) => acc + one.unread, 0)
    expect(unreadIn(groupsAfter) - unreadIn(groupsBefore)).toBe(37)
  })
})
