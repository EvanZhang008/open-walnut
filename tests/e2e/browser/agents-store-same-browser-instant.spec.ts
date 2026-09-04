/**
 * One browser, one agent-definition store.
 *
 * /agents (the management page) and the homepage chat's agent switcher held
 * independent private copies with no event between them, so renaming an agent on
 * /agents left the switcher showing the old name until a full page reload —
 * MainPage never unmounts, so its own mount fetch never ran again.
 *
 * Both assertions navigate with real sidebar clicks and never reload.
 */
import { expect, test, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function createAgentViaApi(name: string): Promise<{ id: string; name: string }> {
  const id = `pw-agents-store-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, runner: 'embedded', console: true, description: 'store sync fixture' }),
  })
  if (!res.ok) throw new Error(`POST agent failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { agent: { id: string; name: string } }
  return body.agent
}

async function deleteAgentViaApi(id: string): Promise<void> {
  await fetch(`${API}/api/agents/${id}`, { method: 'DELETE' }).catch(() => {})
}

/** Open the home chat's agent switcher and return its dropdown rows. */
async function openAgentSwitcher(page: Page) {
  const combo = page.locator('.agent-tab-combo')
  await expect(combo).toBeVisible()
  await combo.click()
  const rows = page.locator('.agent-dd-row')
  await expect(rows.first()).toBeVisible()
  return { combo, rows }
}

async function gotoAgentsPage(page: Page): Promise<void> {
  await page.locator('.sidebar a[href="/settings"]').first().click()
  const navLink = page.getByTestId('settings-nav-agents')
  await expect(navLink).toBeVisible({ timeout: 30_000 })
  // Settings is a heavy page; under machine load the first click can land before
  // the link is wired, so keep clicking until the route actually changes.
  await expect.poll(async () => {
    if (!page.url().includes('/agents')) {
      await navLink.click({ timeout: 5000 }).catch(() => { /* re-render swapped the node */ })
    }
    return page.url()
  }, { timeout: 30_000 }).toContain('/agents')
  await expect(page.locator('.page-title')).toContainText('Agents', { timeout: 20_000 })
}

test('renaming an agent on /agents reaches the home switcher without a reload', async ({ page }) => {
  const original = `Store Sync Agent ${Date.now()}`
  const agent = await createAgentViaApi(original)
  const renamed = `${original} renamed`

  try {
    await page.goto('/')
    await page.waitForLoadState('networkidle')

    const first = await openAgentSwitcher(page)
    await expect(first.rows.filter({ hasText: original })).toHaveCount(1)
    await page.keyboard.press('Escape')

    await gotoAgentsPage(page)
    const card = page.locator('.agent-card', { hasText: agent.id })
    await expect(card).toBeVisible({ timeout: 15_000 })
    await card.locator('.agent-menu-btn').click()
    await card.locator('.agent-menu-item', { hasText: 'Edit' }).click()

    const form = page.locator('.agent-form')
    await expect(form).toBeVisible()
    await page.locator('#agent-name').fill(renamed)
    await form.locator('button[type="submit"]').click()
    await expect(form).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.agent-card', { hasText: agent.id })).toContainText(renamed)

    // Back home through the sidebar — no reload, so the switcher can only be
    // right if it reads the same list the page just wrote.
    await page.locator('.sidebar a[href="/"]').first().click()
    const second = await openAgentSwitcher(page)
    await expect(second.rows.filter({ hasText: renamed })).toHaveCount(1)
    await expect(second.rows.filter({ hasText: new RegExp(`${original}$`) })).toHaveCount(0)
    await page.keyboard.press('Escape')
  } finally {
    await deleteAgentViaApi(agent.id)
  }
})

test('an agent created outside the browser appears on /agents live', async ({ page }) => {
  // The server announces agent writes (`agents:changed`), so a second client — or
  // the Personal AI's agent_create tool — reaches an open page without a reload.
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await gotoAgentsPage(page)

  const name = `Store Push Agent ${Date.now()}`
  const agent = await createAgentViaApi(name)
  try {
    await expect(page.locator('.agent-card', { hasText: agent.id })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.agent-card', { hasText: agent.id })).toContainText(name)
  } finally {
    await deleteAgentViaApi(agent.id)
  }
})
