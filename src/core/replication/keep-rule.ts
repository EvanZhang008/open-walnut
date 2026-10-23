/**
 * What a replica's notes copy leaves out: the one rule every side applies
 * (docs/plan/walnut-control-plane.md, "What a host keeps").
 *
 * An entry of `notes_exclude` (hosts.<key>.keep, cloud_bridge.keep) names a folder
 * of the vault, or one note, with or without `.md`. Case is ignored, as the Mac's
 * disk ignores it. The Mac's rounds leave a match out of the copy (and remove it
 * from a replica that held it); every replica check reads the same rule, so a
 * note left out is never answered from a copy. The daemon's twin of `leftOut`
 * lives in providers/host-replica-core.ts (its factory may reference nothing at
 * module scope); tests/core/replication/keep-rule.test.ts keeps the two the same.
 */

/** One entry as typed, cleaned: slashes forward, no leading `./` or slashes at either end. */
export function cleanKeepEntry(raw: unknown): string {
  return String(raw ?? '').trim().split('\\').join('/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '')
}

/** The entries of a keep setting, cleaned, empty ones dropped. */
export function cleanKeepEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map(cleanKeepEntry).filter(Boolean)
}

/** Whether `rel` (a vault path: a note, a folder, a picture) is left out by one of `entries`. */
export function leftOut(rel: string, entries: readonly string[]): boolean {
  if (!entries || entries.length === 0) return false
  const k = rel.toLowerCase()
  for (const raw of entries) {
    const e = cleanKeepEntry(raw).toLowerCase()
    if (!e) continue
    // A folder (and everything under it), or the note named with `.md`.
    if (k === e || k.startsWith(`${e}/`)) return true
    // The note named without `.md`.
    if (!e.endsWith('.md') && k === `${e}.md`) return true
  }
  return false
}

/**
 * Whether a picture an embed names (`raw`, from the note at `notePath`) may be one the copy
 * leaves out, when the copy does not have it. A path is checked as written and from the
 * note's folder; a bare name may be anywhere in the vault (embeds resolve by name), so it
 * may be left out whenever anything is. False: a plain miss (a broken link), 404.
 */
export function pictureMayBeLeftOut(raw: string, notePath: string | undefined, entries: readonly string[]): boolean {
  if (!entries || entries.length === 0) return false
  const ref = cleanKeepEntry(String(raw ?? '').split('|')[0])
  if (!ref) return false
  if (!ref.includes('/')) return true
  const dir = notePath ? notePath.split('/').slice(0, -1).join('/') : ''
  const parts: string[] = []
  for (const seg of `${dir ? `${dir}/` : ''}${ref}`.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return leftOut(ref, entries) || leftOut(parts.join('/'), entries)
}
