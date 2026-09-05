/**
 * Ask Walnut launch memory on the draft column.
 *
 * "Ask Walnut always starts on Opus / medium" was the report: Auto + medium
 * are the Personal AI's FIRST-RUN defaults, but a pick the user makes for an
 * Ask Walnut session (the draft's pill at launch, or the running session's
 * picker) is what the next Ask Walnut should start on. The server owns that
 * memory (GET /api/sessions/ask-walnut-launch, applied at spawn); this spec
 * pins the draft's half of the contract, through the real UI:
 *   1. entering Ask Walnut seeds the model pill from the memory (not Auto)
 *   2. the launch CARRIES the seeded model (the payload names it, the started
 *      session spawns on it) — a stale meta.engine must not drop it
 *   3. leaving Ask Walnut takes the seeded model with it — the Personal AI's
 *      remembered model must not leak into a coding draft
 *   4. with an empty memory the pill stays on Auto (the first-run truth), and
 *      that launch names NO model (so the server-side memory still applies)
 *
 * The memory is seeded the way a user would seed it: a real quick-start with a
 * model pick (mock CLI), and cleared with the explicit Auto ('default') the
 * pill's Auto row sends — never by poking the store, so the round-trip through
 * the route is what is under test.
 */
import { test, expect, type Page } from '@playwright/test'
import { draftComposer, draftPanel, loadHome, openDraft } from './draft-helpers'

const SCREENSHOT_DIR = process.env.DRAFT_SHOT_DIR ?? '/tmp/ask-walnut-launch-memory'

test.setTimeout(180_000)
test.describe.configure({ mode: 'serial' })

const modelPill = (page: Page) => draftPanel(page).locator('.draft-actions-bar .draft-model-select')
const askWalnutCard = (page: Page) => page.locator('.draft-intent-card-walnut')
const startTaskCard = (page: Page) => page.locator('.draft-intent-card').filter({ hasText: 'Start Task' })
const isQuickStart = (url: string) => new URL(url).pathname === '/api/sessions/quick-start'
const isMemoryRead = (url: string) => new URL(url).pathname === '/api/sessions/ask-walnut-launch'
/** Ask Walnut has no "Start ↵" button: the composer's send arrow is the one send affordance. */
const sendBtn = (page: Page) => draftPanel(page).locator('.chat-send-btn-icon')

/** Seed (a raw picker value) or reset ('default' = the pill's Auto row) the memory
 *  through the same route the draft uses. */
async function seedMemoryWithModel(page: Page, model: string): Promise<void> {
  const res = await page.request.post('/api/sessions/quick-start', {
    data: { walnutAgent: true, message: `launch-memory seed ${Date.now()}`, model },
  })
  expect(res.status(), await res.text()).toBe(200)
  await expect.poll(async () => {
    const mem = await (await page.request.get('/api/sessions/ask-walnut-launch')).json() as { model?: string }
    return mem.model
  }, { message: 'the launch memory never took the seed' }).toBe(model === 'default' ? undefined : model)
}

/** Click the Ask Walnut card and wait for its memory read to land, so a pill
 *  assertion right after is about the seed, not about timing. */
async function enterAskWalnut(page: Page): Promise<void> {
  const read = page.waitForResponse((res) => isMemoryRead(res.url()))
  await askWalnutCard(page).click()
  await expect(askWalnutCard(page)).toHaveAttribute('aria-pressed', 'true')
  expect((await read).status()).toBe(200)
}

test('Ask Walnut seeds the model pill from the last pick, launches on it, and takes it back when leaving the tab', async ({ page }) => {
  await seedMemoryWithModel(page, 'sonnet')
  await loadHome(page)
  await openDraft(page)

  // A plain draft is on Auto — the walnut memory is Ask Walnut's alone.
  await expect(modelPill(page)).toHaveAttribute('data-model', '')

  // 1. Enter Ask Walnut → the pill re-selects the remembered raw picker value.
  await enterAskWalnut(page)
  await expect(modelPill(page)).toHaveAttribute('data-model', 'sonnet')
  await expect(modelPill(page)).not.toHaveText(/^Auto/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-ask-walnut-seeded.png` })

  // 3. Back to Start Task → the seed goes with it (Auto again, not sonnet)…
  await startTaskCard(page).click()
  await expect(startTaskCard(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(modelPill(page)).toHaveAttribute('data-model', '')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-start-task-restored.png` })

  // …and re-entering seeds again.
  await enterAskWalnut(page)
  await expect(modelPill(page)).toHaveAttribute('data-model', 'sonnet')

  // 2. Launch: the payload NAMES the seeded model and the session spawns on it.
  await draftComposer(page).fill(`launch on the remembered model ${Date.now()}`)
  const launch = page.waitForRequest((req) => req.method() === 'POST' && isQuickStart(req.url()))
  await sendBtn(page).click()
  const payload = (await launch).postDataJSON() as { model?: string; walnutAgent?: boolean; sessionId?: string }
  expect(payload.walnutAgent).toBe(true)
  expect(payload.model).toBe('sonnet')
  expect(payload.sessionId).toBeTruthy()
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${payload.sessionId}`)
    if (res.status() !== 200) return undefined
    return ((await res.json()) as { session?: { cliModel?: string } }).session?.cliModel
  }, { timeout: 30_000, message: 'the started session never spawned on the remembered model' }).toBe('sonnet')
})

test('an empty memory leaves the Ask Walnut pill on Auto, and that launch names no model', async ({ page }) => {
  // The pill's Auto row sends 'default' — the one thing that clears the model.
  await seedMemoryWithModel(page, 'default')
  await loadHome(page)
  await openDraft(page)
  await enterAskWalnut(page)
  await expect(modelPill(page)).toHaveAttribute('data-model', '')
  await expect(modelPill(page)).toHaveText(/^Auto/)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-empty-memory-auto.png` })

  // Untouched pill → NO model key (the server applies whatever is remembered
  // by the time the launch lands); 'default' is reserved for a hand-picked Auto.
  await draftComposer(page).fill(`launch with an untouched pill ${Date.now()}`)
  const launch = page.waitForRequest((req) => req.method() === 'POST' && isQuickStart(req.url()))
  await sendBtn(page).click()
  const payload = (await launch).postDataJSON() as { model?: string; walnutAgent?: boolean }
  expect(payload.walnutAgent).toBe(true)
  expect(payload.model).toBeUndefined()
})
