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

function testComparator(version: SemVer, raw: string): boolean {
  const token = raw.trim()
  if (!token || token === '*' || /^x$/i.test(token)) return true

  const wildcard = token.match(/^v?(\d+|x|\*)?(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i)
  if (wildcard && /[x*]/i.test(token)) {
    const [, major, minor, patch] = wildcard
    if (major && !/[x*]/i.test(major) && version.major !== Number(major)) return false
    if (minor && !/[x*]/i.test(minor) && version.minor !== Number(minor)) return false
    if (patch && !/[x*]/i.test(patch) && version.patch !== Number(patch)) return false
    return true
  }

  const match = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/)
  if (!match) return false
  const operator = match[1] ?? '='
  const partial = match[2].match(/^(v?\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/)
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
    const hyphen = alternative.match(/^(v?\d+\.\d+\.\d+)\s+-\s+(v?\d+\.\d+\.\d+)$/)
    if (hyphen) {
      return testComparator(version, `>=${hyphen[1]}`) && testComparator(version, `<=${hyphen[2]}`)
    }
    return alternative.split(/\s+/).every((token) => testComparator(version, token))
  })
}
