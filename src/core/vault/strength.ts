/**
 * A typed password's strength, and the vault's security report (weak, reused, old).
 * Pure and offline: nothing here sends a password or a site anywhere.
 *
 * The estimate is a deliberately simple guess-count model (not zxcvbn): character
 * pool × length, minus what the common shapes give away (a dictionary-looking
 * word plus digits, keyboard runs, repeats, years). It errs towards "weak".
 */
import type { VaultItem } from './types.js'

export type StrengthLevel = 'very_weak' | 'weak' | 'fair' | 'strong' | 'very_strong'

export interface Strength {
  bits: number
  level: StrengthLevel
}

const COMMON = new Set([
  'password', 'passw0rd', '123456', '12345678', '123456789', 'qwerty', 'qwertyuiop', 'abc123', 'letmein', 'welcome',
  'iloveyou', 'admin', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'master', 'login',
  'starwars', 'trustno1', 'superman', 'shadow', 'michael', 'secret', 'changeme', '111111', '000000', 'hello',
])

const RUNS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

function pool(p: string): number {
  let n = 0
  if (/[a-z]/.test(p)) n += 26
  if (/[A-Z]/.test(p)) n += 26
  if (/[0-9]/.test(p)) n += 10
  if (/[^a-zA-Z0-9]/.test(p)) n += 33
  return n || 1
}

/** Characters that add little: repeats and keyboard or alphabet runs of 3+. */
function predictable(p: string): number {
  const low = p.toLowerCase()
  let cut = 0
  for (let i = 2; i < low.length; i++) {
    const a = low[i - 2], b = low[i - 1], c = low[i]
    if (a === b && b === c) { cut++; continue }
    if (RUNS.some((r) => r.includes(a + b + c) || r.includes(c + b + a))) cut++
  }
  return cut
}

export function passwordStrength(password: string): Strength {
  const p = password ?? ''
  if (!p) return { bits: 0, level: 'very_weak' }
  const core = p.toLowerCase().replace(/[^a-z]/g, '')
  if (COMMON.has(p.toLowerCase()) || COMMON.has(core)) return { bits: 8, level: 'very_weak' }
  let bits = (p.length - predictable(p)) * Math.log2(pool(p))
  // "Word + digits (+ symbol)": guessers try these first.
  if (/^[A-Za-z]{3,12}[0-9]{1,4}[^A-Za-z0-9]?$/.test(p)) bits = Math.min(bits, 30)
  // A year in it is a known shape.
  if (/(19|20)\d\d/.test(p)) bits -= 6
  bits = Math.max(0, Math.round(bits))
  const level: StrengthLevel = bits < 28 ? 'very_weak' : bits < 40 ? 'weak' : bits < 60 ? 'fair' : bits < 80 ? 'strong' : 'very_strong'
  return { bits, level }
}

export function isWeak(password: string): boolean {
  const l = passwordStrength(password).level
  return l === 'very_weak' || l === 'weak'
}

export const OLD_PASSWORD_DAYS = 365

export interface SecurityReport {
  weak: string[]
  /** Groups of item ids sharing one password. */
  reused: string[][]
  /** Not changed for OLD_PASSWORD_DAYS. */
  old: string[]
  /** A site saved as plain http://. */
  insecureUrl: string[]
}

export function securityReport(items: VaultItem[], now = Date.now()): SecurityReport {
  const live = items.filter((i) => !i.trashedAt && i.type === 'login' && i.password)
  const byPassword = new Map<string, string[]>()
  for (const i of live) byPassword.set(i.password!, [...(byPassword.get(i.password!) ?? []), i.id])
  const oldCut = now - OLD_PASSWORD_DAYS * 86_400_000
  return {
    weak: live.filter((i) => isWeak(i.password!)).map((i) => i.id),
    reused: [...byPassword.values()].filter((ids) => ids.length > 1),
    old: live.filter((i) => Date.parse(i.passwordHistory?.[0]?.replacedAt ?? i.createdAt) < oldCut).map((i) => i.id),
    insecureUrl: live.filter((i) => i.urls?.some((u) => u.startsWith('http://'))).map((i) => i.id),
  }
}
