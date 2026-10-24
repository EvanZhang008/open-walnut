/**
 * The automatic stable release's publishing steps (release.yml job `promote`),
 * run as written against a scratch repository: a bare origin, the job's
 * detached checkout of the released commit, the release assets job
 * `promote-build` uploads (scripts/release-files.mjs, of stand-in files), and
 * fake `npm`, `curl` and `gh` (tests/scripts/fake-gh-release.ts) on PATH. These
 * steps pack the npm packages from those assets, publish them, push a tag, draft,
 * fill and publish a GitHub Release and push a commit to main, none of which any
 * other test or CI job exercises before a real release does.
 *
 * What matters: npm gets the very bytes the build uploaded (and the binary matrix
 * ran), the tag lands on the released commit, the GitHub Release is public only
 * once it holds its files, the release commit lands on the newest main (main
 * moves between the plan and the push) and changes only the two release files, a
 * rerun of a release that stopped halfway finishes it without doing anything
 * twice, and a main that cannot be rolled fails the job instead of passing with a
 * warning.
 *
 * The origin enforces GitHub's rule for the job's token (a pre-receive hook): a
 * ref other than main may point only at a commit whose .github/workflows match
 * main's tip, and main may move only by commits that leave them alone. GitHub
 * refused the nightly tag that way on 2026-10-03, and a stable tag on a nightly
 * from a day before main's newest workflow change would be refused the same way.
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { TARGETS, assetName, builtName, writeAssets } from '../../scripts/release-files.mjs'
import { ghCalls, installFakeGh, isDraft, makeRelease, releaseAssets } from './fake-gh-release.js'

const REPO = path.resolve(__dirname, '../..')
const VERSION = '0.6.1'

interface Step { name?: string; run?: string; env?: Record<string, string> }
const workflow = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/release.yml'), 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>
}
function promoteStep(name: string): Step {
  const step = workflow.jobs.promote!.steps.find((s) => s.name === name)
  if (!step?.run) throw new Error(`release.yml job promote has no step "${name}"`)
  return step
}
const PACK = promoteStep('The npm packages, of the very files the binary matrix ran')
const PUBLISH = promoteStep('Publish it as latest (the platform packages, then open-walnut)')
/** What one complete publish sends npm: every platform package, then the launcher. */
const PACKAGES = TARGETS.length + 1
const TAG = promoteStep('Tag it and draft the GitHub Release')
const ATTACH = promoteStep('Attach its files to the GitHub Release')
const GO_PUBLIC = promoteStep('Publish the GitHub Release, now that it holds its files')
const ROLL = promoteStep('Roll CHANGELOG and package.json on main')
const RELEASE = `v${VERSION}`

/** No inherited GIT_* (a hook exports GIT_DIR, which outranks cwd) and no user git config. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Peer', GIT_AUTHOR_EMAIL: 'peer@example.test',
    GIT_COMMITTER_NAME: 'Peer', GIT_COMMITTER_EMAIL: 'peer@example.test',
    ...extra,
  }
}

let tmp: string
let origin: string
let seed: string
let job: string
let runner: string
let fakeBin: string
let state: string
let released: string
let mainBefore: string
let files: string

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv({ WALNUT_TEST_USER_PUSH: '1' }), encoding: 'utf8' }).trim()
}
const atOrigin = (...args: string[]) => gitIn(origin, ...args)

/**
 * One promote step's `run`, the way Actions runs a step with no `shell:` (bash -e,
 * no pipefail), with the job's step env.
 */
