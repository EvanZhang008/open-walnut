/**
 * Provider spec — describes ONE coding-agent provider well enough for the
 * generic live matrix (matrix.live.test.ts) to exercise it end to end against
 * a real Walnut server with zero mocks.
 *
 * Adding a provider = adding one spec file (specs/<name>.ts) and registering
 * it in specs/index.ts. The matrix itself never mentions a concrete engine.
 *
 * Scenario coverage is capability-driven: e.g. the permission approve/deny
 * scenarios only run when `permissions.canTriggerAsk` is set, the model-switch
 * scenario only when `models.switchable` — so a provider that auto-approves
 * everything (or has a single fixed model) still passes the matrix cleanly.
 */

export interface ProviderPermissionsSpec {
  /** Provider surfaces permission requests that land in GET /api/sessions/:id
   *  pendingPermissions (Walnut's provider-neutral shape). */
  canTriggerAsk: boolean
  /** A prompt guaranteed to trigger exactly one permission ask in the
   *  provider's DEFAULT mode (e.g. a network command under codex sandbox). */
  askPrompt?: string
  /** Control id + value that make the provider stop asking (auto-approve /
   *  bypass). The matrix verifies zero pending during a multi-command turn. */
  autoApprove?: { controlId: string; value: string }
}

export interface ProviderModelsSpec {
  /** Model switching mid-session is supported via POST /:id/model. */
  switchable: boolean
  /** Two distinct model ids to round-trip between (a→b→turn→verify). */
  a?: string
  b?: string
}

export interface ProviderSpec {
  /** Engine name as accepted by POST /api/sessions/quick-start `engine`. */
  engine: string
  /** Human label for test names. */
  label: string
  /** Skip the whole suite for this provider unless this env var is '1'.
   *  Lets CI enable providers independently (real binaries / credentials). */
  gateEnv: string
  /** Extra runtime availability probe (binary on PATH, artifacts built …).
   *  Return a reason string to skip, or undefined to proceed. */
  unavailableReason?: () => string | undefined
  /** Rough cold-start budget (spawn → first trivial turn complete), seconds.
   *  The matrix polls up to 3x this before declaring a hang. */
  coldStartBudgetSec: number
  permissions: ProviderPermissionsSpec
  models: ProviderModelsSpec
  /** Provider supports MID-TURN message injection (ACP `_session/steering` /
   *  codex `turn/steer`): a message sent while a turn runs joins THAT turn
   *  instead of queueing behind it. Enables the steering scenario (M13). */
  steering?: boolean
  /** Controls (mode pills) that can be rapidly toggled for the race scenario;
   *  empty array skips it. Values must be safe to leave in ANY final state. */
  raceControl?: { controlId: string; values: [string, string]; restore: string }
  /** Whether killing the provider's OS process mid-turn is a supported
   *  recovery path (lazy resume). Claude CLI daemon sessions self-heal too,
   *  but the kill target differs — specs provide the pgrep pattern. */
  crashRecovery?: {
    /** pgrep -f pattern that matches THIS session's provider process; the
     *  matrix narrows by cwd/journal to avoid killing unrelated sessions. */
    processPattern: string
    /** How the matrix maps a session to its process: 'journal-fd' uses lsof
     *  on the ACP journal path; 'cwd' matches the process cwd. */
    match: 'journal-fd' | 'cwd'
  }
}
