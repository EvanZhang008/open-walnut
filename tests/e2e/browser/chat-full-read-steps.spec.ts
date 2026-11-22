/**
 * A long chat's full read draws its rows a step a frame (render-window.ts `growth`).
 *
 * 2026-11-16, task 9bceb9f2: the Mac app held its main thread 1.8 s on the Org page right after
 * the chat opened beside it got its full read (Evan's 16599b79: the server's first screen of 40
 * rows, then the 400-row tail). Ten turns of an agent's session are most of that tail (102 user
 * rows, under ten of them typed), and the turn window has no row bound, so that one render drew
 * some 360 rows: on a 4x slower Chromium a 2.2 s task, the chat's DOM from 1,200 nodes to 6,700.
 *
 * Here the same shape (400 rows, a 40-row first screen, a few typed turns among deliveries) lands
 * beside the Org page, and:
 *  - no task after it is longer than a long task budget (the old code: one task of all the rows);
 *  - every row of the turn window is drawn in the end, and the chat is never empty meanwhile;
 *  - a reader at the end stays at the end, and a reader up in the first screen keeps their place.
 * On the production bundle (production-bundle.ts says why).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { serveProductionBundle } from './production-bundle'
import { isolateUiPrefs } from './todo-panel-helpers'
import { loadHome } from './draft-helpers'
import { openBeside } from './org-view-helpers'
import { chromiumCpuClock, longTaskBudget, machineQuiet, referenceDrawMs, traceTaskTimes } from './cpu-reference'

test.use({ viewport: { width: 1440, height: 900 } })

const SID = 'pw-history-turns-session'
const TASK = 'pw-task-history-turns'
const ROWS = 400
const FIRST_SCREEN = 40

const md = (n: number, words: string) => `## Step ${n}\n\n${words.repeat(3)}\n\n- first point about ${n}\n- second point with \`code ${n}\`\n\n\`\`\`ts\nconst x${n} = compute(${n});\nreturn x${n} + 1;\n\`\`\`\n\n${words.repeat(2)}`

/** An agent's session: each turn a delivery or a typed message (`typed`), two tool calls, an answer. */
function transcript(typed: (turn: number) => boolean): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const t0 = Date.parse('2026-11-16T08:00:00Z')
  let i = 0
  const at = () => new Date(t0 + (i++) * 7000).toISOString()
  for (let turn = 0; out.length < ROWS; turn++) {
    out.push({ role: 'user', text: md(turn, 'A long question about the build and the logs it printed today. '), timestamp: at(), msgId: `fr-u-${turn}`, ...(typed(turn) ? {} : { injected: true }) })
    for (let k = 0; k < 2; k++) out.push({ role: 'assistant', text: '', thinking: 'Which command to run next, and why. '.repeat(6), timestamp: at(), msgId: `fr-a-${turn}-${k}`,
      tools: [{ name: 'Bash', input: { command: `grep -rn "thing ${turn}" src | head -${k + 5}`, description: 'Search the source' }, toolUseId: `fr-tu-${turn}-${k}`, result: 'src/file.ts:12: a matching line of output\n'.repeat(10) }] })
    out.push({ role: 'assistant', text: md(turn, 'The answer says what the logs show and what to change next. '), timestamp: at(), msgId: `fr-a-${turn}-t` })
  }
  return out.slice(-ROWS)
}

/** Serves the session's first screen at once and holds its full read until `release()`. */
/** One typed message in forty: the turn window is the whole tail, the first screen a part of one turn. */
const SPARSE = (turn: number) => turn % 40 === 0
/** Typed messages through the first screen's turns, so it reads as answers a reader scrolls; the
 *  window (ten turns) reaches back to turn 40. */
const DENSE_TAIL = (turn: number) => turn >= 92 || turn % 40 === 0

async function serveHistory(page: Page, typed = SPARSE): Promise<{ release: () => void }> {
  const rows = transcript(typed)
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await page.route(`**/api/sessions/${SID}/history**`, async (route) => {
    const streams = new URL(route.request().url()).searchParams.get('source') === 'streams'
    if (!streams) await held
    const messages = streams ? rows.slice(-FIRST_SCREEN) : rows
    await route.fulfill({ json: { messages, total: 762, windowed: true, ...(streams ? { firstPaintSource: 'snapshot' } : { cursor: 123456 }) } })
  })
  return { release }
}

async function openChatBesideOrg(page: Page): Promise<Locator> {
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible({ timeout: 30_000 })
  await openBeside(page, `task:${TASK}`)
  const box = page.getByTestId('org-side').locator('.session-history').first()
  await expect(box.getByRole('heading', { name: `Step ${ROWS / 4 - 1}` }).first()).toBeVisible({ timeout: 30_000 })
  return box
}

