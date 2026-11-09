/**
 * The user's layout reaches the page even when the first GET /api/ui-prefs is slow
 * (web/src/utils/ui-prefs-sync.ts).
 *
 * The boot read has 2.5 s before the app renders. Under load (after a deploy, a busy Mac) it
 * timed out, the page never asked again and opened on the default layout (the chat column
 * open), and the defaults it then saved were PUT over the user's own prefs on the server.
 *
 * Here every full read is held at a gate the test opens (so nothing depends on how fast the
 * machine is): the boot read and the first background retry pass their deadlines unanswered,
 * the test then writes a default the way a component would, and opens the gate. The page must render on the defaults at once, take the user's saved layout when the
 * retry answers (the chat slot closes with no click), and send no PUT before that answer: a
 * default written meanwhile stays on this page and loses to the server's value.
 *
 * Every /api/ui-prefs request is answered by the route below, so nothing reaches the shared
 * fixture's prefs.
 */
import fs from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const SHOTS = process.env.UI_PREFS_LATE_SHOT_DIR ?? '/tmp/ui-prefs-late-read'
const CHAT_KEY = 'open-walnut-home-chat-visible'
/** Width of the chat spot, 0 when it is closed (collapsed or unmounted; ask-walnut-slot.spec.ts). */
async function chatSpotWidth(page: Page): Promise<number> {
  const chat = page.locator('.main-page-chat')
  if ((await chat.count()) === 0) return 0
  return (await chat.first().boundingBox())?.width ?? 0
}

test.setTimeout(90_000)

test('a slow first read: the page renders at once, then takes the saved layout, and PUTs nothing before the server answered', async ({ page }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.setViewportSize({ width: 1280, height: 800 })
  // The user's saved layout on the server: the chat spot closed, and a key only this page holds later.
  const serverPrefs: Record<string, { v: string | null; ts: number }> = { [CHAT_KEY]: { v: 'false', ts: Date.now() - 60_000 } }
  const t0 = Date.now()
  let fullGets = 0
  /** When the gate opened: no full read was answered before it. */
  let answeredAt = Number.POSITIVE_INFINITY
  let gateOpen = false
  let openGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => { openGate = () => { gateOpen = true; resolve() } })
  // What the page logged and asked about ui-prefs, for the failure message.
  const trail: string[] = []
  page.on('console', (m) => { if (/ui-prefs/.test(m.text())) trail.push(`${Date.now() - t0}ms console ${m.text().slice(0, 200)}`) })
  const withTrail = async (check: () => Promise<unknown>): Promise<void> => {
    try { await check() } catch (e) { throw new Error(`${(e as Error).message}\ntrail:\n${trail.join('\n')}`) }
  }
  page.on('request', (r) => { if (/\/api\/ui-prefs/.test(r.url())) trail.push(`${Date.now() - t0}ms ${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`) })
  const puts: Array<{ at: number; prefs: Record<string, { v: string | null; ts: number }> }> = []
  await page.route(/\/api\/ui-prefs(\?|$)/, async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as { prefs?: Record<string, { v: string | null; ts: number }> }
      puts.push({ at: Date.now(), prefs: body.prefs ?? {} })
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      return
    }
    const key = new URL(req.url()).searchParams.get('key')
    if (key) {
      // One key (a window merging its recent opens): answered at once, like the real route.
      const prefs = key in serverPrefs ? { [key]: serverPrefs[key] } : {}
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs }) })
      return
    }
    fullGets++
    // Held past the page's own deadline, then dropped (a request held for good stays open in
    // the browser's network layer and can hold up the next one); after the gate, answered.
    await Promise.race([gate, new Promise((r) => setTimeout(r, 6_000))])
    if (!gateOpen) { await route.abort('timedout').catch(() => {}); return }
    try {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ prefs: serverPrefs }) })
    } catch { /* the page gave up on this one (its deadline passed) */ }
  })

  // A fixture server left on :3457 by another checkout is reused as it is and serves that
  // tree's web code (playwright.config.ts reuseExistingServer): say so instead of failing later.
  const own = await page.request.get('/src/utils/ui-prefs-retry.ts')
  // (An SPA fallback answers 200 with HTML for a path it lacks: the module's own text is the proof.)
  expect(own.ok() && (await own.text()).includes('settledRefusal'), 'the fixture server on :3457 serves a checkout without this change (scripts/pw-cleanup.sh status)').toBe(true)

  await page.goto('/')
  // Rendered on the defaults before any answer: the chat spot is open.
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => chatSpotWidth(page), { timeout: 5_000, message: 'the chat spot opens on the defaults' }).toBeGreaterThan(1)
  const renderedAt = Date.now() - t0
  await page.screenshot({ path: `${SHOTS}/1-defaults-before-answer.png` })
  expect(answeredAt).toBe(Number.POSITIVE_INFINITY)
  // The boot read's deadline passed and the page asked again by itself.
  await withTrail(() => expect.poll(() => fullGets, { timeout: 20_000, message: 'no background retry' }).toBeGreaterThanOrEqual(2))
  // A component saves a default meanwhile (the chat open), and a key the server lacks.
  await page.evaluate((k) => {
    localStorage.setItem(k, 'true')
    localStorage.setItem('open-walnut-late-read-probe', 'only-here')
  }, CHAT_KEY)
  await page.waitForTimeout(1_500) // past the write mirror's debounce: a PUT would be out by now
  expect(puts, 'no PUT while the server had not answered').toEqual([])

  // The server answers the read in flight (or the next retry); the layout takes effect with no click.
  answeredAt = Date.now()
  openGate()
  await withTrail(() => expect.poll(() => chatSpotWidth(page), { timeout: 30_000, message: 'the saved layout (chat closed) never took effect (a page answered over 60 s after it loaded defers the remount to a hidden moment: check the load)' }).toBeLessThanOrEqual(1))
  await page.screenshot({ path: `${SHOTS}/2-users-layout-after-answer.png` })
  expect(Number.isFinite(answeredAt)).toBe(true)
  expect(await page.evaluate((k) => localStorage.getItem(k), CHAT_KEY)).toBe('false')

  // Let any debounced flush run, then read what went to the server.
  await page.waitForTimeout(1_500)
  const before = puts.filter((p) => p.at < answeredAt)
  expect(before, 'no PUT before the server answered').toEqual([])
  const chatPuts = puts.filter((p) => CHAT_KEY in p.prefs)
  expect(chatPuts, 'the default never replaced the saved chat choice').toEqual([])
  // The key the server did not hold went up once the prefs were read.
  expect(puts.some((p) => p.prefs['open-walnut-late-read-probe']?.v === 'only-here')).toBe(true)

  test.info().annotations.push({ type: 'timing', description: `rendered at ${renderedAt} ms, answered at ${answeredAt - t0} ms` })
})
