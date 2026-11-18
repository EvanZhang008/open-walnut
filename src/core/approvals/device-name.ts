/**
 * The name a person reads for a device that signs or answers approvals.
 *
 * A device names itself: the Mac app sends the Mac's computer name, the iPhone app the phone's.
 * Some Macs are named by whoever set them up with a generated id (2026-11-18: the person's work
 * Mac has a name like "a1b2c3d4e5f6"), which read as an internal number on the approval card and in "approved
 * on …" (the user: "why ask me? what?"). A name like that reads as the kind of device instead.
 * keys.json and the approval records keep the name the device sent (keys.ts matches one Mac's keys
 * by it); every view a person or an agent reads goes through deviceLabel (store.ts viewOf and the
 * answer it writes, routes/approvals-v1.ts keyView). Pure.
 */

/**
 * A generated id rather than a name: eight or more hex digits, both digits and letters a-f among
 * them, in groups joined by "-" or "_" (a hardware-address name, a UUID). A date, an address or a
 * plain number has no letters, and a word has no digits, so each stays a name.
 */
export function machineMadeName(name: string): boolean {
  const t = name.trim()
  if (!/^[0-9a-f]+(?:[-_][0-9a-f]+)*$/i.test(t)) return false
  const hex = t.replace(/[-_]/g, '')
  return hex.length >= 8 && /[0-9]/.test(hex) && /[a-f]/i.test(hex)
}

const KIND_LABEL: Record<string, string> = { 'mac-app': 'Mac', iphone: 'iPhone', web: 'Web console' }

/** The device's own name, or its kind when it has none a person would recognize. */
export function deviceLabel(name: string | undefined | null, kind: string | undefined): string {
  const t = (name ?? '').replace(/\s+/g, ' ').trim()
  if (t && !machineMadeName(t)) return t
  return KIND_LABEL[kind ?? ''] ?? 'a device'
}
