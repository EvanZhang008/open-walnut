import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

/**
 * `dsh --profile acp` is DeepSeek Harness's own ACP server, so the CLI on PATH
 * (or the WALNUT_DSH_PATH override) plus the acp-worker bundle is the whole
 * runtime. Model access is whatever the user's dsh profile routes; a missing
 * provider key fails the TURN (visible in the transcript), not the spawn.
 */
function probe(): string | undefined {
  const cmd = process.env.WALNUT_DSH_PATH?.trim() || 'dsh'
  try {
    execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 15_000 })
  } catch {
    return 'dsh CLI not runnable (npm i -g @deepseek-ai/dsh, or set WALNUT_DSH_PATH)'
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js'))) return 'acp-worker bundle not built'
  return undefined
}

export const dshSpec: ProviderSpec = {
  engine: 'dsh',
  label: 'DeepSeek Harness (ACP)',
  gateEnv: 'WALNUT_LIVE_DSH',
  unavailableReason: probe,
  // initialize alone takes ~5s (dsh 0.1.5 boots its plugin stack first).
  coldStartBudgetSec: 120,
  permissions: {
    canTriggerAsk: false,
  },
  models: {
    // Grouped `model` select + `reasoning_effort`; switching rides
    // `session/set_config_option`, unverified in the matrix.
    switchable: false,
  },
  raceControl: undefined,
  crashRecovery: undefined,
}
