/**
 * The chat is grey (2026-11-17, the user: "change our color code for the chat to like
 * chatgpt, grey, no color, very clean"): the user's words sit in a light grey bubble on the
 * right, the agent's answer is plain text, tool calls and code are grey panels, and links,
 * pills, badges and borders are grey too. Colour stays only on what needs the user (an
 * error, a question waiting on him). One palette (web/src/styles/chat-palette.css) is read
 * by every chat; this spec walks the rich fixture sessions in both themes and fails on any
 * element in a chat that still paints a hue (chat-quiet-palette-helpers.ts).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { paintedElements, summarize } from './chat-quiet-palette-helpers'

const SHOTS = path.join(process.env.WALNUT_TASK_DIR || '/tmp/wn-chat-palette', 'palette-shots')
const INVENTORY = !!process.env.CHAT_PALETTE_INVENTORY

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })
test.setTimeout(120_000)

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

/** The fixture's richest chats (test-server.ts): folds, cards, pills, code, envelopes. */
const SESSIONS = [
  { task: 'pw-task-fold', sid: 'pw-fold-session' },
  { task: 'pw-task-inbound', sid: 'pw-inbound-session' },
  { task: 'pw-task-chat-content', sid: 'pw-chat-content-session' },
  { task: 'pw-task-codepath', sid: 'pw-codepath-session' },
  { task: 'pw-task-provenance', sid: 'pw-provenance-session' },
  { task: 'pw-task-banner', sid: 'pw-banner-session' },
  { task: 'pw-task-idref', sid: 'pw-idref-session' },
  { task: 'pw-task-opcards', sid: 'pw-opcards-session' },
  { task: 'pw-task-rider', sid: 'pw-rider-session' },
]

async function openSession(page: Page, task: string, sid: string): Promise<Locator> {
  const panel = page.locator(`.session-panel[data-session-id="${sid}"]`)
  const row = page.locator(`.todo-panel-item[data-task-id="${task}"]`)
  await expect(async () => {
    await page.locator('.todo-search-input').fill(task)
    await expect(row).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  await expect(panel).toBeVisible({ timeout: 15_000 })
  await expect(panel.locator('.session-history .session-msg').first()).toBeVisible({ timeout: 20_000 })
  return panel
}

/** Opens every closed fold in the timeline so its rows are checked too. */
async function openFolds(panel: Locator): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const closed = panel.locator('.session-history [aria-expanded="false"]')
    const n = Math.min(await closed.count(), 40)
    if (n === 0) return
    for (let i = n - 1; i >= 0; i--) await closed.nth(i).click({ timeout: 2_000 }).catch(() => {})
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`every chat is grey in the ${theme} theme`, async ({ page, browserName }) => {
    await page.addInitScript((t) => localStorage.setItem('open-walnut-theme', t), theme)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    const report: string[] = []
    for (const s of SESSIONS) {
      const panel = await openSession(page, s.task, s.sid)
      await openFolds(panel)
      await page.waitForTimeout(300)
      await panel.screenshot({ path: path.join(SHOTS, `${s.sid}-${theme}-${browserName}.png`) })
      const painted = [
        ...await paintedElements(panel.locator('.session-history')),
        ...await paintedElements(panel.locator('.chat-input-container')),
      ]
      if (INVENTORY) {
        // The class names drawn in a chat: CHAT_CLASSES in tests/web/chat-palette-guard.test.ts.
        const names = await panel.evaluate((el) => [...new Set([...el.querySelectorAll('.session-history *, .chat-input-container *')]
          .flatMap((n) => [...n.classList]))].sort())
        await fs.appendFile(path.join(SHOTS, `classes-${browserName}.txt`), names.join('\n') + '\n')
      }
      const lines = summarize(painted)
      report.push(`## ${s.sid} (${theme}, ${browserName}): ${painted.length}`, ...lines)
      if (!INVENTORY) expect(lines, `${s.sid} paints a hue in ${theme}`).toEqual([])
    }
    await fs.writeFile(path.join(SHOTS, `inventory-${theme}-${browserName}.txt`), report.join('\n') + '\n')
  })
}
