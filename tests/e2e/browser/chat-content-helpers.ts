/**
 * The chat content fixture session (test-server.ts, `pw-chat-content-session`):
 * task refs, a session ref, links, two images and a video in its replies. The
 * entity-refs, lightbox, video-preview and external-links specs read them there,
 * since Home no longer shows the Personal AI's chat-history.json, where they lived.
 */
import { expect, type Locator, type Page } from '@playwright/test'

export const CHAT_CONTENT_SESSION = 'pw-chat-content-session'

/** Open Home with the chat content session as its one column, its last reply drawn. */
export async function openChatContent(page: Page): Promise<Locator> {
  await page.addInitScript((sid) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: sid, locked: false }]))
  }, CHAT_CONTENT_SESSION)
  await page.goto('/')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CHAT_CONTENT_SESSION}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-history')).toContainText('Video recorded and delivered', { timeout: 20_000 })
  return panel
}
