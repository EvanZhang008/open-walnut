/**
 * "Keep Passwords unlocked" (docs/reference/passwords.md, "Unlocking"): how long a person's
 * unlock of one window lasts, `passwords.unlock_for` in config.yaml.
 *
 *   idle     after `auto_lock_minutes` unused (default 15), and 12 hours at most (the old rule)
 *   1h, 12h, 48h  that long from the unlock, used or not (no idle lock within it); a new vault's
 *            setup writes 48h (vault-v1.ts /vault/setup)
 *   restart  until Walnut restarts
 *   always   "Forever": until restart for the window, and the machine key keeps the vault
 *            reopenable with nobody at it (agents while away, setAgentsWhileAway). It is what
 *            the status reports whenever the machine key is on.
 *
 * A config with no choice at all reads `idle` (15 minutes): an install that had a vault before
 * this choice existed keeps its old lock, and only a new vault's setup writes 48h. A config an
 * older Walnut wrote with only `auto_lock_minutes` reads `idle` with those minutes.
 * The status keeps `autoLockMinutes` a number for older clients (they lock a window after that
 * many idle minutes themselves): the idle minutes, else the choice's length in minutes.
 */
export type UnlockFor = 'idle' | '1h' | '12h' | '48h' | 'restart' | 'always'

export const UNLOCK_CHOICES: readonly UnlockFor[] = ['idle', '1h', '12h', '48h', 'restart', 'always']
/** What a config with no choice reads: the old idle lock. */
export const DEFAULT_UNLOCK_FOR: UnlockFor = 'idle'
/** What a new vault's setup writes. */
export const NEW_VAULT_UNLOCK_FOR: UnlockFor = '48h'
export const DEFAULT_IDLE_MINUTES = 15
/** The idle choice's cap, as before. */
export const IDLE_MAX_HOURS = 12

export interface UnlockLimits { idleMs: number; maxMs: number }

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
  let unlockFor: UnlockFor = isUnlockFor(cfg?.unlock_for) ? cfg!.unlock_for as UnlockFor
    : DEFAULT_UNLOCK_FOR
  // Forever is the machine key: on, it is the choice; picked but the key is off, the window keeps until restart.
  if (machineKeyOn) unlockFor = 'always'
  else if (unlockFor === 'always') unlockFor = 'restart'
  const idle = idleMinutes(cfg?.auto_lock_minutes)
  switch (unlockFor) {
    case 'idle': return { unlockFor, lockAfterIdleMinutes: idle, autoLockMinutes: idle, limits: { idleMs: idle * 60_000, maxMs: IDLE_MAX_HOURS * HOUR } }
    case '1h': return fixed(unlockFor, 1)
    case '12h': return fixed(unlockFor, 12)
    case '48h': return fixed(unlockFor, 48)
    default: return { unlockFor, lockAfterIdleMinutes: null, autoLockMinutes: 48 * 60, limits: { idleMs: Infinity, maxMs: Infinity } }
  }
}

function fixed(unlockFor: UnlockFor, hours: number): UnlockChoice {
  return { unlockFor, lockAfterIdleMinutes: null, autoLockMinutes: hours * 60, limits: { idleMs: hours * HOUR, maxMs: hours * HOUR } }
}

/** "until restart" and "forever" keep a window unlocked with no clock: Walnut unlocks itself at start from the keychain when it can. */
export function unlocksAtStart(choice: UnlockFor): boolean {
  return choice === 'restart' || choice === 'always'
}
