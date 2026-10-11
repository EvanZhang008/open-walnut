/**
 * An ask opened on the Mac shows what its chat said before its session (Chromium).
 * Scenarios and fixture: ask-chat-earlier-helpers.ts, chat-earlier-fixture.ts.
 * WebKit twin: ask-chat-earlier.webkit.spec.ts.
 */
import fs from 'node:fs'
import { test } from '@playwright/test'
import { SHOTS, continuedChatPutsTheEarlierPartAboveTheSession, oldChatOpensWithItsHistory } from './ask-chat-earlier-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)
test.beforeAll(() => { fs.mkdirSync(SHOTS, { recursive: true }) })

test('an old phone chat opens with its history above a session that never ran a turn', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await oldChatOpensWithItsHistory(page, 'chromium')
})

test('a continued chat shows its earlier part above the session, once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await continuedChatPutsTheEarlierPartAboveTheSession(page, 'chromium')
})