function runStep(step: Step, extra: Record<string, string> = {}, binFirst?: string): Promise<{ code: number; out: string }> {
  const values: Record<string, string> = { GH_TOKEN: 'test-token', GH_REPO: 'example/open-walnut', VERSION, SHA: released, TAG: RELEASE }
  const env: Record<string, string> = {}
  for (const key of Object.keys(step.env ?? {})) {
    if (!(key in values)) throw new Error(`step "${step.name}" reads ${key}; give the test a value for it`)
    env[key] = values[key]!
  }
  expect(step.run).not.toContain('${{')
  const PATH = [binFirst, fakeBin, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter)
  return new Promise((resolve) => {
    execFile('bash', ['--noprofile', '--norc', '-e', '-c', step.run!], {
      cwd: job,
      encoding: 'utf8',
      env: cleanEnv({ ...env, PATH, RUNNER_TEMP: runner, FAKE_STATE: state, ...extra }),
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

const log = (name: string): string[] => {
  const file = path.join(state, `${name}.log`)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

// `npm view` knows a version only when FAKE_REGISTRY_HAS=1; `npm publish` is only
// recorded, or refused the way npm refuses it when FAKE_NPM_PUBLISH names a refusal.
const FAKE_NPM = `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
fs.appendFileSync(path.join(process.env.FAKE_STATE, 'npm.log'), process.argv.slice(2).join(' ') + '\\n')
// What this run published; an installer's look (--prefer-online) sees it at once.
const sent = path.join(process.env.FAKE_STATE, 'npm-published')
if (process.argv[2] === 'view') {
  const seen = process.argv.includes('--prefer-online') && fs.existsSync(sent) && fs.readFileSync(sent, 'utf8').split('\\n').includes(process.argv[3])
  if (process.env.FAKE_REGISTRY_HAS !== '1' && !seen) { process.stderr.write('npm error 404 Not Found\\n'); process.exit(1) }
  process.stdout.write(process.argv[3].slice(process.argv[3].lastIndexOf('@') + 1) + '\\n')
  process.exit(0)
}
// The version npm answers about is the published package's own.
const version = process.argv[2] === 'publish' ? JSON.parse(fs.readFileSync(path.join(process.argv[3], 'package.json'), 'utf8')).version : ''
const refusals = {
  staged: 'npm error code E409\\nnpm error 409 Conflict - PUT https://registry.npmjs.org/open-walnut - Cannot publish over previously staged version "' + version + '".',
  published: 'npm error code E403\\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/open-walnut - You cannot publish over the previously published versions: ' + version + '.',
  newer: 'npm error code E409\\nnpm error 409 Conflict - PUT https://registry.npmjs.org/open-walnut - Cannot publish over previously staged version "' + version + '1".',
  denied: 'npm error code E403\\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/open-walnut - You do not have permission to publish "open-walnut".',
}
// A version it publishes, or already holds, is on the registry; one it refuses is not.
if (process.argv[2] === 'publish' && !['newer', 'denied'].includes(process.env.FAKE_NPM_PUBLISH)) {
  const m = JSON.parse(fs.readFileSync(path.join(process.argv[3], 'package.json'), 'utf8'))
  fs.appendFileSync(sent, m.name + '@' + m.version + '\\n')
}
if (process.argv[2] === 'publish' && refusals[process.env.FAKE_NPM_PUBLISH]) {
  process.stderr.write(refusals[process.env.FAKE_NPM_PUBLISH] + '\\n')
  process.exit(1)
}
`
// The registry knows the version only when FAKE_REGISTRY_HAS=1.
const FAKE_CURL = `#!/bin/sh
echo "$*" >> "$FAKE_STATE/curl.log"
[ "$FAKE_REGISTRY_HAS" = 1 ] && exit 0
echo "curl: (22) The requested URL returned error: 404" >&2
exit 22
`
const CHANGELOG = [
  '# Changelog', '', '## [Unreleased]', '', '### Fixed', '',
  '- **Released fix.** It shipped in this release.', '',
  '## [0.6.0] - 2026-10-01', '', '### Added', '', '- An older thing.', '',
].join('\n')
const NOTES = '### Fixed\n\n- **Released fix.** It shipped in this release.\n'

// GitHub's check for a token without the `workflows` permission, as observed:
// a new or moved ref is compared with the default branch's tip, not with its old
// value or its parent. A push made as the user (WALNUT_TEST_USER_PUSH=1) holds
// that permission.
const WORKFLOW_RULE = `#!/bin/sh
[ "$WALNUT_TEST_USER_PUSH" = 1 ] && exit 0
zero=0000000000000000000000000000000000000000
while read old new ref; do
  [ "$new" = "$zero" ] && continue
  if [ "$ref" = refs/heads/main ]; then base="$old"; else base="$(git rev-parse refs/heads/main)"; fi
  [ "$base" = "$zero" ] && continue
  if ! git diff --quiet "$base" "$(git rev-parse "$new^{commit}")" -- .github/workflows; then
    echo "refusing to allow a GitHub App to create or update workflow without workflows permission ($ref)" >&2
    exit 1
  fi
done
`

/**
 * Main moves under the step: before each matching `git push origin main`, a
 * peer pushes a commit of its own (only the first time unless RACE_ALWAYS=1).
 */
function raceBin(): string {
  const dir = path.join(tmp, 'race-bin')
  fs.mkdirSync(dir, { recursive: true })
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/bash
if [ "$*" = "push --quiet origin main" ] && { [ "$RACE_ALWAYS" = 1 ] || [ ! -f "$FAKE_STATE/raced" ]; }; then
  touch "$FAKE_STATE/raced"
  n=$(ls "$FAKE_STATE" | grep -c '^peer-' || true)
  touch "$FAKE_STATE/peer-$n"
  "${realGit}" -C "${seed}" pull -q --ff-only origin main
  echo "peer $n" > "${seed}/peer-$n.txt"
  "${realGit}" -C "${seed}" add -A
  "${realGit}" -C "${seed}" commit -q -m "fix: a peer's change $n"
  "${realGit}" -C "${seed}" push -q origin HEAD:main
fi
exec "${realGit}" "$@"
`, { mode: 0o755 })
  return dir
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-promote-steps-'))
  origin = path.join(tmp, 'origin.git')
  seed = path.join(tmp, 'seed')
  job = path.join(tmp, 'job')
  runner = path.join(tmp, 'runner')
  fakeBin = path.join(tmp, 'bin')
  state = path.join(tmp, 'state')
  for (const d of [path.join(seed, 'scripts'), runner, fakeBin, state]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(fakeBin, 'npm'), FAKE_NPM, { mode: 0o755 })
  fs.writeFileSync(path.join(fakeBin, 'curl'), FAKE_CURL, { mode: 0o755 })
  installFakeGh(fakeBin)
  // The roll step backs off between attempts; the test does not need to wait.
  fs.writeFileSync(path.join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(path.join(runner, 'notes.md'), NOTES)

  for (const f of ['stable-promote.mjs', 'release.mjs', 'ci-gate.mjs', 'release-notes.mjs', 'npm-packages.mjs', 'release-files.mjs',
    'release-unpack.sh', 'release-attach.sh', 'install.sh', 'npm-launcher/package.json', 'npm-launcher/launch.js', 'npm-launcher/fetch-platform.js', 'npm-launcher/postinstall.js']) {
    fs.mkdirSync(path.dirname(path.join(seed, 'scripts', f)), { recursive: true })
    fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(seed, 'scripts', f))
  }
  fs.writeFileSync(path.join(seed, 'package.json'), `${JSON.stringify({ name: 'open-walnut', version: '0.6.0', license: 'MIT' }, null, 2)}\n`)
  // What the launcher package carries beside its scripts.
  fs.writeFileSync(path.join(seed, 'README.md'), '# Open Walnut\n')
  fs.writeFileSync(path.join(seed, 'LICENSE'), 'MIT\n')
  // bun.lock carries no version of its own: the roll leaves it alone.
  fs.writeFileSync(path.join(seed, 'bun.lock'), '{\n  "lockfileVersion": 1,\n  "packages": {},\n}\n')
  fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), CHANGELOG)
  fs.mkdirSync(path.join(seed, '.github', 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(seed, '.github', 'workflows', 'ci.yml'), 'name: CI\n')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanEnv() })
  fs.writeFileSync(path.join(origin, 'hooks', 'pre-receive'), WORKFLOW_RULE, { mode: 0o755 })
  gitIn(seed, 'init', '-q', '-b', 'main')
  gitIn(seed, 'add', '-A')
  gitIn(seed, 'commit', '-q', '-m', 'fix: the released fix')
  gitIn(seed, 'remote', 'add', 'origin', origin)
  gitIn(seed, 'push', '-q', 'origin', 'main')
  released = gitIn(seed, 'rev-parse', 'HEAD')
  // Main moved on after the nightly that is being promoted: a newer entry waits
  // under Unreleased for the next release.
  fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), CHANGELOG.replace(
    '- **Released fix.**', '- **Later fix.** It came after the release.\n- **Released fix.**'))
  gitIn(seed, 'commit', '-q', '-am', 'fix: a later fix')
  gitIn(seed, 'push', '-q', 'origin', 'main')
  mainBefore = gitIn(seed, 'rev-parse', 'HEAD')
  // What job `promote-build` uploads and this job downloads: the assets of this
  // version, of stand-in files (one distinct body per target).
  files = path.join(tmp, 'dist-bin')
  fs.mkdirSync(files)
  for (const { target } of TARGETS) fs.writeFileSync(path.join(files, builtName(target)), `#!/bin/sh\necho '${VERSION} (${target})'\n`, { mode: 0o755 })
  await writeAssets({ files, version: VERSION, out: path.join(runner, 'release', 'assets') })
  // actions/checkout with ref: <sha> and fetch-depth: 0.
  execFileSync('git', ['clone', '-q', origin, job], { env: cleanEnv() })
  gitIn(job, 'checkout', '-q', '--detach', released)
})

const publishes = () => log('npm').filter((l) => l.startsWith('publish '))

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function releaseAll(extra: Record<string, string> = {}): Promise<void> {
  for (const step of [PACK, PUBLISH, TAG, ATTACH, GO_PUBLIC, ROLL]) {
    const r = await runStep(step, extra)
    expect(r.code, `${step.name}\n${r.out}`).toBe(0)
  }
}

describe('release.yml promote steps', { timeout: 120_000 }, () => {
  // Every test starts where the job does: the assets downloaded, then packed.
  beforeEach(async () => {
    const r = await runStep(PACK)
    expect(r.code, r.out).toBe(0)
  })

  it('packs npm the very files the build uploaded, then publishes, tags, opens the GitHub Release and rolls main, in order', async () => {
    await releaseAll()
    // Every platform package, then the launcher, each under latest with provenance,
    // each holding the bytes the build gzipped, and naming the released commit.
    const sent = publishes()
    expect(sent).toHaveLength(PACKAGES)
    expect(sent.at(-1)).toBe(`publish ${path.join(runner, 'release', 'npm', 'open-walnut')} --tag latest --access public --provenance`)
    expect(sent.slice(0, -1).map((l) => l.split(' ')[1]).sort()).toEqual(TARGETS.map((t) => path.join(runner, 'release', 'npm', '@open-walnut', t.target)).sort())
    for (const { target } of TARGETS) {
      const pkg = path.join(runner, 'release', 'npm', '@open-walnut', target)
      expect(fs.readFileSync(path.join(pkg, 'walnut')).equals(fs.readFileSync(path.join(files, builtName(target)))), target).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'))).toMatchObject({ version: VERSION, gitHead: released })
    }

    // An annotated tag on the released commit, not on main.
    expect(atOrigin('cat-file', '-t', `refs/tags/v${VERSION}`)).toBe('tag')
    expect(atOrigin('rev-parse', `v${VERSION}^{commit}`)).toBe(released)
    expect(JSON.parse(fs.readFileSync(path.join(state, 'releases', RELEASE, '.meta.json'), 'utf8')))
      .toEqual(['--title', `Open Walnut ${VERSION}`, '--notes-file', path.join(runner, 'notes.md')])

    // A draft first, its files on it with SHA256SUMS last, and only then public.
    const gh = ghCalls(state)
    const created = gh.indexOf(`release create ${RELEASE} --draft --title Open Walnut ${VERSION} --notes-file ${path.join(runner, 'notes.md')}`)
    const sums = gh.findIndex((c) => c.startsWith(`release upload ${RELEASE} `) && c.includes('/SHA256SUMS'))
    const published = gh.indexOf(`release edit ${RELEASE} --draft=false --latest`)
    expect(created).toBeGreaterThan(-1)
    expect(sums).toBeGreaterThan(created)
    expect(published).toBeGreaterThan(sums)
    expect(isDraft(state, RELEASE)).toBe(false)
    expect(releaseAssets(state, RELEASE)).toEqual(['SHA256SUMS', 'install.sh', ...TARGETS.map((t) => assetName(VERSION, t.target))].sort())

    // One commit on top of the newest main, touching only the release files.
    const head = atOrigin('rev-parse', 'main')
    expect(atOrigin('rev-parse', 'main~1')).toBe(mainBefore)
    expect(atOrigin('log', '-1', '--format=%s', 'main')).toBe(`release: ${VERSION}`)
    expect(atOrigin('diff', '--name-only', mainBefore, head).split('\n').sort())
      .toEqual(['CHANGELOG.md', 'package.json'])
    expect(JSON.parse(atOrigin('show', 'main:package.json')).version).toBe(VERSION)
    const changelog = atOrigin('show', 'main:CHANGELOG.md')
    const unreleased = changelog.slice(changelog.indexOf('## [Unreleased]'), changelog.indexOf(`## [${VERSION}]`))
    expect(unreleased).toContain('Later fix')
    expect(unreleased).not.toContain('Released fix')
    expect(changelog).toMatch(new RegExp(`## \\[${VERSION.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}\\n\\n### Fixed\\n\\n- \\*\\*Released fix\\.\\*\\*`))
  })

  it('packs nothing from a file its SHA256SUMS disowns', async () => {
    const gz = path.join(runner, 'release', 'assets', assetName(VERSION, 'linux-arm64-musl'))
    fs.writeFileSync(gz, Buffer.concat([fs.readFileSync(gz), Buffer.from('x')]))
    fs.rmSync(path.join(runner, 'release', 'npm'), { recursive: true, force: true })
    const r = await runStep(PACK)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`${assetName(VERSION, 'linux-arm64-musl')} has sha256`)
    expect(fs.existsSync(path.join(runner, 'release', 'npm'))).toBe(false)
  })

  it('a rerun of a finished release does nothing twice', async () => {
    await releaseAll()
    const mainAfter = atOrigin('rev-parse', 'main')
    const tagAfter = atOrigin('rev-parse', `refs/tags/v${VERSION}`)
    const calls = ghCalls(state).length
    await releaseAll({ FAKE_REGISTRY_HAS: '1' })
    expect(publishes()).toHaveLength(PACKAGES) // only the first run's
    expect(atOrigin('rev-parse', `refs/tags/v${VERSION}`)).toBe(tagAfter)
    expect(ghCalls(state).slice(calls).filter((l) => /^release (create|upload|edit)/.test(l))).toEqual([])
    expect(atOrigin('rev-parse', 'main')).toBe(mainAfter)
  })

  it('a release that stopped while still a draft goes public on a rerun, and one already public is left as it is', async () => {
    // Stopped after its files went up, before it went public.
    for (const step of [PUBLISH, TAG, ATTACH]) expect((await runStep(step)).code).toBe(0)
    expect(isDraft(state, RELEASE)).toBe(true)
    await releaseAll({ FAKE_REGISTRY_HAS: '1' })
    expect(isDraft(state, RELEASE)).toBe(false)
    expect(ghCalls(state).filter((l) => l.startsWith('release create'))).toHaveLength(1)
    expect(ghCalls(state).filter((l) => l.startsWith(`release upload ${RELEASE} `) && l.includes('/SHA256SUMS'))).toHaveLength(1)
    expect(ghCalls(state).filter((l) => l.startsWith('release edit'))).toHaveLength(1)

    // A release an older run made public before its files: left public, its files added.
    fs.rmSync(path.join(state, 'releases'), { recursive: true, force: true })
    fs.rmSync(path.join(state, 'gh.log'), { force: true })
    makeRelease(state, RELEASE, { assets: { 'open-walnut.rb': 'class OpenWalnut; end\n' } })
    for (const step of [TAG, ATTACH, GO_PUBLIC]) {
      const r = await runStep(step)
      expect(r.code, `${step.name}\n${r.out}`).toBe(0)
    }
    expect(ghCalls(state).filter((l) => /^release (create|edit)/.test(l))).toEqual([])
    expect(releaseAssets(state, RELEASE)).toContain('SHA256SUMS')
  })

  it('a draft without its SHA256SUMS stays a draft, and so does one GitHub cannot read', async () => {
    makeRelease(state, RELEASE, { draft: true, assets: { [assetName(VERSION, 'linux-x64')]: 'half of the files' } })
    const r = await runStep(GO_PUBLIC)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`::error::${RELEASE} has no SHA256SUMS, so not all of its files are up: it stays a draft`)
    expect(isDraft(state, RELEASE)).toBe(true)
    const down = await runStep(GO_PUBLIC, { FAKE_GH_FAIL: 'view' })
    expect(down.code).not.toBe(0)
    expect(ghCalls(state).filter((l) => l.startsWith('release edit'))).toEqual([])
  })

  // 2026-10-09: npm held the first run's 0.6.7 for minutes before it served it, so
  // the run queued behind it found nothing at the registry check, published, and
  // npm answered 409. That refusal says the version is taken: the job goes on.
  it('a version npm already holds, served or not yet, counts as published', async () => {
    for (const refusal of ['staged', 'published']) {
      const r = await runStep(PUBLISH, { FAKE_NPM_PUBLISH: refusal })
      expect(r.code, `${refusal}\n${r.out}`).toBe(0)
      expect(r.out).toContain(`npm already holds open-walnut@${VERSION}`)
    }
    await releaseAll({ FAKE_REGISTRY_HAS: '1' })
    expect(atOrigin('rev-parse', `v${VERSION}^{commit}`)).toBe(released)
  })

  it('any other refusal, or one for another version, stops the release', async () => {
    for (const refusal of ['denied', 'newer']) {
      const r = await runStep(PUBLISH, { FAKE_NPM_PUBLISH: refusal })
      expect(r.code, `${refusal}\n${r.out}`).not.toBe(0)
      expect(r.out).not.toContain('npm already holds')
    }
  })

  it('the job ends only once npm serves the version, before the tag', async () => {
    const steps = workflow.jobs.promote!.steps
    const WAIT = promoteStep('Wait until npm serves it')
    expect(steps.indexOf(WAIT)).toBe(steps.indexOf(PUBLISH) + 1)
    expect(steps.indexOf(TAG)).toBeGreaterThan(steps.indexOf(WAIT))
    // It asks for the launcher, which the publish sends last.
    expect(WAIT.run).toMatch(/curl [^;]*"https:\/\/registry\.npmjs\.org\/open-walnut\/\$VERSION"/)
    expect(await runStep(WAIT, { FAKE_REGISTRY_HAS: '1' })).toMatchObject({ code: 0 })
    const never = await runStep(WAIT)
    expect(never.code).not.toBe(0)
    expect(never.out).toContain(`npm did not serve open-walnut@${VERSION}`)
    expect(log('curl')).toHaveLength(61)
  })

  it('a release that stopped at the GitHub Release finishes on a rerun', async () => {
    expect((await runStep(PUBLISH)).code).toBe(0)
    const failed = await runStep(TAG, { FAKE_GH_FAIL_CREATE: '1' })
    expect(failed.code).not.toBe(0)
    const tag = atOrigin('rev-parse', `refs/tags/v${VERSION}`)
    // "Re-run failed jobs": a fresh checkout of the same commit, npm already has it.
    fs.rmSync(job, { recursive: true, force: true })
    execFileSync('git', ['clone', '-q', origin, job], { env: cleanEnv() })
    gitIn(job, 'checkout', '-q', '--detach', released)
    await releaseAll({ FAKE_REGISTRY_HAS: '1' })
    expect(publishes()).toHaveLength(PACKAGES)
    expect(atOrigin('rev-parse', `refs/tags/v${VERSION}`)).toBe(tag)
    expect(isDraft(state, RELEASE)).toBe(false)
    expect(releaseAssets(state, RELEASE)).toContain('SHA256SUMS')
    expect(atOrigin('log', '-1', '--format=%s', 'main')).toBe(`release: ${VERSION}`)
  })

  it('stops when the version is already tagged on another commit', async () => {
    gitIn(seed, 'tag', '-a', `v${VERSION}`, '-m', 'someone else', mainBefore)
    gitIn(seed, 'push', '-q', 'origin', `refs/tags/v${VERSION}`)
    const r = await runStep(TAG)
    expect(r.code).toBe(1)
    expect(r.out).toContain(`v${VERSION} already exists on ${mainBefore}, not on ${released}`)
    expect(log('gh').filter((l) => l.startsWith('release create'))).toEqual([])
  })

  it('lands the release commit on a main that moved during the push', async () => {
    expect((await runStep(PUBLISH)).code).toBe(0)
    expect((await runStep(TAG)).code).toBe(0)
    const r = await runStep(ROLL, {}, raceBin())
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('main moved during the push; trying again (1)')
    expect(atOrigin('log', '-1', '--format=%s', 'main~1')).toBe("fix: a peer's change 0")
    expect(atOrigin('log', '-1', '--format=%s', 'main')).toBe(`release: ${VERSION}`)
    expect(atOrigin('show', 'main:peer-0.txt')).toBe('peer 0')
  })

  it('when main changed a workflow after the release, tags a child of it that carries main\'s workflows', async () => {
    fs.writeFileSync(path.join(seed, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n')
    gitIn(seed, 'commit', '-q', '-am', 'ci: a workflow change after the release')
    gitIn(seed, 'push', '-q', 'origin', 'main')
    const mainNow = gitIn(seed, 'rev-parse', 'HEAD')
    // The rule is live: the job's token cannot tag the released commit as it is.
    const direct = await runStep({ name: 'probe', run: `git tag probe "${released}" && git push origin refs/tags/probe` })
    expect(direct.code).toBe(1)
    expect(direct.out).toContain('refusing to allow a GitHub App to create or update workflow')

    await releaseAll()
    const tagged = atOrigin('rev-parse', `v${VERSION}^{commit}`)
    expect(tagged).not.toBe(released)
    expect(atOrigin('rev-parse', `${tagged}^`)).toBe(released)
    // The package source is the released commit's; only the workflows are main's.
    expect(atOrigin('diff', '--name-only', released, tagged)).toBe('.github/workflows/ci.yml')
    expect(atOrigin('show', `${tagged}:.github/workflows/ci.yml`)).toBe(atOrigin('show', `${mainNow}:.github/workflows/ci.yml`))
    expect(atOrigin('log', '-1', '--format=%B', tagged)).toContain(`built from ${released}`)
    expect(isDraft(state, RELEASE)).toBe(false)
    expect(atOrigin('log', '-1', '--format=%s', 'main')).toBe(`release: ${VERSION}`)

    // A rerun takes that tag as this release's, and does nothing twice.
    await releaseAll({ FAKE_REGISTRY_HAS: '1' })
    expect(atOrigin('rev-parse', `v${VERSION}^{commit}`)).toBe(tagged)
    expect(log('gh').filter((l) => l.startsWith('release create'))).toHaveLength(1)
  })

  it('fails, loudly, when main never holds still long enough', async () => {
    expect((await runStep(PUBLISH)).code).toBe(0)
    expect((await runStep(TAG)).code).toBe(0)
    const r = await runStep(ROLL, { RACE_ALWAYS: '1' }, raceBin())
    expect(r.code).toBe(1)
    expect(r.out).toContain(`::error::open-walnut@${VERSION} is published, but main's CHANGELOG and package.json were not rolled`)
    expect(atOrigin('log', '-1', '--format=%s', 'main')).not.toBe(`release: ${VERSION}`)
  })
})
