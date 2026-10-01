/**
 * Version ordering for the update check: `major.minor.patch[-prerelease][+build]`.
 *
 * Dependency-free on purpose (the slim CLI entry reaches this through the
 * update command). A version that does not parse never produces "newer": an
 * unknown build (`0.0.0`, a garbled registry answer) must not tell a user to
 * update, nor hide a real release.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty for a release. */
  prerelease: Array<string | number>
}

const CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(input: string): ParsedVersion | null {
  const m = CORE.exec(input.trim())
  if (!m) return null
  const prerelease = m[4]
    ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : []
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease }
}

function compareIds(a: string | number, b: string | number): number {
  // Numeric identifiers sort before alphanumeric ones, as semver prescribes.
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** Negative when `a` is older than `b`, 0 when equal, positive when newer; null when either does not parse. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1
  }
  // A release outranks any prerelease of the same core.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const n = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < n; i++) {
    if (i >= pa.prerelease.length) return -1
    if (i >= pb.prerelease.length) return 1
    const c = compareIds(pa.prerelease[i]!, pb.prerelease[i]!)
    if (c !== 0) return c
  }
  return 0
}

/** True only when both parse and `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const c = compareVersions(latest, current)
  return c !== null && c > 0
}
