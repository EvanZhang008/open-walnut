/** How "Keep Passwords unlocked" reads to the person (src/core/vault/unlock-length.ts). */
import type { UnlockFor, VaultStatus } from '@/api/vault'

export const UNLOCK_OPTIONS: Array<{ value: UnlockFor; label: string }> = [
  { value: 'idle', label: '15 min idle' },
  { value: '1h', label: '1 hour' },
  { value: '12h', label: '12 hours' },
  { value: '48h', label: '48 hours' },
  { value: 'restart', label: 'Until restart' },
  { value: 'always', label: 'Forever' },
]

export const GRANT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Once' },
  { value: 3_600_000, label: '1 hour' },
  { value: 43_200_000, label: '12 hours' },
  { value: 172_800_000, label: '48 hours' },
  { value: -1, label: 'Forever' },
]

/** One line for the lock screen: how long an unlock lasts here. */
export function unlockFootText(status: Pick<VaultStatus, 'unlockFor' | 'lockAfterIdleMinutes' | 'autoLockMinutes'>): string {
  switch (status.unlockFor) {
    case undefined: return `Locks again after ${status.autoLockMinutes} minutes unused.`
    case 'idle': return `Locks again after ${status.lockAfterIdleMinutes ?? status.autoLockMinutes} minutes unused.`
    case '1h': return 'Stays unlocked for 1 hour.'
    case '12h': return 'Stays unlocked for 12 hours.'
    case '48h': return 'Stays unlocked for 48 hours after you last use it, until you lock it or restart the Mac.'
    case 'restart': return 'Stays unlocked until Walnut restarts.'
    default: return 'Stays unlocked; agents can use it while you are away.'
  }
}

/** The idle choice shows its own minutes when they are not 15 (a value an older Settings saved). */
export function unlockOptionLabel(o: { value: UnlockFor; label: string }, idleMinutes: number | null | undefined): string {
  return o.value === 'idle' && idleMinutes && idleMinutes !== 15 ? `${idleMinutes} min idle` : o.label
}
