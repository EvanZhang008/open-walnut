import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

/** `gemini --experimental-acp` is the adapter itself, so the CLI on PATH (or the
 *  WALNUT_GEMINI_PATH override) plus the acp-worker bundle is the whole runtime. */
function probe(): string | undefined {
  const cmd = process.env.WALNUT_GEMINI_PATH?.trim() || 'gemini'
  try {
    execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 15_000 })
  } catch {
    return 'gemini CLI not runnable (set WALNUT_GEMINI_PATH to override PATH lookup)'
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js'))) return 'acp-worker bundle not built'
  return undefined
}

export const geminiSpec: ProviderSpec = {
  engine: 'gemini',
  label: 'Gemini (ACP)',
  gateEnv: 'WALNUT_LIVE_GEMINI',
  unavailableReason: probe,
  // Gemini reports loadSession:false, so every worker respawn starts a fresh
  // provider session; cold starts dominate. 120s matches claude's budget.
  coldStartBudgetSec: 120,
  permissions: {
    // Gemini's ACP asks have not been mapped onto Walnut's pendingPermissions
    // shape yet, so the approve/deny scenarios would assert an ask that never
    // arrives. Deliberately narrow: M1-M5 + M12 are the conformance core.
    canTriggerAsk: false,
  },
  models: {
    // Model switching rides `session/set_config_option`, which gemini's adapter
    // does not advertise today.
    switchable: false,
  },
  raceControl: undefined,
  crashRecovery: undefined,
}
