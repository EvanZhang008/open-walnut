/**
 * Settings, Plugins: the MCP servers a plugin runs, as rows under that plugin (PluginMcpControls).
 * The fixture plugin `acme-tools` (test-server.ts) registers a real stdio MCP server and one whose
 * command does not exist. Pinned, in both engines:
 *
 *   - a registered server reads "Not running" and nothing has started it;
 *   - Start runs it and the row says how many tools it has and what sessions may call;
 *   - the process dying on its own turns the row Failed LIVE (no reload), with its own last words;
 *   - Start from Failed brings it back without waiting out the retry cooldown;
 *   - a server that cannot start says why, and keeps offering Start;
 *   - the rows survive a reload (one fetch, then events).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openPlugins, startPluginFixture, type PluginFixture } from './plugin-update-fixture'

const SHOT_DIR = '/tmp/plugin-mcp-servers'
let fixture: PluginFixture

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  fixture = await startPluginFixture()
})
test.afterAll(async () => { await fixture?.stop() })

const base = () => `http://127.0.0.1:${fixture.port}`

async function startEvents(): Promise<number> {
  try {
    const text = await fs.readFile(path.join(fixture.home, 'acme-tools-mcp.jsonl'), 'utf-8')
    return text.split('\n').filter((line) => line.includes('"kind":"start"')).length
  } catch {
    return 0
  }
}

async function serverState(name: string): Promise<string | undefined> {
  const body = await (await fetch(`${base()}/api/mcp/servers`)).json() as { servers: Array<{ name: string; state: string }> }
  return body.servers.find((one) => one.name === name)?.state
}

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base()}/`)
  await openPlugins(page)
  await expect(page.getByTestId('plugin-row-acme-tools')).toBeVisible({ timeout: 30_000 })
  // The server rows sit under the plugin's row (siblings of its line, not inside it).
  const block = page.getByTestId('plugin-mcp-acme-tools')
  await expect(block).toBeVisible({ timeout: 30_000 })
  return { block, errors }
}

test('a plugin\'s MCP servers: state, Start, a live crash, recovery, a server that cannot start', async ({ page }, info) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  // Each project boots its own fixture, so the server starts out registered and never run.
  expect(await serverState('acme-tools')).toBe('idle')
  const { block, errors } = await open(page)
  const tools = block.getByTestId('plugin-mcp-row-acme-tools')
  const broken = block.getByTestId('plugin-mcp-row-acme-tools-broken')
  const engine = info.project.name

  // Registered, lazy: nothing started it just because Settings looked.
  await expect(tools).toHaveAttribute('data-state', 'idle')
  await expect(tools).toContainText('MCP server: Acme Tools')
  await expect(tools).toContainText('Not running')
  await expect(block.getByTestId('plugin-mcp-help-acme-tools')).toHaveText('Starts when something uses it. Sessions can use its read-only tools.')
  await expect(broken).toContainText('MCP server: Acme Tools (broken)')
  await expect(block.getByTestId('plugin-mcp-help-acme-tools-broken')).toHaveText('Starts when something uses it. Only its plugin uses it.')
  await tools.screenshot({ path: path.join(SHOT_DIR, `idle-${engine}.png`) })
  expect(await startEvents()).toBe(0)

  // Start: the row follows the server to Running with its tool count.
  const startButton = block.getByTestId('plugin-mcp-restart-acme-tools')
  await expect(startButton).toHaveText('Start')
  await startButton.click()
  await expect(tools).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await expect(tools).toContainText('Running')
  await expect(block.getByTestId('plugin-mcp-help-acme-tools')).toHaveText('9 tools. Sessions can use its read-only tools.')
  await expect(startButton).toHaveText('Restart')
  await tools.screenshot({ path: path.join(SHOT_DIR, `ready-${engine}.png`) })

  // The process dies on its own (a read-only tool that exits mid-call): the row turns Failed
  // without a reload, in the server's own words.
  const drop = await fetch(`${base()}/api/mcp/servers/acme-tools/read`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: 'drop' }),
  })
  expect(drop.status).toBe(503)
  await expect(tools).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(tools).toContainText('Failed')
  await expect(block.getByTestId('plugin-mcp-help-acme-tools')).toContainText('stopped unexpectedly. It said: fake-mcp: dropping on purpose')
  await expect(startButton).toHaveText('Start')
  await block.screenshot({ path: path.join(SHOT_DIR, `failed-${engine}.png`) })

  // Start from Failed: back to Running at once (no cooldown wait for a person who asked).
  await startButton.click()
  await expect(tools).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })

  // The broken one says why, and still offers Start.
  const brokenButton = block.getByTestId('plugin-mcp-restart-acme-tools-broken')
  await brokenButton.click()
  await expect(broken).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
  await expect(block.getByTestId('plugin-mcp-help-acme-tools-broken')).toContainText('could not start: its command was not found')
  await expect(brokenButton).toHaveText('Start')
  await expect(brokenButton).toBeEnabled()

  // A reload shows the same rows from one fetch.
  // The reload lands back on Settings, Plugins (the section is in the URL).
  await page.reload()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('plugin-mcp-row-acme-tools')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })
  await expect(page.getByTestId('plugin-mcp-row-acme-tools-broken')).toHaveAttribute('data-state', 'failed')
  await page.getByTestId('plugin-mcp-acme-tools').screenshot({ path: path.join(SHOT_DIR, `after-reload-${engine}.png`) })

  expect(errors).toEqual([])
})
