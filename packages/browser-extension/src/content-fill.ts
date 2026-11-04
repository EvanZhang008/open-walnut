/**
 * Fills, only into this frame's own forms: a login, a one-time code (one field, or one box per
 * character), a new password into every new-password field, a card or an address.
 */
import { setValue, type LoginGroup } from './form-detect'
import { fillNote, fillWallet, type WalletGroup, type WalletPart } from './wallet-detect'
import { cs } from './content-state'

export function fillLogin(username: string | undefined, password: string | undefined): boolean {
  const a = cs.active
  const g: LoginGroup | undefined = a?.group && a.group.root.isConnected
    ? (cs.groups.find((x) => x.root === a.group!.root) ?? a.group)
    : cs.groups.find((x) => x.kind === 'login') ?? cs.groups.find((x) => x.kind === 'username-step')
  if (!g) return false
  let did = false
  if (username && g.username) { setValue(g.username, username); did = true }
  if (password && g.password) { setValue(g.password, password); cs.typed.delete(g.password); did = true }
  if (did) (g.password ?? g.username)?.focus()
  return did
}

export function fillCode(code: string): boolean {
  const a = cs.active
  const g = (a?.role === 'totp' && a.group) || cs.groups.find((x) => x.totp)
  if (!g?.totp || !code) return false
  if (g.totpBoxes?.length) {
    // One character per box, in order; the last box keeps the focus, as typing would leave it.
    const chars = [...code]
    g.totpBoxes.forEach((box, i) => { if (chars[i] !== undefined) setValue(box, chars[i]) })
    g.totpBoxes[Math.min(chars.length, g.totpBoxes.length) - 1]?.focus()
    return true
  }
  setValue(g.totp, code)
  return true
}

export function fillNewPassword(password: string): void {
  for (const f of cs.active?.group?.newPasswords ?? []) setValue(f, password)
}

/**
 * A card or address into the form the person is in, else (picked in the popup) the first such
 * form here. `note` says what the item had no value for, when it left fields empty.
 */
export function fillWalletForm(values: Partial<Record<WalletPart, string>>, kind: string): { filled: boolean; note: string } {
  const a = cs.active?.wallet
  const g: WalletGroup | undefined = a && a.root.isConnected && a.kind === kind ? cs.wallets.find((w) => w.root === a.root && w.kind === kind) ?? a : cs.wallets.find((w) => w.kind === kind)
  if (!g) return { filled: false, note: '' }
  const r = fillWallet(g, values)
  // Each value goes in the way typing would (focusing its field): the person ends where they were.
  const back = cs.active?.field
  if (r.filled && back?.isConnected && g.fields.some((f) => f.el === back)) back.focus({ preventScroll: true })
  return { filled: r.filled > 0, note: fillNote(g.kind, r) }
}
