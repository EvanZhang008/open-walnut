/**
 * The words the side panel draws while its Walnut frame loads (web/src/popout/useAskSnapshots.ts,
 * ext-snapshot.ts; kept by packages/browser-extension/src/panel-snap.ts), through the real
 * extension in Chromium:
 *
 * - the conversation is sent again as it moves: a follow-up and its reply reach the kept words
 *   without closing the panel (the drawing of the next open is the conversation as it was left);
 * - the toolbar popup keeps only the shell (its Continue rows), never its empty composer over the
 *   side panel's open conversation (review 2026-11-06, F3);
 * - so the next panel open draws the follow-up at once, also on another page: the open
 *   conversation is one, whatever the page (round 3), kept under one key per agent;
 * - the popup switched to another agent: the next panel open draws that agent's (or the bare
 *   Ask), never the first agent's question (round 3 code review, item 3).
 */
import { expect, test, type Page } from '@playwright/test'
import { askView, openPanel, startPanelLab, sw, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'snapshot')
})
test.afterAll(async () => { await lab?.close() })

type Kept = {
  ask?: Record<string, { messages: Array<{ role: string; text: string }>; cont?: unknown[]; agent?: string }>
  agent?: { id: string }
  shells?: Record<string, { at: number; agent?: string; cont?: unknown[] }>
}
const kept = async (): Promise<Kept> => (await sw(lab).evaluate(async () => chrome.storage.local.get('panelSnaps'))).panelSnaps ?? {}
/** Walnut's own agent (src/core/sessions/ask-list.ts GENERAL_AGENT_ID). */
const GENERAL = 'general'
/** The kept words of an agent's open conversation in the side panel (web/src/popout/ext-snapshot.ts askSnapKey). */
const pageWords = async (agent = GENERAL): Promise<string> => {
  const c = (await kept()).ask?.[`panel:agent:${agent}`]
  return c ? c.messages.map((m) => `${m.role}: ${m.text}`).join('\n') : ''
}

const FIRST = 'What changed for uploads?'
const SECOND = 'And does dark mode follow the system?'

