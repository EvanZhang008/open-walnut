/**
 * Import notes: bring pages in from another notes app into a Walnut notes folder, and have
 * Walnut organize them. Notion is the first source (src/server/notion/); the importer, paths,
 * re-import, organize and its undo are source-agnostic (src/server/*.ts).
 */
import type { WalnutServerApi } from '@open-walnut/plugin-api/server'
import { registerOps } from './server/ops'
import { Runtime } from './server/runtime'

let active: Runtime | null = null

export async function activate(walnut: WalnutServerApi): Promise<void> {
  const runtime = new Runtime(walnut)
  await runtime.load()
  registerOps(walnut, runtime)
  active = runtime
  walnut.signal.addEventListener('abort', () => runtime.stop(), { once: true })
}

export function deactivate(): void {
  active?.stop()
  active = null
}
