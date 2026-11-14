/**
 * Settings > Sessions > Reply language, against the fixture's REAL server: the
 * sentence typed in the row is what config.session.reply_language holds, it
 * survives a reload, other session settings are kept, and clearing it removes
 * the key (no line is added for an empty setting). Since 2026-11-06 the setting is
 * a line of every session's instructions, never a message hint: the row's help says
 * so and Message hints has no Reply language row. page.goto is only the first
 * load; the pane switch is a real nav click.
 */
import { test, expect, type Page } from '@playwright/test'

const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.'

async function readSession(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/config')
  const body = await res.json() as { config?: { session?: Record<string, unknown> } }
  return body.config?.session ?? {}
}

async function openSessions(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-sessions').click()
  await expect(page.locator('#sessions.settings-section')).toBeVisible({ timeout: 20_000 })
}

test('the reply language saves on blur, reloads, keeps other session settings, and clears', async ({ page }) => {
  const before = await readSession(page)
  await openSessions(page)
  const input = page.getByTestId('session-reply-language')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue(typeof before.reply_language === 'string' ? before.reply_language : '')
  await expect(page.locator('#settings-reply-language .settings-row-help'))
    .toHaveText("One sentence in every session's instructions; a running session hears a change, and a reply that drifts from it gets a short correction. Empty says nothing about language.")

  await input.fill(RULE)
  await input.blur()
  await expect.poll(async () => (await readSession(page)).reply_language, { timeout: 10_000 }).toBe(RULE)
  // The rule is a line of the system prompt; the one message hint with it is the correction after a
  // drift (hints/reply-language-drift.ts), and its "What it sends" follows the edit.
  const langHint = page.getByTestId('message-hint-reply-language')
  await expect(langHint).toHaveCount(1)
  await langHint.getByRole('button', { name: /Reply language/ }).click()
  const sends = page.getByTestId('message-hint-sends-reply-language')
  await expect(sends.locator('mark.message-hint-yours')).toHaveText(RULE, { timeout: 10_000 })
  await expect(sends).toContainText('Your last reply the user read was not in this language')
  const after = await readSession(page)
  // Saving this row must not drop any other session setting. Presence, not
  // values: parallel specs flip some of them on the same fixture server.
  for (const k of Object.keys(before)) expect(Object.keys(after), k).toContain(k)
  await page.locator('#sessions .settings-group').filter({ has: input }).screenshot({ path: test.info().outputPath('replies-group.png') })

  // A fresh load shows what the server holds.
  await openSessions(page)
  await expect(page.getByTestId('session-reply-language')).toHaveValue(RULE)

  // Enter commits too; an empty field removes the key.
  await page.getByTestId('session-reply-language').fill('')
  await page.getByTestId('session-reply-language').press('Enter')
  await expect.poll(async () => 'reply_language' in (await readSession(page)), { timeout: 10_000 }).toBe(false)

  // And a fresh load shows it empty.
  await openSessions(page)
  await expect(page.getByTestId('session-reply-language')).toHaveValue('')
})
