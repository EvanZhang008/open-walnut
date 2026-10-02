/**
 * The update check's version order (src/core/self-update/version-compare.ts),
 * for scripts that run under plain node without a TypeScript loader. A test
 * holds the two to the same answers (tests/scripts/release-rehearsal.test.ts).
 */
const CORE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parse(input) {
  const m = CORE.exec(String(input).trim())
  if (!m) return null
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : []
  return [Number(m[1]), Number(m[2]), Number(m[3]), pre]
}

function compareIds(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** Negative when `a` is older, 0 when equal, positive when newer; null when either does not parse. */
export function compareVersions(a, b) {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  const [xa, xb] = [pa[3], pb[3]]
  if (!xa.length && !xb.length) return 0
  if (!xa.length) return 1
  if (!xb.length) return -1
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (i >= xa.length) return -1
    if (i >= xb.length) return 1
    const c = compareIds(xa[i], xb[i])
    if (c !== 0) return c
  }
  return 0
}
