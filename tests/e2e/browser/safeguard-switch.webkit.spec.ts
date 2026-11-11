/**
 * Playwright browser test (WebKit, the Mac app's engine): a session the model's safeguards refuse
 * twice in a row moves to another model by itself, and its chat says which model and why.
 *
 * Reported 2026-11-11: "API Error: Opus 5.5's safeguards flagged this message" came back turn after
 * turn and the session stayed stuck until the user typed /model. The fixture's mock CLI refuses
 * every line after "safeguard-refuse-unless:opus" in Claude Code 2.1.322's own stream shape until
 * its model contains "opus" (tests/providers/mock-claude.mjs); everything else is the real app and
 * server (src/core/sessions/safeguard-switch.ts).
 */
import fs from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { discoverFixtureRoot, draftComposer, draftSend, loadHome, openDraftOnCwd } from './draft-helpers'

const SCREENSHOT_DIR = '/tmp/safeguard-switch'

test.use({ viewport: { width: 1280, height: 860 } })
test.describe.configure({ timeout: 120_000 })

let fixtureRoot = ''
test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  fixtureRoot = await discoverFixtureRoot()
})

test('two refused turns: Walnut switches the model, says so in the chat, and the new model answers', async ({ page }) => {
  await loadHome(page)
  const panel = await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`, { engine: 'Claude' })
  await draftComposer(page).fill('safeguard-refuse-unless:opus please finish the flag registry')
  const launch = page.waitForRequest((req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await draftSend(panel).click()
  const { sessionId } = (await launch).postDataJSON() as { sessionId: string }
  const session = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(session).toBeVisible({ timeout: 30_000 })

  // The first refusal: Claude Code's own error line, nothing switched yet.
  await expect(session.getByText(/safeguards flagged this message/).first()).toBeVisible({ timeout: 30_000 })
  await expect(session.getByText(/Walnut switched this session/)).toHaveCount(0)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-first-refusal.png` })

  // The person tries again in the composer: refused a second time, and Walnut moves the session.
  const composer = session.locator('.session-panel-input textarea').first()
  await composer.click()
  await composer.fill('continue with the flag registry')
  await composer.press('Enter')
  await expect(session.getByText(/Walnut switched this session from .+ to Opus/).first()).toBeVisible({ timeout: 45_000 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-switched.png` })

  // The new model answers the resent words: the session ends its turn clean, and its record says Opus.
  await expect.poll(async () => {
    const r = await page.request.get(`/api/v1/sessions/${sessionId}/model-options`)
    return ((await r.json()) as { current?: string }).current ?? ''
  }, { timeout: 45_000 }).toMatch(/opus/i)
  await expect(session.getByText(/continue with the flag registry/).first()).toBeVisible()
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-answered.png` })
})
