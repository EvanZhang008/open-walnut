import fs from 'node:fs'
import path from 'node:path'
import type { ProviderSpec } from '../provider-spec.js'
import { resolveSystemCodexPath } from '../../../../src/providers/acp-session.js'

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../../../..')

export const codexSpec: ProviderSpec = {
  engine: 'codex',
  label: 'Codex (ACP)',
  gateEnv: 'WALNUT_LIVE_CODEX',
  unavailableReason: () => {
    if (!resolveSystemCodexPath()) return 'no system codex binary found'
    if (!fs.existsSync(path.join(REPO_ROOT, 'dist/daemon-binaries/acp-worker.js'))) return 'acp-worker bundle not built'
    if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules/@agentclientprotocol/codex-acp/dist/index.js'))) return 'codex-acp adapter missing'
    return undefined
  },
  coldStartBudgetSec: 90,
  permissions: {
    canTriggerAsk: true,
    // Network egress is blocked in codex's default (agent) sandbox → one ask.
    askPrompt: 'Run this exact shell command and show its output: curl -sSI --max-time 10 https://example.com | head -2',
    autoApprove: { controlId: 'mode', value: 'agent-full-access' },
  },
  models: {
    switchable: true,
    a: 'openai.gpt-5.6-luna[medium]',
    b: 'openai.gpt-5.6-sol[low]',
  },
  raceControl: { controlId: 'mode', values: ['read-only', 'agent'], restore: 'agent' },
  crashRecovery: {
    processPattern: 'acp-worker.js',
    match: 'journal-fd',
  },
  // codex-acp ≥1.2 `_session/steering` → codex `turn/steer`.
  steering: true,
}
