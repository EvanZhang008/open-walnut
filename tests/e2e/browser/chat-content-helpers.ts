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

/**
 * Scroll the chat back to its first reply with the mouse wheel, as a reader does, and wait
 * until `target` sits clear of the panel's header. The header is glass over the top of the
 * scroller: opened at its end, the first reply is partly under it, where a click lands on the
 * header. A click's own scroll-into-view cannot bring it out: the chat follows its end, and
 * a scroll no wheel, touch or key made is taken back to the end (SessionChatHistory's echo
 * guard), so only the reader's input moves it.
 */
export async function scrollChatToFirstReply(page: Page, chat: Locator, target: Locator): Promise<void> {
  const hist = (await chat.locator('.session-history').boundingBox())!
  await page.mouse.move(hist.x + hist.width / 2, hist.y + hist.height / 2)
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -1500)
  const header = chat.locator(':scope > .session-panel-header')
  await expect.poll(async () => {
    const [pill, head] = await Promise.all([target.boundingBox(), header.boundingBox()])
    return !!pill && !!head && pill.y >= head.y + head.height
  }, { timeout: 10_000 }).toBe(true)
}
