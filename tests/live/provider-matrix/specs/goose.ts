import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

/** `goose acp` is the adapter itself, so the CLI on PATH (or the
 *  WALNUT_GOOSE_PATH override) plus the acp-worker bundle is the whole runtime. */
function probe(): string | undefined {
  const cmd = process.env.WALNUT_GOOSE_PATH?.trim() || 'goose'
  try {
    execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 15_000 })
  } catch {
    return 'goose CLI not runnable (set WALNUT_GOOSE_PATH to override PATH lookup)'
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js'))) return 'acp-worker bundle not built'
  return undefined
}

export const gooseSpec: ProviderSpec = {
  engine: 'goose',
  label: 'Goose (ACP)',
  gateEnv: 'WALNUT_LIVE_GOOSE',
  unavailableReason: probe,
  coldStartBudgetSec: 120,
  permissions: {
    // Goose's ACP asks are not mapped onto Walnut's pendingPermissions shape yet,
    // so approve/deny would wait on an ask that never arrives. Deliberately
    // narrow: M1-M5 + M12 are the conformance core.
    canTriggerAsk: false,
  },
  models: {
    // Model switching rides `session/set_config_option`, unverified here.
    switchable: false,
  },
  raceControl: undefined,
  crashRecovery: undefined,
}
