/**
 * A spec file's own plugin fixture server (plugin-mic-server.ts), started once per worker in
 * beforeAll and stopped in afterAll. `fixture` is its PW_PLUGIN_FIXTURE mode ('session-pane',
 * 'drawing', ...). The shared :3457 fixture installs no plugins by design, so a spec that needs
 * a real plugin runs against this one: never :3456, never the developer's data.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import { test } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { returningVisitorStorage } from './pw-storage'

export interface PluginFixture {
  /** The fixture's origin, `http://127.0.0.1:<port>` (valid once beforeAll ran). */
  base(): string
  /** Its throwaway data home. */
  home(): string
}

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

export function usePluginFixture(fixture: string): PluginFixture {
  let port = 0
  let home = ''
  let child: ChildProcessWithoutNullStreams | null = null

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    port = await reservePort()
    let output = ''
    child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-mic-server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PW_PLUGIN_MIC_PORT: String(port), PW_PLUGIN_FIXTURE: fixture },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
    child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
    home = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`The ${fixture} plugin fixture did not start\n${output.slice(-8000)}`)), 180_000)
      const timer = setInterval(() => {
        const ready = /PLUGIN_MIC_READY (\{.*\})/.exec(output)
        if (ready) { clearInterval(timer); clearTimeout(deadline); resolve((JSON.parse(ready[1]!) as { home: string }).home) }
        else if (child?.exitCode !== null) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`The ${fixture} plugin fixture exited\n${output.slice(-8000)}`)) }
      }, 200)
    })
  })

  test.afterAll(async () => {
    if (!child || child.exitCode !== null) return
    const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
    if (!graceful) child.kill('SIGKILL')
  })

  return { base: () => `http://127.0.0.1:${port}`, home: () => home }
}

/**
 * The Drawing plugin fixture (PW_PLUGIN_FIXTURE=drawing) as the page's own server: relative
 * URLs (`page.goto('/')`, `page.request`) reach it, and its pages start as the shared fixture's
 * do (a returning visitor, the task panel By project; playwright.config.ts storageState).
 */
export function useDrawingFixture(): PluginFixture {
  const fixture = usePluginFixture('drawing')
  test.use({
    baseURL: async ({}, use) => { await use(fixture.base()) },
    storageState: async ({}, use) => {
      await use(returningVisitorStorage(fixture.base(), [{ name: 'walnut-todo-panel-design', value: 'project' }]))
    },
  })
  return fixture
}
