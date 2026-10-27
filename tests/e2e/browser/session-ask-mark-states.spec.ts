/**
 * The mark on an asked passage says where its question stands (2026-10-26, the
 * user: "when ask question it should be more obvious that it is queuing; when
 * the first text come, it should change color to green from yellow and still
 * changing color meaning still outputting, when done, if not read, become red
 * color meaning need to click and check, once check become green again, if a
 * new question is asked, become yellow again").
 *
 * One walk in Conversation Mode: Ask on a passage, send; the mark is amber and
 * pulses (its own bars in the live layer) while no answer text has come, with a
 * tooltip that says so; the first words turn it green with the scanning line;
 * the answer lands with the card closed, so it is red; opening the card makes
 * it green and still; a second question on the same passage starts over at
 * amber; a reload while that answer is coming brings back a live state, and the
 * finished answer nobody opened is red after the reload too; opened, it is
 * green, and stays green across another reload (the viewed time is kept).
 *
 * Chromium and WebKit. The reload fixture session (its sends reach the
 * transcript). The mock CLI's `slow:<ms>` holds the result back and
 * `MOCK_SPEAK_AT:<ms>` sends the first words at that time.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, openThreadsSession, passageRects, readRecord, resetThreadsFixture, selectPassage, sessionPanel } from './threads-helpers'
import { RELOAD_PASSAGE, RELOAD_SESSION } from './threads-fixture'

const RELOAD_TASK = 'pw-task-threads-reload'
const READY = 'What does the reader do after a rotation?'
const PHRASE = RELOAD_PASSAGE.slice(0, 40)
const STATE_NAMES = [
  'thread-mark-waiting-neutral', 'thread-mark-live-neutral', 'thread-mark-unread-neutral',
  'thread-mark-failed-neutral', 'thread-mark-neutral', 'thread-mark-done-neutral',
] as const
type StateName = typeof STATE_NAMES[number]

async function shot(page: Page, name: string, panel: Locator): Promise<void> {
  const dir = `/tmp/ask-mark-states/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  const r = (await passageRects(panel, PHRASE))[0]
  const clip = r ? { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 50), width: 700, height: 150 } : undefined
  await page.screenshot({ path: `${dir}/${name}.png`, ...(clip ? { clip } : {}) })
}

/** The highlight names whose ranges hold the passage (one when nothing overlaps). */
const statesOfPassage = (page: Page) => page.evaluate(([phrase, names]) => {
  const out: string[] = []
  for (const n of names) {
    const h = CSS.highlights?.get(n) as unknown as Iterable<Range> | undefined
    if (h && Array.from(h).some((r) => r.toString().includes(phrase))) out.push(n)
  }
  return out
}, [PHRASE, STATE_NAMES as unknown as string[]] as const)

const expectState = (page: Page, name: StateName, timeout = 30_000) =>
  expect.poll(() => statesOfPassage(page), { timeout, message: `the passage paints ${name}` }).toEqual([name])

const priorityOf = (page: Page, name: string) => page.evaluate((n) => (CSS.highlights?.get(n) as { priority?: number } | undefined)?.priority ?? null, name)

/** A bar in the live layer that breathes: its opacity changes over time. */
async function expectPulsing(line: Locator): Promise<void> {
  expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe('thread-wait-pulse')
  const first = await line.evaluate((el) => getComputedStyle(el).opacity)
  await expect.poll(() => line.evaluate((el) => getComputedStyle(el).opacity), { timeout: 4_000 }).not.toBe(first)
}

async function hoverPassage(page: Page, panel: Locator): Promise<void> {
  const r = (await passageRects(panel, PHRASE))[0]
  await page.mouse.move(r.left + 12, r.top + r.height / 2)
}

async function clickPassage(page: Page, panel: Locator): Promise<void> {
  const r = (await passageRects(panel, PHRASE))[0]
  await page.mouse.click(r.left + 12, r.top + r.height / 2)
}

