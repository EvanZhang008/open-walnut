/**
 * Shared steps for the engine settings specs (the session popover, the API
 * checks) and the Settings > Sessions default-engine specs.
 *
 * The fixture server (test-server.ts) seeds a dense claude `settings.json` and a
 * codex `config.toml` under its isolated HOME. Specs reach those files through
 * the server's own `notesDir` (HOME/notes), never the developer's real home.
 */
import { expect, type Page, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function fixtureHome(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { notesDir?: string }
  expect(typeof body.notesDir).toBe('string')
  return path.dirname(body.notesDir!)
}

export async function readClaudeSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(home, '.claude', 'settings.json'), 'utf-8')) as Record<string, unknown>
}

/**
 * Real SPA navigation: sidebar, Settings, then the Sessions nav item, which
 * holds the "Default engine" row since the Engines pane was retired. Returns
 * the section locator.
 */
export async function openSessionsSection(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
  }
  await page.locator('.sidebar-nav a[href="/settings"]').click()
  await page.getByTestId('settings-nav-sessions').click()
  const section = page.locator('#sessions')
  await expect(section).toBeVisible()
  return section
}

/**
 * Serialise the spec FILES that write the fixture's one user file.
 *
 * `fullyParallel` puts every spec file in its own worker, and the popover
 * spec files all flip keys in the same `HOME/.claude/settings.json`. Run together, one file's toggle lands
 * mid-assertion in another (seen: alwaysThinkingEnabled read back false right
 * after a fresh open). The lock is a directory inside the fixture HOME, taken
 * in `beforeAll` and released in `afterAll`, so these files queue behind each
 * other while every other spec keeps running in parallel. A holder whose worker
 * process is gone (a crash, a killed run) is reclaimed instead of waited on.
 */
export async function lockUserSettingsFile(home: string, timeoutMs = 240_000): Promise<() => Promise<void>> {
  const dir = path.join(home, '.engine-settings-spec.lock')
  const pidFile = path.join(dir, 'pid')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fs.mkdir(dir)
      await fs.writeFile(pidFile, String(process.pid))
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const holder = Number(await fs.readFile(pidFile, 'utf-8').catch(() => '0'))
      if (holder > 0 && holder !== process.pid && !processAlive(holder)) {
        await fs.rm(dir, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline) throw new Error(`engine settings spec lock held by pid ${holder} for over ${timeoutMs}ms: ${dir}`)
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  return async () => { await fs.rm(dir, { recursive: true, force: true }) }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
