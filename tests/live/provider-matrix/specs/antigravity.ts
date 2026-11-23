import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

/** The agy the matrix runs: WALNUT_ANTIGRAVITY_PATH, else the installer's ~/.local/bin/agy, else PATH. */
function agyCommand(): string {
  const override = process.env.WALNUT_ANTIGRAVITY_PATH?.trim()
  if (override) return override
  const installed = path.join(os.homedir(), '.local', 'bin', 'agy')
  return fs.existsSync(installed) ? installed : 'agy'
}

/**
 * `agy acp` is Antigravity's own ACP server, so the CLI plus the acp-worker bundle is the
 * whole runtime. It must be signed in (a sign-in agy keeps on disk, or GEMINI_API_KEY in the
 * environment): without one, session/new answers "Authentication required" and the start fails.
 */
function probe(): string | undefined {
  try {
    execFileSync(agyCommand(), ['--version'], { stdio: 'pipe', timeout: 15_000 })
  } catch {
    return 'agy CLI not runnable (curl -fsSL https://antigravity.google/cli/install.sh | bash, or set WALNUT_ANTIGRAVITY_PATH)'
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js'))) return 'acp-worker bundle not built'
  return undefined
}

export const antigravitySpec: ProviderSpec = {
  engine: 'antigravity',
  label: 'Antigravity (ACP)',
  gateEnv: 'WALNUT_LIVE_ANTIGRAVITY',
  unavailableReason: probe,
  coldStartBudgetSec: 120,
  permissions: {
    // agy's "default" mode asks before commands; it has no full-access mode of its own
    // (Walnut's bypass answers the asks itself), so there is no autoApprove control.
    canTriggerAsk: true,
    askPrompt: 'Run this exact shell command and show its output: echo walnut-antigravity-ask',
  },
  models: {
    // Base ids through the `model` select, efforts through `thought_level`; the
    // catalog's "gemini-3.8-flash-low" reads as "gemini-3.8-flash[low]" (protocol.ts).
    switchable: true,
    a: 'gemini-3.8-flash[low]',
    b: 'gemini-3.6-flash[low]',
  },
  raceControl: { controlId: 'mode', values: ['default', 'plan'], restore: 'default' },
  crashRecovery: {
    processPattern: 'acp-worker.js',
    match: 'journal-fd',
  },
}
