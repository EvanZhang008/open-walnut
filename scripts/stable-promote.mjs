#!/usr/bin/env node
/**
 * Automatic stable releases: once a week the Release workflow promotes the newest
 * nightly that has been out for two days to `latest` (docs/reference/releasing.md).
 *
 *   plan   decide whether there is anything to release, and as which version.
 *          Prints `key=value` lines for $GITHUB_OUTPUT and writes the notes file.
 *   roll   on a checkout of main: move the released CHANGELOG entries under the new
 *          version heading and set the version in package.json and package-lock.json.
 *   allow-scripts   the `--allow-scripts` list the updater passes, for the smoke install.
 *
 * What gets released is a commit, not "whatever main is now": the newest nightly
 * at least SOAK_HOURS old (the registry records each version's commit as gitHead).
 * It must descend from the last stable, have passed CI, and carry something a user
 * would notice: a `feat` commit makes the next minor, a `fix`/`perf` commit or a
 * hand-written CHANGELOG entry the next patch. Pre-1.0 nothing is ever a major.
 * Before publishing, the workflow installs that nightly from npm on fresh Linux and
 * macOS runners the way the updater does and requires it to serve.
 * The notes are the Unreleased section as it stood at that commit; when nobody
 * wrote one they are the feat/fix commit subjects.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitVerdict } from './ci-gate.mjs'
import { nextVersion, setManifestVersion } from './release.mjs'
import { releaseNotes } from './release-notes.mjs'

export const PACKAGE = 'open-walnut'
export const SOAK_HOURS = 48

/** The newest nightly published at least `soakHours` before `now`, with the commit it was built from. */
export function soakedNightly(packument, now, soakHours = SOAK_HOURS) {
  const cutoff = now.getTime() - soakHours * 3_600_000
  let best = null
  for (const [version, meta] of Object.entries(packument.versions ?? {})) {
    if (!/-nightly\./.test(version) || !meta?.gitHead) continue
    const at = Date.parse(packument.time?.[version] ?? '')
    if (!(at <= cutoff)) continue
    if (!best || at > best.at) best = { version, sha: meta.gitHead, at }
  }
  return best && { version: best.version, sha: best.sha, publishedAt: new Date(best.at).toISOString() }
}

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/

/** 'minor' for any feat, 'patch' for any fix/perf, null when the commits change nothing a user sees. */
export function bumpFor(subjects) {
  let bump = null
  for (const subject of subjects) {
    const type = CONVENTIONAL.exec(subject)?.[1]
    if (type === 'feat') return 'minor'
    if (type === 'fix' || type === 'perf') bump = 'patch'
  }
  return bump
}

/** Notes from the commits themselves, for a release nobody wrote CHANGELOG entries for. */
export function generatedNotes(subjects) {
  const added = []
  const fixed = []
  for (const subject of subjects) {
    const m = CONVENTIONAL.exec(subject)
    const entry = m && `- ${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}`
    if (m?.[1] === 'feat') added.push(entry)
    else if (m?.[1] === 'fix' || m?.[1] === 'perf') fixed.push(entry)
  }
  const parts = []
  if (added.length) parts.push(`### Added\n\n${added.join('\n')}`)
  if (fixed.length) parts.push(`### Fixed\n\n${fixed.join('\n')}`)
  return parts.join('\n\n')
}

/** Everything the plan needs, gathered by the caller (the CLI asks git, npm and GitHub). */
export function planRelease({ packument, now, soakHours = SOAK_HOURS, lastStableSha, isAncestor, subjectsSince, changelogAt, ciVerdict }) {
  const latest = packument['dist-tags']?.latest
  if (!latest) return { publish: false, reason: 'npm has no latest release to promote from' }
  const candidate = soakedNightly(packument, now, soakHours)
  if (!candidate) return { publish: false, reason: `no nightly has been out ${soakHours}h yet` }
  if (!lastStableSha) return { publish: false, reason: `cannot find the commit of ${latest}` }
  if (candidate.sha === lastStableSha) return { publish: false, reason: `${candidate.version} is the code ${latest} already ships` }
  if (!isAncestor(lastStableSha, candidate.sha)) return { publish: false, reason: `${candidate.sha.slice(0, 8)} does not descend from ${latest}` }
  const subjects = subjectsSince(lastStableSha, candidate.sha)
  const written = releaseNotes(changelogAt(candidate.sha), 'Unreleased')
  const bump = bumpFor(subjects) ?? (written ? 'patch' : null)
  if (!bump) return { publish: false, reason: `nothing a user would notice since ${latest} (${subjects.length} commits)` }
  const verdict = ciVerdict(candidate.sha)
  if (verdict !== 'green') return { publish: false, reason: `CI on ${candidate.sha.slice(0, 8)} is ${verdict}` }
  const notes = written ?? generatedNotes(subjects)
  return { publish: true, sha: candidate.sha, version: nextVersion(latest, bump), bump, from: latest, nightly: candidate.version, notes, written: Boolean(written) }
}

