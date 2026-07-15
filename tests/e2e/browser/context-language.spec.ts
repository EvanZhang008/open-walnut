/**
 * Regression guard: the main agent's prompt surface must contain no Chinese.
 *
 * Background: the task_create/task_update title descriptions used to ship
 * Chinese example titles. Tool schemas are sent to the model every turn, so
 * the agent imitated them, created Chinese task titles, and (combined with
 * the "respond in the user's language" rule) drifted into replying in
 * Chinese. This spec walks the Context Inspector — the UI mirror of the
 * real per-turn prompt — and fails if CJK ever re-enters the role section
 * or the tool schemas.
 */
import { test, expect } from '@playwright/test'

const CJK = /[一-鿿㐀-䶿぀-ヿ]/

const SHOT_DIR = process.env.PW_SHOT_DIR || 'test-results/context-language'

/** Open the Context Inspector via the chat header's ⋯ menu → "Show context". */
async function openInspector(page: import('@playwright/test').Page) {
  await page.locator('button[aria-label="Chat options"]').click()
  await page.locator('.chat-header-dropdown-item', { hasText: 'Show context' }).click()
  await expect(page.locator('.context-inspector')).toBeVisible({ timeout: 5000 })
}

/**
 * Scroll `text` into view inside `loc` and highlight it, so the screenshot
 * evidence shows the exact line being asserted. Screenshot-only DOM tweak —
 * runs after all assertions on the content.
 */
async function spotlight(loc: import('@playwright/test').Locator, text: string) {
  await loc.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const i = node.textContent?.indexOf(needle) ?? -1
      if (i >= 0) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + needle.length)
        const mark = document.createElement('mark')
        mark.style.background = '#ffe066'
        range.surroundContents(mark)
        mark.scrollIntoView({ block: 'center' })
        return
      }
    }
  }, text)
}

test('Role & Rules has the message-language rule and no CJK', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await openInspector(page)

  const roleHeader = page.locator('.context-section-header', { hasText: 'Role & Rules' })
  await roleHeader.click()
  const roleContent = roleHeader.locator('..').locator('.context-section-content')
  await expect(roleContent).toBeVisible()

  const text = await roleContent.innerText()
  expect(text).toContain('Respond in the language the user writes their messages in')
  expect(text).not.toMatch(CJK)

  await spotlight(roleContent, 'Respond in the language the user writes their messages in')
  await page.screenshot({ path: `${SHOT_DIR}/role-and-rules.png`, fullPage: false })
})

test('task_create tool schema shows English title examples and no CJK', async ({ page }) => {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  await openInspector(page)

  await page.locator('.context-section-header', { hasText: 'Tools' }).click()

  const createCard = page.locator('.context-tool-card', {
    has: page.locator('.context-tool-name', { hasText: 'task_create' }),
  })
  await createCard.locator('.context-tool-header').click()

  const schemaPre = createCard.locator('.context-pre')
  await expect(schemaPre).toBeVisible()

  const schema = await schemaPre.innerText()
  expect(schema).toContain('Sprint picker — query/select current sprint')
  expect(schema).not.toMatch(CJK)

  await spotlight(schemaPre, 'Sprint picker — query/select current sprint')
  await page.screenshot({ path: `${SHOT_DIR}/tools-task-create.png`, fullPage: false })
})

test('GET /api/context: no CJK anywhere in role section or tool schemas', async ({ request }) => {
  const res = await request.get('/api/context')
  expect(res.ok()).toBeTruthy()
  const body = await res.json()

  expect(body.sections.roleAndRules.content).not.toMatch(CJK)
  expect(JSON.stringify(body.sections.tools.content)).not.toMatch(CJK)
})
