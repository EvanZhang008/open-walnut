/**
 * The Context Inspector, as it exists after the main agent was removed (P1).
 *
 * WHAT CHANGED, and therefore what this spec now pins: the inspector's subject is
 * the Ask Walnut SESSION the slot is showing, so the panel describes THAT
 * session's launch config (`GET /api/context?sessionId=…`). With no ask selected
 * there is nothing to describe and the panel says so, instead of asking for the
 * configured default lane: that parameterless answer is the in-process prompt
 * assembly (role, skills index, 50-odd tool schemas), and the panel rendered it as
 * if it were the launch config of the conversation on screen. Every "11 sections /
 * tool cards / Total: ~N tokens" DOM assertion this file used to carry depended on
 * exactly that answer, which is why they are gone.
 *
 * The panel MECHANICS worth keeping are all still here: the header button opens and
 * closes it, a section collapses and expands, Refresh re-reads the same subject,
 * and the slot below stays usable while it is open.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadHome, openAskWalnutDrawer } from './draft-helpers'

/** Unique per run: the fixture server is shared and survives across runs. */
const STAMP = Date.now().toString(36)

/** The Context toggle is a row in the slot's ≡ drawer; opening the drawer first
 *  is part of the gesture (the drawer closes itself on the click). */
const inspectorBtn = (page: Page) => page.locator('[data-testid="ask-walnut-inspector"]')
async function clickInspector(page: Page): Promise<void> {
  await openAskWalnutDrawer(page)
  await inspectorBtn(page).click()
}
const inspector = (page: Page) => page.locator('.context-inspector')

const isContextRequest = (url: string): boolean => new URL(url).pathname === '/api/context'

/**
 * Hide EVERY Ask Walnut task from this page's task store, so the slot genuinely
 * has no subject to inspect.
 *
 * The fixture server is SHARED and other specs launch asks into it, so "no ask
 * selected" has to be produced rather than assumed. The socket is dead-ended for
 * the same reason: `task:created` is a global broadcast, so a parallel spec's
 * launch would be inserted straight into this page's store (same reasoning as
 * ask-walnut-slot.spec.ts).
 */
