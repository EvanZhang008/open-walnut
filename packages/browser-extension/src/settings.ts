/**
 * The person's extension settings (storage.local, so they last across restarts): the auto-lock
 * timeout, filling and saving on web pages, copying the one-time code after a fill, the look of an
 * agent's cursor in a page, and the generator's last options. Read by the background and the popup; the page script learns
 * `pageFill` from the background and follows its changes (content.ts).
 */
import { ext } from './ext'
import { DEFAULT_CURSOR_STYLE, isCursorStyle, type CursorStyle } from './cursor-looks'
import { DEFAULT_PASSWORD, DEFAULT_PASSPHRASE, type PassphraseOptions, type PasswordOptions } from '../../../src/core/vault/generator'

/**
 * `walnut` (the default): as long as Walnut keeps Passwords unlocked (its "Keep Passwords
 * unlocked", 48 hours after the last use by default), across browser restarts. Otherwise minutes
 * of no use before the extension locks; `browser`: only when the browser closes (or the computer
 * locks); `never`: only when the browser closes. Every choice but `walnut` locks at browser start.
 */
export type AutoLock = 'walnut' | '1' | '5' | '15' | '30' | '60' | 'browser' | 'never'
export const AUTO_LOCKS: ReadonlyArray<{ value: AutoLock; label: string }> = [
  { value: 'walnut', label: "Walnut's setting" },
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
  /** The person picked `autoLock` here (an older extension saved its default 15 minutes with every setting). */
  autoLockChosen?: boolean
  /**
   * Walnut's own page help: the field icon, the menu that opens in a field, and the save and
   * update bars. Off while another password manager fills this browser; the popup, the context
   * menu and the shortcut still fill on request, and agents are unaffected.
   */
  pageFill: boolean
  /** After a login with a one-time code is filled, its code goes on the clipboard (as Bitwarden does). */
  copyTotp: boolean
  /** How an agent's cursor looks in a page (cursor-looks.ts); page-cursor.ts reads it from storage itself. */
  cursorStyle: CursorStyle
  generator: GeneratorPrefs
}

export const DEFAULT_SETTINGS: Settings = {
  autoLock: 'walnut',
  pageFill: true,
  copyTotp: true,
  cursorStyle: DEFAULT_CURSOR_STYLE,
  generator: { kind: 'random', random: DEFAULT_PASSWORD, words: DEFAULT_PASSPHRASE },
}

export async function getSettings(): Promise<Settings> {
  const { settings } = await ext.storage.local.get('settings').catch(() => ({ settings: undefined }))
  const s = (settings ?? {}) as Partial<Settings>
  const g = (s.generator ?? {}) as Partial<GeneratorPrefs>
  return {
    // An older extension wrote its default (15) whenever any setting changed: only a pick here keeps 15.
    autoLock: s.autoLock === '15' && s.autoLockChosen !== true ? DEFAULT_SETTINGS.autoLock
      : AUTO_LOCKS.some((a) => a.value === s.autoLock) ? s.autoLock! : DEFAULT_SETTINGS.autoLock,
    ...(s.autoLockChosen === true ? { autoLockChosen: true } : {}),
    pageFill: typeof s.pageFill === 'boolean' ? s.pageFill : DEFAULT_SETTINGS.pageFill,
    copyTotp: typeof s.copyTotp === 'boolean' ? s.copyTotp : DEFAULT_SETTINGS.copyTotp,
    cursorStyle: isCursorStyle(s.cursorStyle) ? s.cursorStyle : DEFAULT_SETTINGS.cursorStyle,
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

/** Whether Walnut fills and saves on web pages by itself (the field icon, its menu, the save bar). */
export const pageFillOn = async (): Promise<boolean> => (await getSettings()).pageFill
