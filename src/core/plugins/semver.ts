interface SemVer {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

function parseVersion(input: string): SemVer | null {
  const match = input.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber)
  if (leftNumber !== null) return -1
  if (rightNumber !== null) return 1
  return left.localeCompare(right)
}

function compare(left: SemVer, right: SemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key])
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    if (left.prerelease[index] === undefined) return -1
    if (right.prerelease[index] === undefined) return 1
    const result = compareIdentifiers(left.prerelease[index], right.prerelease[index])
    if (result !== 0) return result
  }
  return 0
}

// Token grammars, named so the range VALIDATOR and the range TEST agree by
// construction. A second copy of these patterns would drift, and `isValidRange`
// saying yes to something `satisfiesSemVer` cannot evaluate is the one failure
// mode that would matter (a dependency silently unsatisfiable).
const ANY_TOKEN = /^x$/i
const WILDCARD_TOKEN = /^v?(\d+|x|\*)?(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i
const COMPARATOR_TOKEN = /^(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/
const PARTIAL_VERSION = /^(v?\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/
const HYPHEN_RANGE = /^(v?\d+\.\d+\.\d+)\s+-\s+(v?\d+\.\d+\.\d+)$/

function testComparator(version: SemVer, raw: string): boolean {
  const token = raw.trim()
  if (!token || token === '*' || ANY_TOKEN.test(token)) return true

  const wildcard = token.match(WILDCARD_TOKEN)
  if (wildcard && /[x*]/i.test(token)) {
    const [, major, minor, patch] = wildcard
    if (major && !/[x*]/i.test(major) && version.major !== Number(major)) return false
    if (minor && !/[x*]/i.test(minor) && version.minor !== Number(minor)) return false
    if (patch && !/[x*]/i.test(patch) && version.patch !== Number(patch)) return false
    return true
  }

  const match = token.match(COMPARATOR_TOKEN)
  if (!match) return false
  const operator = match[1] ?? '='
  const partial = match[2].match(PARTIAL_VERSION)
  if (!partial) return false
  if (!match[1] && partial[2] === undefined) return version.major === Number(partial[1].replace(/^v/, ''))
  if (!match[1] && partial[3] === undefined) {
    return version.major === Number(partial[1].replace(/^v/, '')) && version.minor === Number(partial[2])
  }
  const target = parseVersion(`${partial[1]}.${partial[2] ?? '0'}.${partial[3] ?? '0'}${partial[4] ?? ''}`)
  if (!target) return false
  const result = compare(version, target)

  if (operator === '>=') return result >= 0
  if (operator === '<=') return result <= 0
  if (operator === '>') return result > 0
  if (operator === '<') return result < 0
  if (operator === '=') return result === 0
  if (operator === '~') {
    return result >= 0 && version.major === target.major && version.minor === target.minor
  }
  const upper = target.major > 0
    ? { ...target, major: target.major + 1, minor: 0, patch: 0, prerelease: [] }
    : target.minor > 0
      ? { ...target, minor: target.minor + 1, patch: 0, prerelease: [] }
      : { ...target, patch: target.patch + 1, prerelease: [] }
  return result >= 0 && compare(version, upper) < 0
}

export function satisfiesSemVer(versionInput: string, rangeInput: string): boolean {
  const version = parseVersion(versionInput)
  if (!version) return false
  const alternatives = rangeInput.split('||').map((part) => part.trim()).filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.some((alternative) => {
    const hyphen = alternative.match(HYPHEN_RANGE)
    if (hyphen) {
      return testComparator(version, `>=${hyphen[1]}`) && testComparator(version, `<=${hyphen[2]}`)
    }
    return alternative.split(/\s+/).every((token) => testComparator(version, token))
  })
}

/**
 * Is this a complete x.y.z version, the only thing a range can be matched against?
 *
 * `1.0` and `dev` are not: every range fails against them, which reads as "the range is
 * wrong" when the fix belongs in the version.
 */
export function isFullVersion(version: string): boolean {
  return typeof version === 'string' && parseVersion(version) !== null
}

function isValidToken(raw: string): boolean {
  const token = raw.trim()
  if (!token || token === '*' || ANY_TOKEN.test(token)) return true
  if (WILDCARD_TOKEN.test(token) && /[x*]/i.test(token)) return true
  const match = token.match(COMPARATOR_TOKEN)
  return !!match && PARTIAL_VERSION.test(match[2])
}

/**
 * Can `satisfiesSemVer` actually evaluate this range?
 *
 * A malformed range makes every version fail, which reads to a plugin author as "my
 * dependency is broken" instead of "I typed the range wrong". Manifest validation uses
 * this to drop the entry and say so at load time.
 */
export function isValidRange(rangeInput: string): boolean {
  if (typeof rangeInput !== 'string') return false
  const alternatives = rangeInput.split('||').map((part) => part.trim()).filter(Boolean)
  if (alternatives.length === 0) return false
  return alternatives.every((alternative) =>
    HYPHEN_RANGE.test(alternative) || alternative.split(/\s+/).every(isValidToken))
}

/**
 * Range test for an inter-plugin DEPENDENCY, where a prerelease must be asked for.
 *
 * `^1.0.0` must not adopt `2.0.0-beta.1`: the plain comparator says 2.0.0-beta.1 < 2.0.0
 * so it falls inside `^1`, which is exactly the trap this exists to close. The rule: a
 * prerelease version satisfies a range only when the range itself names a prerelease of
 * the SAME x.y.z, so depending on `>=2.0.0-beta.1` is an explicit opt-in and no ordinary
 * range can drift onto an unfinished build.
 *
 * Deliberately NOT applied to `engines.walnut` (see satisfiesSemVer's callers): a Walnut
 * beta should keep running the plugins the release before it ran.
 */
export function satisfiesDependencyRange(versionInput: string, rangeInput: string): boolean {
  const version = parseVersion(versionInput)
  if (!version) return false
  if (version.prerelease.length > 0) {
    const named = [...rangeInput.matchAll(/\d+\.\d+\.\d+-[0-9A-Za-z.-]+/g)].some((match) => {
      const target = parseVersion(match[0])
      return !!target
        && target.major === version.major
        && target.minor === version.minor
        && target.patch === version.patch
    })
    if (!named) return false
  }
  return satisfiesSemVer(versionInput, rangeInput)
}
