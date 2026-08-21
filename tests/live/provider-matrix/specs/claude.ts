import { execFileSync } from 'node:child_process'
import type { ProviderSpec } from '../provider-spec.js'

function hasClaudeCli(): boolean {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

export const claudeSpec: ProviderSpec = {
  engine: 'claude',
  label: 'Claude Code (native)',
  gateEnv: 'WALNUT_LIVE_CLAUDE',
  unavailableReason: () => (hasClaudeCli() ? undefined : 'claude CLI not on PATH'),
  coldStartBudgetSec: 120,
  permissions: {
    // Native sessions default to mode=default which does surface permission
    // asks, but the ask shape rides the control protocol, not pendingPermissions
    // — approve/deny scenarios need the control-request path. Until the matrix
    // grows that adapter, permission scenarios are skipped for claude.
    canTriggerAsk: false,
  },
  models: {
    switchable: true,
    a: 'sonnet',
    b: 'opus',
  },
  // mode is a session-record PATCH for claude, not a /controls option; the
  // race scenario would test a different (trivial) code path — skip.
  raceControl: undefined,
  crashRecovery: {
    // The CLI process is daemon-owned; killing it tests FIFO-death → --resume.
    processPattern: 'claude -p',
    match: 'cwd',
  },
}
