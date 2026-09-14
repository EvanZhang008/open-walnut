/**
 * Shared boot + page helpers for the Settings, Plugins update-status specs. Starts the
 * browser fixture server (`test-server.ts`) with the native plugin fixture on, which also
 * builds the linked checkout pair (`linked-work` tracking `linked-origin.git`, plus the
 * `linked-publisher` clone) and the git-source repo under the fixture home.
 */
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'

const execFileAsync = promisify(execFile)

export interface PluginFixture {
  port: number
  home: string
  stop(): Promise<void>
}

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

export async function startPluginFixture(): Promise<PluginFixture> {
  const port = await reservePort()
  let output = ''
  const child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/test-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_TEST_PORT: String(port), PW_NATIVE_PLUGIN_FIXTURE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`fixture exited early (${child.exitCode})\n${output.slice(-12_000)}`)
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/dashboard`)).ok) break
    } catch { /* still booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (Date.now() >= deadline) throw new Error(`Timed out waiting for the fixture\n${output.slice(-12_000)}`)
  const { walnutHome: home } = await discoverBrowserFixture(port)
  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
    if (!graceful) { child.kill('SIGKILL'); await exited }
  }
  return { port, home, stop }
}

export async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 30_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** Settings, Plugins, through real clicks (never a goto to the section). */
export async function openPlugins(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}

/** The fixture git source, installed through the UI unless already present. */
export async function ensureSourceInstalled(page: Page, home: string): Promise<void> {
  // The Sources group renders with the registry: wait for rows before deciding it is absent.
  await expect(page.locator('[data-testid^="plugin-row-"]').first()).toBeVisible({ timeout: 30_000 })
  if (await page.getByTestId('plugin-source-native-plugin-repo').count()) return
  const store = page.locator('#plugin-store')
  await store.locator('#plugin-source-url').fill(pathToFileURL(path.join(home, 'native-plugin-repo')).href)
  await store.getByTestId('plugin-trust-confirm').check()
  await store.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByTestId('plugin-source-native-plugin-repo')).toBeVisible({ timeout: 30_000 })
}

/** git in a repo the fixture created under the OS temp dir; identity pinned, never the user's. */
export function git(cwd: string, ...args: string[]) {
  return execFileAsync('git', ['-c', 'user.name=Walnut Test', '-c', 'user.email=walnut-test@example.invalid', ...args], { cwd })
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, 'add', '-A')
  await git(cwd, 'commit', '-m', message)
}

/** Same helper as mail-app-design.spec.ts, landing back on the Plugins section. */
export async function pickTheme(page: Page, label: 'Light' | 'Dark'): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  const option = page.locator('.theme-picker-btn', { hasText: label }).first()
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', label.toLowerCase(), { timeout: 15_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-store-installed')).toBeVisible({ timeout: 30_000 })
}