test('a follow-up reaches the kept words while the panel stays open; the popup keeps the panel\'s conversation', async () => {
  test.setTimeout(240_000)
  const { panel } = await openPanel(lab, 'ask')
  const v = askView(panel)
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await composer.fill(FIRST)
  await composer.press('Enter')
  await expect(v.getByTestId('ask-object-session')).toBeVisible({ timeout: 60_000 })
  await expect(v.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(pageWords, { timeout: 15_000 }).toContain(FIRST)

  // The same conversation goes on: its follow-up and reply are sent again, with the panel open.
  const followUp = v.locator('.session-panel.is-plain-chat textarea').first()
  await followUp.fill(SECOND)
  await followUp.press('Enter')
  await expect(v.locator('.session-msg-user', { hasText: SECOND }).first()).toBeVisible({ timeout: 60_000 })
  await expect.poll(pageWords, { timeout: 15_000 }).toContain(SECOND)
  await panel.waitForTimeout(800)
  await panel.close()
  const before = await pageWords()
  expect((await kept()).agent?.id).toBe(GENERAL)

  // The toolbar popup on that page opens on the first page (a new task over the task list)...
  const opened = lab.ctx.waitForEvent('page')
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
  const pop: Page = await opened
  await expect(pop.frameLocator('iframe.panel-frame').locator('[data-testid="ext-home-composer"] textarea')).toBeVisible({ timeout: 60_000 })
  await pop.waitForTimeout(800)
  await pop.close()
  // ...and the panel's open conversation is as the panel left it.
  expect(await pageWords()).toBe(before)

  // The next panel open draws the follow-up at once, before its frame is up.
  const again = await openPanel(lab, 'ask')
  // (waitForSelector watches every frame of the page, so the brief drawing is not missed.)
  await again.panel.waitForSelector(`[data-testid="panel-snap"] .panel-snap-msg:has-text("${SECOND}")`, { state: 'visible', timeout: 10_000 })
  await again.panel.close()

  // On another page too: the same conversation is drawn, its page chip on for that page.
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  const other = await openPanel(lab, 'ask')
  await other.panel.waitForSelector(`[data-testid="panel-snap"] .panel-snap-msg:has-text("${SECOND}")`, { state: 'visible', timeout: 10_000 })
  await expect(askView(other.panel).getByTestId('ask-object-session')).toBeVisible({ timeout: 60_000 })
  await expect(askView(other.panel).getByTestId('ask-object-compose')).toHaveCount(0)
  await other.panel.close()
})

test('the popup switches to another agent: the next side panel draws that agent\'s, never the first agent\'s question', async () => {
  test.setTimeout(240_000)
  expect(await pageWords()).toContain(SECOND)
  const openPopup = async (): Promise<Page> => {
    const opened = lab.ctx.waitForEvent('page')
    await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
    return opened
  }
  /** In the popup's ≡ drawer, the agent list (its title unfolds it): pick `id`. */
  const pickAgent = async (pop: Page, id: string) => {
    const v = pop.frameLocator('iframe.panel-frame')
    await expect(v.locator('[data-testid="ext-home-composer"] textarea')).toBeVisible({ timeout: 60_000 })
    await v.getByTestId('ask-walnut-menu').click()
    const item = v.locator(`[data-testid="ask-walnut-agent-item"][data-agent-id="${id}"]`)
    if (!(await item.isVisible())) await v.getByTestId('ask-walnut-agent-switch').click()
    await item.click()
  }
  const pop = await openPopup()
  try {
    await pickAgent(pop, 'mentor')
    // The extension hears the agent the view is now on.
    await expect.poll(async () => (await kept()).agent?.id, { timeout: 15_000 }).toBe('mentor')
    await pop.waitForTimeout(800)
  } finally {
    await pop.close()
  }

  const { panel } = await openPanel(lab, 'ask')
  try {
    // Everything the drawing shows until the view takes over: never Walnut's conversation.
    const drawn = await panel.evaluate(() => new Promise<{ seen: boolean; texts: string[]; agents: string[] }>((resolve) => {
      const texts = new Set<string>()
      const agents = new Set<string>()
      let seen = false
      const look = () => {
        const el = document.querySelector('[data-testid="panel-snap"]')
        if (!el) return false
        seen = true
        for (const m of el.querySelectorAll('.panel-snap-msg')) texts.add(m.textContent ?? '')
        for (const a of el.querySelectorAll('.look-agent')) agents.add(a.textContent ?? '')
        return true
      }
      const done = () => { obs.disconnect(); resolve({ seen, texts: [...texts], agents: [...agents] }) }
      // Watched until the drawing goes (the view took over), from its first word on.
      const obs = new MutationObserver(() => { if (!look() && seen) done() })
      look()
      obs.observe(document.body, { childList: true, subtree: true, characterData: true })
      setTimeout(done, 12_000)
    }))
    expect(drawn.seen).toBe(true)
    // Mentor has no conversation yet: the drawing has none, never Walnut's.
    expect(drawn.texts).toEqual([])
    // It names Mentor once it has read which agent the view opens on.
    expect(drawn.agents.some((a) => a.includes('Mentor'))).toBe(true)
    const v = askView(panel)
    await expect(v.locator('.ext-ask-agent')).not.toContainText('Ask Walnut', { timeout: 60_000 })
    await expect(v.getByText(SECOND)).toHaveCount(0)
  } finally {
    // Back on Walnut's own agent, as this browser started.
    const v = askView(panel)
    await v.getByTestId('ext-ask-agent').click().catch(() => undefined)
    await v.locator(`[data-testid="ask-walnut-agent-item"][data-agent-id="${GENERAL}"]`).click().catch(() => undefined)
    await expect.poll(async () => (await kept()).agent?.id, { timeout: 15_000 }).toBe(GENERAL).catch(() => undefined)
    await panel.close()
  }
  // Walnut's own conversation was kept apart all along: the next open draws it again.
  expect(await pageWords()).toContain(SECOND)
})
