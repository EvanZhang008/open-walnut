/**
 * Shared steps for the Settings → Engines specs (chromium + the WebKit pin).
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

export async function readCodexConfig(home: string): Promise<string> {
  return fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8')
}

/** Real SPA navigation: sidebar → Settings → the Engines nav item. Returns the section locator. */
export async function openEnginesSection(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  if ((await page.locator('.sidebar.collapsed').count()) > 0) {
    await page.locator('.sidebar-collapse-btn').click()
  }
  await page.locator('.sidebar-nav a[href="/settings"]').click()
  await page.locator('.settings-nav-item', { hasText: 'Engines' }).click()
  const section = page.locator('#engines')
  await expect(section).toBeVisible()
  return section
}

export const row = (section: ReturnType<Page['locator']>, key: string) =>
  section.getByTestId(`engine-setting-row-${key}`)

/** Ids carry dots ('permissions.defaultMode'); a CSS id selector needs them escaped. */
const escapeId = (s: string) => s.replace(/([.#:[\],()\s])/g, '\\$1')

export const control = (section: ReturnType<Page['locator']>, engine: string, key: string) =>
  section.locator(`#engine-setting-${engine}-${escapeId(key)}`)

/** Wait until the section shows the engine's rows loaded from disk. */
export async function waitForEngineRows(section: ReturnType<Page['locator']>, engine: 'claude' | 'codex') {
  await section.getByTestId(`engine-settings-tab-${engine}`).click()
  const first = engine === 'claude' ? 'alwaysThinkingEnabled' : 'model_reasoning_effort'
  await expect(row(section, first)).toBeVisible({ timeout: 15_000 })
}

/**
 * Serialise the spec FILES that write the fixture's one user file.
 *
 * `fullyParallel` puts every spec file in its own worker, and five files
 * (Settings page, its WebKit pin, and the three popover files) all flip keys in
 * the same `HOME/.claude/settings.json`. Run together, one file's toggle lands
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
