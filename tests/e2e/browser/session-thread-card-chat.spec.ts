/**
 * The question card shows its conversation the way the chat does (2026-10-27,
 * the user: "it need to actually show the chat correctly the chat from user is
 * like walnut is blue bubble"; the old card was "hard to see"): each question is
 * the chat's blue user bubble, each answer a normal assistant message with the
 * same markdown and code blocks, rounds in order and set apart, and the card
 * stands off the page in light and dark.
 *
 * Chromium and WebKit. The review fixture session's first question has three
 * rounds; the second answer is a list with bold words, the third a code block.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, resetThreadsFixture } from './threads-helpers'
import { REVIEW_READY, REVIEW_ROUND_CODE, REVIEW_ROUNDS, REVIEW_SESSION, REVIEW_TASK, REVIEW_TITLES } from './threads-review-fixture'

async function shot(page: Page, name: string, el: Locator): Promise<void> {
  const dir = `/tmp/ask-card-chat/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await el.screenshot({ path: `${dir}/${name}.png` })
}

const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
/** WCAG relative luminance contrast of two rgb() strings. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = rgb(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

test.describe('the question card reads like the chat', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180_000)
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, REVIEW_SESSION) })

  test('three rounds: blue question bubbles, assistant answers with markdown and code, in light and dark', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.addStyleTag({ content: `.main-page-session-column:has(.session-panel[data-session-id="${REVIEW_SESSION}"]) {
      flex: 0 0 820px !important; width: 820px !important; min-width: 820px !important; max-width: 820px !important; }` })
    const panel = await openThreadsSession(page, REVIEW_SESSION, REVIEW_TASK, REVIEW_READY, { view: 'linear' })
    await panel.locator('.thread-map .thread-map-row[data-kind="thread"]', { hasText: REVIEW_TITLES[0] }).first().click()
    const card = panel.locator('.thread-card')
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-title')).toHaveText(REVIEW_TITLES[0])

    const turns = card.locator('.thread-card-turn')
    await expect(turns).toHaveCount(3)
    // Each question is the chat's blue bubble on the right, with its own words only.
    const bubbles = card.locator('.thread-card-q .session-msg.session-msg-user')
    await expect(bubbles).toHaveCount(3)
    await expect(card.locator('.thread-card-q')).toHaveText([...REVIEW_ROUNDS])
    const mainBubble = panel.locator('.session-history [data-message-id] .session-msg-user').first()
    const accent = await mainBubble.evaluate((el) => getComputedStyle(el).backgroundColor)
    for (let i = 0; i < 3; i++) {
      const b = bubbles.nth(i)
      expect(await b.evaluate((el) => getComputedStyle(el).backgroundColor), 'the same blue as the chat').toBe(accent)
      const box = (await b.boundingBox())!
      const body = (await card.locator('.thread-card-body').boundingBox())!
      expect(box.x + box.width, 'anchored on the right').toBeGreaterThan(body.x + body.width - 24)
      expect(await b.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft)), 'a bubble keeps its padding').toBeGreaterThan(6)
    }
    // Each answer is an assistant message: markdown, a list, a code block.
    const answers = card.locator('.thread-card-turn .session-msg-assistant')
    await expect(answers).toHaveCount(3)
    await expect(answers.nth(1).locator('li strong').first()).toHaveText('Before the seal')
    await expect(answers.nth(2).locator('pre code')).toContainText(REVIEW_ROUND_CODE)
    // Rounds set apart, in order; no card row poses as a timeline row.
    expect(await turns.nth(1).evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
    await expect(card.locator('[data-message-id]')).toHaveCount(0)

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.waitForTimeout(150)
      const look = await card.evaluate((el) => {
        const cs = getComputedStyle(el)
        const answer = el.querySelector('.thread-card-turn .session-msg-assistant .markdown-body p') as HTMLElement
        return { bg: cs.backgroundColor, shadow: cs.boxShadow, border: cs.borderTopColor, text: getComputedStyle(answer).color }
      })
      expect(look.shadow, `${theme}: the card casts a shadow`).not.toBe('none')
      expect(contrast(look.text, look.bg), `${theme}: the answer reads at full contrast (${look.text} on ${look.bg})`).toBeGreaterThan(11)
      const pageBg = await panel.locator('.session-history').evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(look.bg === pageBg && look.border === 'rgba(0, 0, 0, 0)', `${theme}: the card is set off the page`).toBe(false)
      await shot(page, `card-3-rounds-${theme}`, card)
    }
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  })
})