test.describe('the mark of an asked passage follows its question', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, RELOAD_SESSION)
  })

  test('waiting, answering, unread, read; again on a second question; across reloads', async ({ page, request }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1280, height: 820 })
    // No viewed times left from an earlier run of this fixture session.
    await page.evaluate((sid) => localStorage.removeItem(`walnut:thread-viewed.v1:${sid}`), RELOAD_SESSION)
    let panel = await openThreadsSession(page, RELOAD_SESSION, RELOAD_TASK, READY, { view: 'linear' })
    const history = () => panel.locator('.session-history')
    const waitLines = () => history().locator('.thread-live-layer .thread-wait-line')
    const scanLines = () => history().locator('.thread-live-layer .thread-live-line')
    const card = () => panel.locator('.thread-card')

    // ── Ask, send: waiting (amber, pulsing) while no words have come.
    await centreInHistory(page, panel, PHRASE)
    await selectPassage(page, panel, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card()).toHaveAttribute('data-draft', 'true')
    await card().locator('.thread-card-input').fill('slow:14000 MOCK_SPEAK_AT:6000 What drains first?')
    await card().locator('.thread-card-input').press('Enter')
    await expectState(page, 'thread-mark-waiting-neutral')
    // The card says it waits, not that it answers.
    await expect(card()).toHaveAttribute('data-waiting', 'true')
    await expect(card().locator('.thread-card-status')).toHaveText('Waiting')
    await expect(card().locator('.thread-card-waiting')).toHaveText(/^(Waiting for the first words…|Queued: waits for the answer running now)$/)
    await expect(waitLines().first()).toBeVisible({ timeout: 10_000 })
    await expect(scanLines()).toHaveCount(0)
    await expectPulsing(waitLines().first())
    expect(await priorityOf(page, 'thread-mark-waiting-neutral'), 'waiting paints above every other state').toBe(7)
    await shot(page, '1-waiting', panel)
    // Reduced motion: the bar holds still, the color stays.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await waitLines().first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    // The card closes; the answer will land with nobody looking at it.
    await card().locator('.thread-card-input').press('Escape')
    await expect(card()).toHaveCount(0)
    await hoverPassage(page, panel)
    await expect(page.locator('.thread-hover-tip')).toHaveText(/^Waiting for an answer · Open “/)
    await page.mouse.move(5, 5)

    // ── The first words: answering (green, scanning).
    await expectState(page, 'thread-mark-live-neutral', 30_000)
    await expect(scanLines().first()).toBeVisible()
    await expect(waitLines()).toHaveCount(0)
    expect(await scanLines().first().evaluate((el) => getComputedStyle(el).animationName)).toBe('thread-live-scan')
    const band = await scanLines().first().evaluate((el) => getComputedStyle(el).getPropertyValue('--live-band').trim())
    expect(band, 'the neutral scan is green').toMatch(/^hsl\(14[05]/)
    await shot(page, '2-answering', panel)

    // ── Done, card closed: unread (red), and the tooltip says it.
    await expectState(page, 'thread-mark-unread-neutral', 60_000)
    await expect(scanLines()).toHaveCount(0)
    await expect(waitLines()).toHaveCount(0)
    await hoverPassage(page, panel)
    await expect(page.locator('.thread-hover-tip')).toHaveText(/^New answer · Open “/)
    await shot(page, '3-unread', panel)

    // ── Opened: read (green, still); closing it keeps it read.
    await clickPassage(page, panel)
    await expect(card().locator('.thread-card-body')).toContainText('processed your message: What drains first?', { timeout: 30_000 })
    await expectState(page, 'thread-mark-neutral')
    await card().locator('.thread-card-input').press('Escape')
    await expect(card()).toHaveCount(0)
    await expectState(page, 'thread-mark-neutral')
    await shot(page, '4-read', panel)

    // ── A second question on the same passage: waiting again.
    await centreInHistory(page, panel, PHRASE)
    await selectPassage(page, panel, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    await expect(card()).toBeVisible()
    await card().locator('.thread-card-input').fill('slow:40000 MOCK_SPEAK_AT:4000 And after a restart?')
    await card().locator('.thread-card-input').press('Enter')
    await expectState(page, 'thread-mark-waiting-neutral')
    await expect(waitLines().first()).toBeVisible({ timeout: 10_000 })
    await expect(card().locator('.thread-card-status')).toHaveText('Waiting')
    // The first words: the card's head and body say Answering… now.
    await expectState(page, 'thread-mark-live-neutral', 30_000)
    await expect(card()).not.toHaveAttribute('data-waiting', 'true')
    await expect(card().locator('.thread-card-status')).toHaveText('Answering…')
    await expect(card().locator('.thread-card-answering')).toHaveText('Answering…')
    await shot(page, '4b-card-answering', panel)
    await card().locator('.thread-card-input').press('Escape')
    await expect(card()).toHaveCount(0)
    await expect.poll(async () => ((await readRecord(request, RELOAD_SESSION)).threadAnchors ?? []).length).toBe(2)

    // ── Reload while it answers: a live state comes back, then the finished
    // answer nobody opened is red.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = sessionPanel(page, RELOAD_SESSION)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await centreInHistory(page, panel, PHRASE)
    await expect.poll(() => statesOfPassage(page), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([expect.stringMatching(/^thread-mark-(waiting|live)-neutral$/)]))
    await shot(page, '5-after-reload-live', panel)
    await expectState(page, 'thread-mark-unread-neutral', 90_000)
    await expect(scanLines()).toHaveCount(0)
    await expect(waitLines()).toHaveCount(0)
    await shot(page, '6-after-reload-unread', panel)
    // Still red after another reload: never opened.
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = sessionPanel(page, RELOAD_SESSION)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await centreInHistory(page, panel, PHRASE)
    await expectState(page, 'thread-mark-unread-neutral')

    // ── Opened, then reloaded: read, kept.
    await clickPassage(page, panel)
    await expect(card().locator('.thread-card-body')).toContainText('processed your message: And after a restart?', { timeout: 30_000 })
    await expectState(page, 'thread-mark-neutral')
    await card().locator('.thread-card-input').press('Escape')
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = sessionPanel(page, RELOAD_SESSION)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    await centreInHistory(page, panel, PHRASE)
    await expectState(page, 'thread-mark-neutral')
    await shot(page, '7-read-after-reload', panel)
  })

  test('a question queued behind a running main turn pulses amber the whole time it waits', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.setViewportSize({ width: 1280, height: 820 })
    const panel = await openThreadsSession(page, RELOAD_SESSION, RELOAD_TASK, READY, { view: 'linear' })
    const history = panel.locator('.session-history')
    const waitLines = history.locator('.thread-live-layer .thread-wait-line')
    // A long main turn first: the question will wait behind it.
    const composer = panel.locator('.session-panel-input .chat-input-textarea').first()
    await composer.fill('slow:25000 Keep going on the main thread.')
    await composer.press('Enter')
    await expect(panel.locator('.session-working-indicator')).toHaveCount(1, { timeout: 30_000 })
    await centreInHistory(page, panel, PHRASE)
    await selectPassage(page, panel, PHRASE)
    await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-ask-btn"]').click()
    const card = panel.locator('.thread-card')
    await card.locator('.thread-card-input').fill('What drains first?')
    await card.locator('.thread-card-input').press('Enter')
    // Queued in Walnut, or already handed to the busy CLI: either way it waits.
    await expect(card.locator('.thread-card-waiting')).toHaveText(/^(Queued: |Waiting for the first words)/, { timeout: 15_000 })
    await card.locator('.thread-card-close').click()
    await expect(card).toHaveCount(0)
    // Amber with its pulse at once, and still after well over 6 s in the queue.
    await expectState(page, 'thread-mark-waiting-neutral', 15_000)
    await expect(waitLines.first()).toBeVisible({ timeout: 10_000 })
    await expectPulsing(waitLines.first())
    await page.waitForTimeout(7_000)
    expect(await statesOfPassage(page)).toEqual(['thread-mark-waiting-neutral'])
    await expect(waitLines.first()).toBeVisible()
    await expect(history.locator('.thread-live-layer .thread-live-line')).toHaveCount(0)
    await shot(page, '8-queued-behind-main', panel)
  })

  test('every state has its own wash and line, in both themes', async ({ page }) => {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const paints = await page.evaluate(() => {
      const out: Record<string, { bg: string; deco: string }> = {}
      const walk = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) { walk(rule.cssRules); continue }
          if (!(rule instanceof CSSStyleRule)) continue
          const m = /^(\[data-theme="dark"\] )?::highlight\((thread-mark-[a-z-]*neutral)\)$/.exec(rule.selectorText)
          if (!m) continue
          out[`${m[1] ? 'dark' : 'light'}:${m[2]}`] = {
            bg: rule.style.getPropertyValue('background-color'),
            deco: `${rule.style.getPropertyValue('text-decoration-style')} ${rule.style.getPropertyValue('text-decoration-thickness')}`,
          }
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try { walk(sheet.cssRules) } catch { /* cross-origin */ }
      }
      return out
    })
    for (const theme of ['light', 'dark']) {
      const washes = STATE_NAMES.map((n) => paints[`${theme}:${n}`]?.bg)
      expect(washes.every(Boolean), `${theme}: a wash for every state (${JSON.stringify(washes)})`).toBe(true)
      expect(new Set(washes).size, `${theme}: no two states share a wash`).toBe(STATE_NAMES.length)
    }
    // The line tells them apart for color-blind readers too.
    expect(paints['light:thread-mark-waiting-neutral'].deco).toContain('dashed')
    expect(paints['light:thread-mark-failed-neutral'].deco).toContain('dotted')
    expect(paints['light:thread-mark-unread-neutral'].deco).toContain('3px')
    expect(paints['light:thread-mark-neutral'].deco).toContain('1px')
  })
})