/** Watches the box from now on for an empty chat, which no step may show. */
async function watchBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] }
    w.__seen = []
    const box = document.querySelector('[data-testid="org-side"] .session-history')!
    new MutationObserver(() => {
      if (/No messages yet/.test(box.textContent ?? '')) w.__seen.push('empty')
    }).observe(box, { childList: true, subtree: true })
  })
}

/** Until every row of the turn window is drawn: its first turn's words are in the box. */
async function untilAllDrawn(box: Locator, first: string): Promise<void> {
  await expect(box.getByRole('heading', { name: first, exact: true }).first()).toBeAttached({ timeout: 20_000 })
}

/** Where a row sits from the top of its box, in px. */
const place = (row: Locator) => row.evaluate((el) => Math.round(el.getBoundingClientRect().top - (el.closest('.session-history') as HTMLElement).getBoundingClientRect().top))

test.describe('A long chat\'s full read draws a step a frame', () => {
  test.setTimeout(180_000)

  test('no long task when it lands, every row drawn in the end, the reader at the end stays there', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'long tasks and their CPU are read from Chrome\'s trace')
    await serveProductionBundle(page)
    await isolateUiPrefs(page)
    const { release } = await serveHistory(page)
    const box = await openChatBesideOrg(page)
    await page.waitForTimeout(1500)
    await watchBox(page)
    const stop = await traceTaskTimes(page)
    release()
    await untilAllDrawn(box, 'Step 0')
    await page.waitForTimeout(500)
    const tasks = await stop()
    const reference = await referenceDrawMs(page, await chromiumCpuClock(page))
    const budget = longTaskBudget(150, reference)
    const worstCpu = Math.max(0, ...tasks.map((t) => t.cpu))
    const worstWall = Math.max(0, ...tasks.map((t) => t.wall))
    const why = `tasks after the full read: ${JSON.stringify(tasks)} (budget ${budget} ms, reference ${reference} ms)`
    console.log(why)
    expect(worstCpu, why).toBeLessThanOrEqual(budget)
    if (machineQuiet()) expect(worstWall, why).toBeLessThanOrEqual(budget)
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([])
    const gap = await box.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
    expect(gap, 'the reader at the end is still at the end').toBeLessThanOrEqual(80)
  })

  test('a reader up in the first screen keeps their place while the rows above open', async ({ page }) => {
    await serveProductionBundle(page)
    await isolateUiPrefs(page)
    const { release } = await serveHistory(page, DENSE_TAIL)
    const box = await openChatBesideOrg(page)
    await page.waitForTimeout(1500)
    // Up in the first screen by the wheel (the open's bottom pin lets go of a person's input
    // only): an answer some turns back, at least 60 px below the box's top.
    const row = box.getByRole('heading', { name: 'Step 95', exact: true }).first()
    const hb = (await box.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    for (let i = 0; i < 60 && (await place(row)) < 60; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40) }
    await page.waitForTimeout(800)
    const before = await place(row)
    expect(before, 'the first screen scrolls').toBeGreaterThan(60)
    await watchBox(page)
    release()
    await untilAllDrawn(box, 'Step 40')
    await page.waitForTimeout(800)
    expect(Math.abs((await place(row)) - before), `the row read ${before} px from the top before`).toBeLessThanOrEqual(4)
    expect(await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)).toEqual([])
  })

  test('the reader scrolling while the rows open stays where they scrolled to', async ({ page }) => {
    await serveProductionBundle(page)
    await isolateUiPrefs(page)
    const { release } = await serveHistory(page, DENSE_TAIL)
    const box = await openChatBesideOrg(page)
    await page.waitForTimeout(1500)
    const row = box.getByRole('heading', { name: 'Step 97', exact: true }).first()
    const hb = (await box.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    release()
    // Rows are opening above now: the reader wheels up a little, in a few ticks.
    await expect.poll(() => box.evaluate((el) => el.scrollHeight), { timeout: 10_000 }).toBeGreaterThan(await box.evaluate((el) => el.scrollHeight))
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(60) }
    await page.waitForTimeout(150)
    const scrolledTo = await place(row)
    await untilAllDrawn(box, 'Step 40')
    await page.waitForTimeout(800)
    expect(Math.abs((await place(row)) - scrolledTo), `the row sat ${scrolledTo} px from the top after the wheel`).toBeLessThanOrEqual(4)
  })
})
