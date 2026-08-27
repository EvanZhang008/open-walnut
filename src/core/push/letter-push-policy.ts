/**
 * "Should this letter buzz that phone?" — the whole decision, as pure functions.
 *
 * Two modes the user chose between, per device:
 *
 *  - `always` (DEFAULT): every letter pushes. The user's words: "default can be
 *    send them all now". An inbox letter is a document an agent wrote FOR them;
 *    missing one because a laptop tab happened to be open is the bug being fixed.
 *  - `when-inactive`: Slack's rule. If the app is on screen it already showed
 *    the letter, so the phone stays quiet; otherwise it buzzes.
 *
 * WHY the ACTIVE signal is per-device and self-reported, and why it EXPIRES:
 * the server cannot see whether an app is foregrounded. The old sender guessed
 * with `clientCount() > 0` — any open browser WS anywhere — which is what made
 * letters silently never reach the phone while a Mac tab sat open. A phone's
 * own foreground state is the only honest signal, so the app reports it and the
 * report is treated as a LEASE: a phone that goes background without telling us
 * (killed, crashed, tunnel died) must decay to "not active" instead of muting
 * itself forever. Silence is the dangerous failure here, so every ambiguous
 * case resolves toward sending.
 */

/** Per-device notification mode. `always` is the default everywhere. */
export type LetterPushMode = 'always' | 'when-inactive'

export const DEFAULT_LETTER_PUSH_MODE: LetterPushMode = 'always'

export function parseMode(raw: unknown): LetterPushMode {
  return raw === 'when-inactive' ? 'when-inactive' : DEFAULT_LETTER_PUSH_MODE
}

/**
 * How long an "app is in the foreground" report stays trustworthy.
 *
 * The app refreshes it while it is on screen (see `ACTIVE_REFRESH_MS` on the
 * client). This is deliberately a small multiple of that: long enough that a
 * missed refresh over a flaky connection doesn't cause a spurious buzz, short
 * enough that a phone whose app was force-quit starts receiving pushes again
 * within a minute rather than staying silently muted.
 */
export const ACTIVE_LEASE_MS = 90_000

export interface DevicePushState {
  /** Device name (the auth identity), used only for logging. */
  name?: string
  mode?: LetterPushMode
  /** Epoch ms of the device's last "I am in the foreground" report. */
  activeAt?: number
  /**
   * Letter types this device wants. Absent = all of them. A visible choice, not
   * a hidden heuristic: the user can mute chatty `info` letters without the
   * server second-guessing which letters matter.
   */
  types?: string[]
}

export function isActive(state: DevicePushState, now: number, leaseMs = ACTIVE_LEASE_MS): boolean {
  if (typeof state.activeAt !== 'number' || !Number.isFinite(state.activeAt)) return false
  const age = now - state.activeAt
  // A FUTURE timestamp (clock skew between phone and server) is not evidence of
  // being active — treating it as active would mute the device indefinitely.
  if (age < 0) return -age <= leaseMs
  return age <= leaseMs
}

export interface LetterPushDecision {
  send: boolean
  /** Why, in one token — logged, and reported by the status route. */
  reason: 'always' | 'inactive' | 'app-active' | 'type-muted'
}

/**
 * Decide for ONE device. Unknown/missing state means default mode, which sends —
 * a device that never reported anything must still get its letters.
 */
export function decideForDevice(
  state: DevicePushState,
  letterType: string,
  now: number,
  leaseMs = ACTIVE_LEASE_MS,
): LetterPushDecision {
  if (state.types && state.types.length > 0 && !state.types.includes(letterType)) {
    return { send: false, reason: 'type-muted' }
  }
  const mode = parseMode(state.mode)
  if (mode === 'always') return { send: true, reason: 'always' }
  return isActive(state, now, leaseMs)
    ? { send: false, reason: 'app-active' }
    : { send: true, reason: 'inactive' }
}

/**
 * Which of the registered devices should receive this letter.
 *
 * Returns the indices to keep, so the caller can map back to whatever token
 * shape it holds without this module knowing about config or tokens.
 */
export function selectDevices<T extends DevicePushState>(
  devices: T[],
  letterType: string,
  now: number,
  leaseMs = ACTIVE_LEASE_MS,
): Array<{ device: T; decision: LetterPushDecision }> {
  return devices
    .map((device) => ({ device, decision: decideForDevice(device, letterType, now, leaseMs) }))
    .filter((d) => d.decision.send)
}
