import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

function probe(): string | undefined {
  try {
    execFileSync(process.env.WALNUT_PI_PATH?.trim() || 'pi', ['--version'], { stdio: 'pipe', timeout: 15_000 })
  } catch {
    return 'Pi CLI not runnable (npm i -g @earendil-works/pi-coding-agent, or set WALNUT_PI_PATH)'
  }
  for (const name of ['acp-worker.js', 'pi-acp.js']) {
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries', name))) return `${name} bundle not built`
  }
  return undefined
}

export const piSpec: ProviderSpec = {
  engine: 'pi',
  label: 'Pi (bundled ACP adapter)',
  gateEnv: 'WALNUT_LIVE_PI',
  unavailableReason: probe,
  coldStartBudgetSec: 120,
  permissions: { canTriggerAsk: false },
  models: { switchable: false },
  raceControl: undefined,
  crashRecovery: undefined,
}