async function hideAllAsks(page: Page): Promise<void> {
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('**/api/tasks*', async (route) => {
    const request = route.request()
    if (request.method() !== 'GET' || new URL(request.url()).pathname !== '/api/tasks') {
      await route.fallback()
      return
    }
    const response = await route.fetch()
    let body: { tasks?: Array<{ walnut_agent?: boolean }> }
    try {
      body = (await response.json()) as typeof body
    } catch {
      await route.fulfill({ response })
      return
    }
    if (!Array.isArray(body.tasks)) {
      await route.fulfill({ response })
      return
    }
    body.tasks = body.tasks.filter((task) => task?.walnut_agent !== true)
    // The body is re-serialized here, so the upstream framing no longer describes it.
    const headers = { ...response.headers() }
    delete headers['content-length']
    delete headers['content-encoding']
    await route.fulfill({
      status: response.status(),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
}

/** Launch one Ask Walnut session from the slot and return its session id. */
async function launchAsk(page: Page, prompt: string): Promise<string> {
  await openAskWalnutDrawer(page)
  await page.locator('[data-testid="ask-walnut-new"]').click()
  const composer = page.locator('[data-testid="ask-walnut-draft"] .chat-input-textarea')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  const quickStart = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/sessions/quick-start',
  )
  await composer.fill(prompt)
  await composer.press('Enter')
  const response = await quickStart
  expect(response.status(), await response.text()).toBe(200)
  const payload = (await response.json()) as { sessionId?: string }
  expect(payload.sessionId, 'the launch response carried no sessionId').toBeTruthy()
  // The slot IS the session view now, bound to the id the launch minted.
  await expect(page.locator('[data-testid="ask-walnut-session"]'))
    .toHaveAttribute('data-session-id', payload.sessionId!, { timeout: 60_000 })
  return payload.sessionId!
}

test.setTimeout(120_000)

// ── Open and close ───────────────────────────────────────────────────────────

test('the Context row is in the Ask Walnut drawer', async ({ page }) => {
  await loadHome(page)
  await openAskWalnutDrawer(page)
  await expect(inspectorBtn(page)).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')
})

test('Context opens the inspector, and clicking it again closes it', async ({ page }) => {
  await loadHome(page)
  await expect(inspector(page)).toBeHidden()

  await clickInspector(page)
  await expect(inspector(page)).toBeVisible({ timeout: 20_000 })
  await expect(inspector(page).locator('.context-inspector-title')).toContainText('Agent Context Inspector')

  await clickInspector(page)
  await expect(inspector(page)).toBeHidden()
})

// ── No subject ───────────────────────────────────────────────────────────────

test('with no ask selected the panel says so and asks the server nothing', async ({ page }) => {
  await hideAllAsks(page)
  await loadHome(page)

  // Armed BEFORE the click, so the observation window is exactly the interaction
  // (a request started earlier can never land in this array).
  const contextRequests: string[] = []
  page.on('request', (request) => {
    if (isContextRequest(request.url())) contextRequests.push(request.url())
  })

  await clickInspector(page)
  await expect(inspector(page)).toBeVisible({ timeout: 20_000 })
  await expect(inspector(page)).toContainText('Select an ask to inspect its launch context')

  // THE ASSERTION THIS TEST EXISTS FOR: no subject ⇒ no request. A parameterless
  // GET answers for the configured DEFAULT lane, and the panel then presented
  // that assembly as the launch config of whatever the slot was showing.
  await page.waitForTimeout(1500)
  expect(contextRequests, 'the inspector asked /api/context with no subject').toEqual([])
  // No section chrome is invented for it either.
  await expect(inspector(page).locator('.context-section')).toHaveCount(0)
})

// ── A selected ask ───────────────────────────────────────────────────────────

test('with an ask selected the panel describes THAT session, and Refresh re-reads it', async ({ page }) => {
  await loadHome(page)
  const sessionId = await launchAsk(page, `context inspector subject ${STAMP}`)

  const firstRead = page.waitForRequest((request) => isContextRequest(request.url()))
  await clickInspector(page)
  expect(new URL((await firstRead).url()).searchParams.get('sessionId'),
    'the inspector read a different conversation than the one on screen').toBe(sessionId)

  const panel = inspector(page)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  // The engine reading. An ask runs in a `claude` CLI session, so the number in
  // the header is a SYSTEM PROMPT size and the tool/transcript sections the
  // in-process loop used to fill are absent — the CLI owns those.
  await expect(panel.locator('.context-token-badge', { hasText: 'Claude Code engine' }))
    .toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.context-token-badge-total')).toContainText('System prompt')
  await expect(panel.locator('.context-section-title', { hasText: 'Tools' })).toHaveCount(0)

  // A section still collapses and expands, and this one carries the launch config
  // the session was actually spawned with.
  const personaSection = panel.locator('.context-section').filter({
    has: page.locator('.context-section-title', { hasText: 'Persona Prompt' }),
  })
  await expect(personaSection).toHaveCount(1)
  const personaContent = personaSection.locator('.context-section-content')
  await expect(personaContent).toBeHidden()
  await personaSection.locator('.context-section-header').click()
  await expect(personaContent).toBeVisible()
  await expect(personaContent).toContainText('Claude Code session')
  await personaSection.locator('.context-section-header').click()
  await expect(personaContent).toBeHidden()

  // Refresh re-reads the SAME subject. It is the only refresh path on this engine:
  // a launch config is fixed for the session's life, so an `agent:response` no
  // longer re-fetches it.
  const refresh = page.waitForRequest((request) => isContextRequest(request.url()))
  await panel.locator('.context-inspector-header .btn', { hasText: 'Refresh' }).click()
  expect(new URL((await refresh).url()).searchParams.get('sessionId')).toBe(sessionId)
  await expect(panel.locator('.context-token-badge-total')).toBeVisible()
})

// ── The slot stays usable ────────────────────────────────────────────────────

test('the slot composer stays usable with the inspector open', async ({ page }) => {
  await loadHome(page)
  await clickInspector(page)
  await expect(inspector(page)).toBeVisible({ timeout: 20_000 })

  const composer = page.locator('[data-testid="ask-walnut-slot"] .chat-input-textarea').first()
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(composer).toBeEnabled()
  await composer.fill(`inspector open ${STAMP}`)
  await expect(composer).toHaveValue(`inspector open ${STAMP}`)
})

// ── The route itself ─────────────────────────────────────────────────────────

test('GET /api/context with no params still answers for the configured default', async ({ request }) => {
  const res = await request.get('/api/context')
  expect(res.ok()).toBeTruthy()

  const body = await res.json()
  expect(body).toHaveProperty('sections')
  expect(body.totalTokens).toBeGreaterThan(0)

  // Sections NAMED, not counted: the list grows (a `recentTasks` ledger joined it,
  // and the old `toHaveLength(11)` had been silently stale ever since).
  const names = Object.keys(body.sections)
  for (const name of ['modelConfig', 'roleAndRules', 'skills', 'userProfile', 'globalMemory', 'tools', 'apiMessages']) {
    expect(names, `section "${name}" is missing`).toContain(name)
  }
})

test('GET /api/context?sessionId= 404s on a session the store does not know', async ({ request }) => {
  const res = await request.get('/api/context?sessionId=no-such-session-at-all')
  expect(res.status()).toBe(404)
  expect((await res.json()).error).toContain('no-such-session-at-all')
})