/** Top-level `- ` entries of a CHANGELOG section, keyed by their first line. */
function entryKeys(body) {
  return new Set(body.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.trim()))
}

/**
 * CHANGELOG.md on main after releasing `version`: the released entries leave
 * Unreleased (entries written after the released commit stay), subsections left
 * empty go, and `## [version] - date` holds exactly the notes that shipped.
 */
export function rollReleased(text, notes, version, date) {
  if (new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(text)) throw new Error(`CHANGELOG.md already has a ${version} section`)
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l))
  if (start < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" section')
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## ['))
  if (end < 0) end = lines.length
  const released = entryKeys(notes)
  const kept = []
  let dropping = false
  // An entry runs from its `- ` line to the next entry or heading (blank lines and
  // indented paragraphs included); blank lines always stay and are collapsed below.
  for (const line of lines.slice(start + 1, end)) {
    if (line.startsWith('- ')) dropping = released.has(line.trim())
    else if (line.startsWith('#')) dropping = false
    if (!dropping || line.trim() === '') kept.push(line)
  }
  // A subsection heading with no entry left under it goes too.
  const body = []
  for (let i = 0; i < kept.length; i++) {
    if (kept[i].startsWith('### ')) {
      let j = i + 1
      while (j < kept.length && kept[j].trim() === '') j++
      if (j >= kept.length || kept[j].startsWith('#')) { i = j - 1; continue }
    }
    body.push(kept[i])
  }
  const remaining = body.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const head = lines.slice(0, start).join('\n')
  const rest = lines.slice(end).join('\n')
  return `${head}\n## [Unreleased]\n\n${remaining ? `${remaining}\n\n` : ''}## [${version}] - ${date}\n\n${notes.trim()}\n${rest ? `\n${rest}` : ''}`
}

/** The packages whose install scripts a global install must allow: the updater's list (install-kind.ts). */
export function allowedScripts(pkg) {
  return [pkg.name, ...Object.entries(pkg.allowScripts ?? {}).filter(([, v]) => v === true).map(([k]) => k)]
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const mode = process.argv[2]
  const notesFile = arg('notes')
  if (mode === 'plan') {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`registry answered ${res.status}`)
    const packument = await res.json()
    const latest = packument['dist-tags']?.latest
    let lastStableSha = packument.versions?.[latest]?.gitHead ?? null
    if (!lastStableSha) {
      try { lastStableSha = git(root, ['rev-parse', `v${latest}^{commit}`]) } catch { lastStableSha = null }
    }
    const plan = planRelease({
      packument,
      now: arg('now') ? new Date(arg('now')) : new Date(),
      soakHours: arg('soak-hours') ? Number(arg('soak-hours')) : SOAK_HOURS,
      lastStableSha,
      isAncestor: (a, b) => { try { git(root, ['merge-base', '--is-ancestor', a, b]); return true } catch { return false } },
      subjectsSince: (a, b) => { const out = git(root, ['log', '--no-merges', '--format=%s', `${a}..${b}`]); return out ? out.split('\n') : [] },
      changelogAt: (sha) => git(root, ['show', `${sha}:CHANGELOG.md`]),
      ciVerdict: (sha) => commitVerdict(sha).verdict,
    })
    if (plan.publish && notesFile) fs.writeFileSync(notesFile, `${plan.notes}\n`)
    process.stderr.write(plan.publish
      ? `promote ${plan.nightly} (${plan.sha.slice(0, 8)}) to ${plan.version}: a ${plan.bump} after ${plan.from}, notes ${plan.written ? 'from CHANGELOG' : 'from commit subjects'}\n`
      : `nothing to release: ${plan.reason}\n`)
    process.stdout.write(`publish=${plan.publish}\n`)
    if (plan.publish) process.stdout.write(`sha=${plan.sha}\nversion=${plan.version}\nnightly=${plan.nightly}\n`)
    return
  }
  if (mode === 'roll') {
    const version = arg('version')
    if (!version || !notesFile) throw new Error('usage: stable-promote.mjs roll --version x.y.z --notes <file>')
    const date = new Date().toISOString().slice(0, 10)
    const changelog = path.join(root, 'CHANGELOG.md')
    fs.writeFileSync(changelog, rollReleased(fs.readFileSync(changelog, 'utf8'), fs.readFileSync(notesFile, 'utf8'), version, date))
    for (const file of ['package.json', 'package-lock.json']) {
      const p = path.join(root, file)
      fs.writeFileSync(p, setManifestVersion(fs.readFileSync(p, 'utf8'), version))
    }
    return
  }
  if (mode === 'allow-scripts') {
    process.stdout.write(`${allowedScripts(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))).join(',')}\n`)
    return
  }
  process.stderr.write('usage: stable-promote.mjs plan [--notes <file>] [--now <iso>] | roll --version x.y.z --notes <file> | allow-scripts\n')
  process.exit(2)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`stable-promote: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
