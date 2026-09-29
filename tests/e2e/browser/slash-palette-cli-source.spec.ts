/**
 * The composer's "/" palette for a LIVE session lists what the session's CLI
 * advertised in its `system/init` line — not what Walnut found by scanning the
 * host's skill directories.
 *
 * Incident pinned (2026-09-04): right after a deploy the remote daemon was
 * mid-upgrade, the palette's SSH discovery timed out, and the list silently
 * shrank to "Walnut + 4 built-ins" until the user pressed Refresh. The CLI list
 * cannot shrink that way: an unreachable host costs descriptions only.
 *
 * The mock CLI (tests/providers/mock-claude.mjs) advertises
 *   compact, clear, mock-skill-alpha, mock-skill-beta, doctor, color, __internal-thing
 * with doctor + color terminal-only. So the palette must show exactly clear,
 * compact, mock-skill-alpha, mock-skill-beta (plus the composer's own `/model`
 * control), and NOT the shipped Walnut skills the directory scan finds for the
 * same cwd — the CLI never listed those, so the session could not run them.
 */

import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { discoverFixtureRoot, draftComposer, draftCwdPill, openDraftOnCwd, loadHome, seedColumns, draftSend } from './draft-helpers'

const SCREENSHOT_DIR = process.env.SLASH_SHOT_DIR ?? '/tmp/slash-palette-cli'

let fixtureRoot = ''
test.beforeAll(async () => { fixtureRoot = await discoverFixtureRoot() })

// A real (mock) CLI spawn plus the fixture's health-monitor stalls.
test.setTimeout(150_000)

test('the Skills shortcut on a real session lists skills without replacing the slash-command palette', async ({ page }) => {
  const sid = 'pw-workflow-session'
  const items = [
    { name: 'compact', description: 'Compact context', source: 'built-in' },
    { name: 'review', description: 'Review changes', source: 'project' },
    { name: 'project-helper', description: 'Help with the project', source: 'project', kind: 'skill' },
    { name: 'walnut-trigger', description: 'Watch changes', source: 'skill', kind: 'skill' },
  ]
  await page.route(`**/api/sessions/${sid}/slash-commands?**`, (route) => route.fulfill({ json: { items, source: 'cli', degraded: false } }))
  await seedColumns(page, [sid])
  await loadHome(page)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  const input = panel.locator('.session-panel-input .chat-input-textarea')
  await panel.locator('.session-panel-input .chat-plus-btn').click()
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await panel.locator('.session-panel-input .chat-plus-menu').screenshot({ path: `${SCREENSHOT_DIR}/skills-menu-${test.info().project.name}.png`, animations: 'disabled' })
  await panel.getByRole('menuitem', { name: /Skills$/ }).click()
  const palette = panel.locator('.command-palette')
  await expect(palette.locator('.command-palette-name')).toHaveText(['/project-helper', '/walnut-trigger'])
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(input).toHaveValue('/walnut-trigger ')
  await input.fill('')
  await input.pressSequentially('/r')
  await expect(palette.locator('.command-palette-name')).toHaveText(['/review', '/project-helper', '/walnut-trigger'])
})

test('a live session palette lists the CLI-advertised commands, hides terminal-only + internal ones, and drops scan-only skills', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.setContent('<a href="/">Open Walnut</a>')
  await page.getByRole('link').evaluate((el, url) => { (el as HTMLAnchorElement).href = url },
    `http://localhost:${process.env.PW_TEST_PORT ?? 3457}/`)
  await page.getByRole('link').click()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

  const cwd = `${fixtureRoot}/projects/walnut`
  const panel = await openDraftOnCwd(page, cwd)
  await draftCwdPill(panel).click()
  const folder = page.locator('.session-path-selector')
  await folder.getByRole('button', { name: 'Claude', exact: true }).click()
  await folder.locator('.sps-search-input').press('Shift+Enter')
  await expect(folder).toBeHidden()
  await draftComposer(page).fill(`slash palette probe ${Date.now()}`)

  const launch = page.waitForRequest((req) =>
    req.method() === 'POST' && new URL(req.url()).pathname === '/api/sessions/quick-start')
  await draftSend(panel).click()
  const { sessionId } = (await launch).postDataJSON() as { sessionId?: string }
  expect(sessionId, 'native quick-start sends a client session id').toBeTruthy()

  const newPanel = page.locator(`.session-panel[data-session-id="${sessionId}"]`)
  await expect(newPanel).toBeVisible({ timeout: 30_000 })
  // The mock CLI answers instantly; its init (with slash_commands) precedes the reply.
  await expect(newPanel.getByText(/I processed your message/).first()).toBeVisible({ timeout: 60_000 })

  // The per-session endpoint answers from the CLI list, decorated (not degraded).
  // Polled: the panel mounts before the CLI's init reaches the server, so the very
  // first answer can legitimately be the discovery fallback.
  await expect.poll(async () => {
    const res = await page.request.get(`/api/sessions/${sessionId}/slash-commands`)
    const body = await res.json() as { source?: string; degraded?: boolean; items: { name: string }[] }
    return body.source === 'cli' && !body.degraded ? body.items.map((i) => i.name).join(',') : `${body.source}${body.degraded ? ':degraded' : ''}`
  }, { timeout: 30_000, message: 'per-session palette should come from the CLI init list' })
    .toBe('clear,compact,mock-skill-alpha,mock-skill-beta')

  // The composer itself: the hook's own retry/on-open revalidation must have
  // replaced the mount-time discovery list without any Refresh click.
  const composer = newPanel.locator('.chat-input-textarea')
  await composer.click()
  await composer.type('/')

  const palette = newPanel.locator('.command-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })
  const names = palette.locator('.command-palette-name')
  // `/model` is the composer's own control (opens the picker); the CLI's `model`
  // is not in the mock list, but if it were, the control would replace it.
  await expect(names).toHaveText(['/model', '/clear', '/compact', '/mock-skill-alpha', '/mock-skill-beta'], { timeout: 15_000 })
  await expect(palette.getByText('/doctor')).toHaveCount(0)
  await expect(palette.getByText('/color')).toHaveCount(0)
  await expect(palette.getByText('/__internal-thing')).toHaveCount(0)
  // Shipped Walnut skills exist on disk for this cwd's scan but the CLI never listed them.
  await expect(palette.getByText('/walnut', { exact: true })).toHaveCount(0)
  // Reachable host → no degraded footnote.
  await expect(newPanel.locator('.command-palette-note')).toHaveCount(0)
  await newPanel.screenshot({ path: `${SCREENSHOT_DIR}/01-cli-palette.png` })

  // Filtering still works against the CLI list.
  await composer.type('mock')
  await expect(names).toHaveText(['/mock-skill-alpha', '/mock-skill-beta'])
  await newPanel.screenshot({ path: `${SCREENSHOT_DIR}/02-filtered.png` })
})
