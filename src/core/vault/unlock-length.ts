/**
 * "Keep Passwords unlocked" (docs/reference/passwords.md, "Unlocking"): how long a person's
 * unlock of one window lasts, `passwords.unlock_for` in config.yaml.
 *
 *   idle     after `auto_lock_minutes` unused (default 15), and 12 hours at most (the old rule)
 *   1h, 12h  that long from the unlock, used or not (no idle lock within it)
 *   48h      48 hours after the window last used it, renewed on every use, with no cap: the
 *            default, and what a new vault's setup writes (vault-v1.ts /vault/setup)
 *   restart  until Walnut restarts (the one choice whose windows a restart locks: session-store.ts)
 *   always   "Forever": no clock for the window, and the machine key keeps the vault
 *            reopenable with nobody at it (agents while away, setAgentsWhileAway). It is what
 *            the status reports whenever the machine key is on.
 *
 * Every choice but `restart` survives a Walnut restart (session-store.ts); a restart of the
 * computer, Lock, and a change of this choice (vault-v1.ts retimes open windows) end it.
 * A config with no choice reads 48h. A config an older Walnut wrote with only
 * `auto_lock_minutes` is that person's choice and reads `idle` with those minutes.
 * The status keeps `autoLockMinutes` a number for older clients (they lock a window after that
 * many idle minutes themselves): the idle minutes, else the choice's length in minutes.
 */
export type UnlockFor = 'idle' | '1h' | '12h' | '48h' | 'restart' | 'always'

export const UNLOCK_CHOICES: readonly UnlockFor[] = ['idle', '1h', '12h', '48h', 'restart', 'always']
/** What a config with no choice reads. */
export const DEFAULT_UNLOCK_FOR: UnlockFor = '48h'
/** What a new vault's setup writes. */
export const NEW_VAULT_UNLOCK_FOR: UnlockFor = '48h'
export const DEFAULT_IDLE_MINUTES = 15
/** The idle choice's cap, as before. */
export const IDLE_MAX_HOURS = 12

/** `choice` and `survivesRestart` ride along to sessions.ts: what a window was unlocked under, and whether a Walnut restart keeps it. */
export interface UnlockLimits { idleMs: number; maxMs: number; choice?: UnlockFor; survivesRestart?: boolean }

export interface UnlockChoice {
  unlockFor: UnlockFor
  /** Minutes unused before a window locks, or null when only the length ends it. */
  lockAfterIdleMinutes: number | null
  /** For older clients: always a number of minutes. */
  autoLockMinutes: number
  limits: UnlockLimits
}

const HOUR = 3_600_000

export function isUnlockFor(v: unknown): v is UnlockFor {
  return typeof v === 'string' && (UNLOCK_CHOICES as readonly string[]).includes(v)
}

function idleMinutes(raw: unknown): number {
  return typeof raw === 'number' && raw > 0 ? Math.max(1, Math.min(IDLE_MAX_HOURS * 60, Math.round(raw))) : DEFAULT_IDLE_MINUTES
}

/** The choice in effect, from config and whether the machine key is on. */
export function unlockChoice(cfg: { unlock_for?: unknown; auto_lock_minutes?: unknown } | undefined, machineKeyOn: boolean): UnlockChoice {
  const oldIdle = typeof cfg?.auto_lock_minutes === 'number' && cfg.auto_lock_minutes > 0
  let unlockFor: UnlockFor = isUnlockFor(cfg?.unlock_for) ? cfg!.unlock_for as UnlockFor
    : oldIdle ? 'idle' : DEFAULT_UNLOCK_FOR
  // Forever is the machine key: on, it is the choice; picked but the key is off, the window keeps until restart.
  if (machineKeyOn) unlockFor = 'always'
  else if (unlockFor === 'always') unlockFor = 'restart'
  const idle = idleMinutes(cfg?.auto_lock_minutes)
  const tag = { choice: unlockFor, survivesRestart: unlockFor !== 'restart' }
  switch (unlockFor) {
    case 'idle': return { unlockFor, lockAfterIdleMinutes: idle, autoLockMinutes: idle, limits: { idleMs: idle * 60_000, maxMs: IDLE_MAX_HOURS * HOUR, ...tag } }
    case '1h': return fixed(unlockFor, 1)
    case '12h': return fixed(unlockFor, 12)
    // Renewed by use, so the server's idle clock ends it: no window counts its own idle time
    // (lockAfterIdleMinutes null), since one window untouched while another is used must not lock both.
    case '48h': return { unlockFor, lockAfterIdleMinutes: null, autoLockMinutes: 48 * 60, limits: { idleMs: 48 * HOUR, maxMs: Infinity, ...tag } }
    default: return { unlockFor, lockAfterIdleMinutes: null, autoLockMinutes: 48 * 60, limits: { idleMs: Infinity, maxMs: Infinity, ...tag } }
  }
}

function fixed(unlockFor: UnlockFor, hours: number): UnlockChoice {
  return { unlockFor, lockAfterIdleMinutes: null, autoLockMinutes: hours * 60, limits: { idleMs: hours * HOUR, maxMs: hours * HOUR, choice: unlockFor, survivesRestart: true } }
}

/** "until restart" and "forever" keep a window unlocked with no clock: Walnut unlocks itself at start from the keychain when it can. */
export function unlocksAtStart(choice: UnlockFor): boolean {
  return choice === 'restart' || choice === 'always'
}
