/**
 * The person's extension settings (storage.local, so they last across restarts): the auto-lock
 * timeout, copying the one-time code after a fill, and the generator's last options. Read by
 * the background and the popup; content scripts never need them.
 */
import { ext } from './ext'
import { DEFAULT_PASSWORD, DEFAULT_PASSPHRASE, type PassphraseOptions, type PasswordOptions } from '../../../src/core/vault/generator'

/** Minutes of no use before the extension locks; `browser`: only when the browser closes (or the computer locks); `never`: only when the browser closes. */
export type AutoLock = '1' | '5' | '15' | '30' | '60' | 'browser' | 'never'
export const AUTO_LOCKS: ReadonlyArray<{ value: AutoLock; label: string }> = [
  { value: '1', label: 'After 1 minute' },
  { value: '5', label: 'After 5 minutes' },
  { value: '15', label: 'After 15 minutes' },
  { value: '30', label: 'After 30 minutes' },
  { value: '60', label: 'After 1 hour' },
  { value: 'browser', label: 'When the browser closes' },
  { value: 'never', label: 'Never while the browser is open' },
]

export interface GeneratorPrefs { kind: 'random' | 'words'; random: PasswordOptions; words: PassphraseOptions }

export interface Settings {
  autoLock: AutoLock
  /** After a login with a one-time code is filled, its code goes on the clipboard (as Bitwarden does). */
  copyTotp: boolean
  generator: GeneratorPrefs
}

export const DEFAULT_SETTINGS: Settings = {
  autoLock: '15',
  copyTotp: true,
  generator: { kind: 'random', random: DEFAULT_PASSWORD, words: DEFAULT_PASSPHRASE },
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await ext.storage.local.get('settings').catch(() => ({ settings: undefined }))
  const s = (settings ?? {}) as Partial<Settings>
  const g = (s.generator ?? {}) as Partial<GeneratorPrefs>
  return {
    autoLock: AUTO_LOCKS.some((a) => a.value === s.autoLock) ? s.autoLock! : DEFAULT_SETTINGS.autoLock,
    copyTotp: typeof s.copyTotp === 'boolean' ? s.copyTotp : DEFAULT_SETTINGS.copyTotp,
    generator: {
      kind: g.kind === 'words' ? 'words' : 'random',
      random: { ...DEFAULT_PASSWORD, ...(g.random ?? {}), kind: 'random' },
      words: { ...DEFAULT_PASSPHRASE, ...(g.words ?? {}), kind: 'words' },
    },
  }
}

export async function setSettings(change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...change }
  await ext.storage.local.set({ settings: next })
  return next
}

/** Minutes for a timed auto-lock, else null. */
export const lockMinutes = (a: AutoLock): number | null => (/^\d+$/.test(a) ? Number(a) : null)
