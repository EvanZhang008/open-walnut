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
