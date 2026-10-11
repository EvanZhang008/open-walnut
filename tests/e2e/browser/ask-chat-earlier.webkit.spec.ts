/**
 * An ask opened on the Mac shows what its chat said before its session, in WebKit:
 * the engine the Mac app is. Scenarios: ask-chat-earlier-helpers.ts.
 */
import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { SHOTS, continuedChatPutsTheEarlierPartAboveTheSession, oldChatOpensWithItsHistory } from './ask-chat-earlier-helpers'

test.use({ browserName: 'webkit' })
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('an old phone chat opens with its history above a session that never ran a turn', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await oldChatOpensWithItsHistory(page, 'webkit')
})

test('a continued chat shows its earlier part above the session, once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await continuedChatPutsTheEarlierPartAboveTheSession(page, 'webkit')
})
