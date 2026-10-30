/**
 * The release's SHA256SUMS once the Node archives join it, and the question
 * whether a release has the compiled files: release-archives.yml's job
 * `publish` step "Upload the archives, then SHA256SUMS" (which calls
 * scripts/release-archive-sums.sh) and job `files` step "Its SHA256SUMS lists
 * them", each run as written against a fake GitHub (tests/scripts/fake-gh-release.ts)
 * holding a release laid out by release-files.mjs.
 *
 * What matters: the compiled files' lines survive every merge, and GitHub failing
 * to answer fails the job instead of reading as "no lines" or "no files". The
 * step this replaced ignored a failed download and uploaded a SHA256SUMS of
 * archive lines only, for good (install.sh then took the archive, musl had none,
 * and release-attach.sh never put the lines back, as the release had a SHA256SUMS).
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { TARGETS, assetName, builtName, fileName, writeAssets } from '../../scripts/release-files.mjs'
import { guardedPath } from '../setup/exec-guard.js'
import { ghCalls, installFakeGh, makeRelease, releaseAssets } from './fake-gh-release.js'

const ROOT = path.resolve(__dirname, '../..')
const VERSION = '0.7.0'
const TAG = `v${VERSION}`
const ARCHIVE_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex')

interface Step { name?: string; run?: string }
const workflow = parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows/release-archives.yml'), 'utf8')) as {
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>
}
function step(job: string, name: string): Step {
  const s = workflow.jobs[job]!.steps.find((x) => x.name === name)
  if (!s?.run) throw new Error(`release-archives.yml job ${job} has no step "${name}"`)
  return s
}
const MERGE = step('publish', 'Upload the archives, then SHA256SUMS')
const HAS_FILES = step('files', 'Its SHA256SUMS lists them')

let tmp = ''
let state = ''
let runner = ''
let bin = ''
let workspace = ''
let released: { sums: string; assets: Record<string, Buffer> }

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archive-sums-')))
  state = path.join(tmp, 'state')
  runner = path.join(tmp, 'runner')
  bin = path.join(tmp, 'bin')
  for (const d of [state, runner]) fs.mkdirSync(d, { recursive: true })
  installFakeGh(bin)
  // The checkout, with the leak gate (tests/scripts/release-leak-gate.test.ts runs the
  // real one) as a stand-in that records what it was asked to scan and answers FAKE_GATE_EXIT.
  workspace = path.join(tmp, 'workspace')
  fs.mkdirSync(path.join(workspace, 'scripts'), { recursive: true })
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts'))) {
    if (f !== 'release-leak-gate.sh') fs.symlinkSync(path.join(ROOT, 'scripts', f), path.join(workspace, 'scripts', f))
  }
  fs.writeFileSync(path.join(workspace, 'scripts/release-leak-gate.sh'), 'echo "$*" >> "$FAKE_STATE/gate.log"\nexit "${FAKE_GATE_EXIT:-0}"\n')
  // What release.yml attached: every target's .gz, install.sh and SHA256SUMS.
  const files = path.join(tmp, 'dist-bin')
  fs.mkdirSync(files)
  for (const { target } of TARGETS) fs.writeFileSync(path.join(files, builtName(target)), `#!/bin/sh\necho '${VERSION} (${target})'\n`, { mode: 0o755 })
  const out = path.join(tmp, 'assets')
  await writeAssets({ files, version: VERSION, out })
  const assets: Record<string, Buffer> = {}
  for (const f of fs.readdirSync(out)) assets[f] = fs.readFileSync(path.join(out, f))
  assets['install.sh'] = Buffer.from('#!/bin/sh\necho the released commit\'s own install.sh\n')
  released = { sums: assets.SHA256SUMS!.toString('utf8'), assets }
  archives('first build')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** What job `build` leaves for `publish`: one archive per target, `body` inside. */
function archives(body: string): Record<string, string> {
  const dir = path.join(runner, 'archives')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const shas: Record<string, string> = {}
  for (const t of ARCHIVE_TARGETS) {
    const name = `open-walnut-${VERSION}-${t}.tar.gz`
    fs.writeFileSync(path.join(dir, name), `${body} ${t}`)
    shas[name] = sha256(`${body} ${t}`)
  }
  return shas
}

/** A step's `run` the way Actions runs it (bash -e, no pipefail), with the job's env. */
function runStep(s: Step, extra: Record<string, string> = {}): Promise<{ code: number; out: string; output: string }> {
  const output = path.join(tmp, `output-${crypto.randomUUID()}`)
  fs.writeFileSync(output, '')
  expect(s.run).not.toContain('${{')
  return new Promise((resolve) => {
    execFile('bash', ['--noprofile', '--norc', '-e', '-c', s.run!], {
      cwd: tmp,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: guardedPath([bin], process.env.PATH),
        VERSION, GH_TOKEN: 'test-token', GH_REPO: 'example/open-walnut',
        RUNNER_TEMP: runner, GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: output, FAKE_STATE: state,
        ...extra,
      },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
      resolve({ code, out: `${stdout}${stderr}`, output: fs.readFileSync(output, 'utf8') })
    })
  })
}

const releaseSums = () => fs.readFileSync(path.join(state, 'releases', TAG, 'SHA256SUMS'), 'utf8')
const uploads = () => ghCalls(state).filter((c) => c.startsWith('release upload'))
const sumsLines = (text: string) => text.trim().split('\n')

describe('release-archives.yml: the archives join the release\'s SHA256SUMS', { timeout: 60_000 }, () => {
  it('keeps every line of the compiled files and adds the archives\', after the archives are up', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    const shas = archives('first build')
    const r = await runStep(MERGE)
    expect(r.code, r.out).toBe(0)
    const lines = sumsLines(releaseSums())
    // Every line the release had, as it was, then one per archive.
    expect(lines.slice(0, TARGETS.length * 2)).toEqual(sumsLines(released.sums))
    expect(lines.slice(TARGETS.length * 2)).toEqual(Object.entries(shas).map(([name, sha]) => `${sha}  ${name}`))
    for (const { target } of TARGETS) {
      expect(lines.filter((l) => l.endsWith(`  ${assetName(VERSION, target)}`)), target).toHaveLength(1)
      expect(lines.filter((l) => l.endsWith(`  ${fileName(VERSION, target)}`)), target).toHaveLength(1)
    }
    // The archives went up before the SHA256SUMS that lists them; the release's own install.sh stays.
    const up = uploads()
    expect(up[0]).toMatch(/^release upload v0\.7\.0 open-walnut-0\.7\.0-.*\.tar\.gz .*--clobber$/)
    expect(up[1]).toBe(`release upload ${TAG} ${path.join(runner, 'SHA256SUMS')} --clobber`)
    expect(up).toHaveLength(2)
    expect(fs.readFileSync(path.join(state, 'releases', TAG, 'install.sh'))).toEqual(released.assets['install.sh'])
    for (const name of Object.keys(shas)) expect(releaseAssets(state, TAG)).toContain(name)
  })

  it('the leak gate scans the archives, the SHA256SUMS and install.sh first; when it refuses, nothing goes up', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    archives('first build')
    const ok = await runStep(MERGE)
    expect(ok.code, ok.out).toBe(0)
    expect(fs.readFileSync(path.join(state, 'gate.log'), 'utf8').trim()).toBe(`. ${path.join(runner, 'SHA256SUMS')} ${path.join(workspace, 'scripts/install.sh')}`)

    fs.rmSync(path.join(state, 'gate.log'))
    const before = uploads().length
    const refused = await runStep(MERGE, { FAKE_GATE_EXIT: '1' })
    expect(refused.code, refused.out).not.toBe(0)
    expect(fs.existsSync(path.join(state, 'gate.log'))).toBe(true)
    expect(uploads()).toHaveLength(before)
  })

  it('a re-run replaces this version\'s archive lines, never adding a second set', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    archives('first build')
    expect((await runStep(MERGE)).code).toBe(0)
    const shas = archives('second build')
    const r = await runStep(MERGE)
    expect(r.code, r.out).toBe(0)
    const lines = sumsLines(releaseSums())
    expect(lines).toEqual([...sumsLines(released.sums), ...Object.entries(shas).map(([name, sha]) => `${sha}  ${name}`)])
  })

  it('a failed SHA256SUMS download fails the job and uploads nothing', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    const r = await runStep(MERGE, { FAKE_GH_FAIL: 'download' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`could not download ${TAG}'s SHA256SUMS`)
    expect(uploads()).toEqual([])
    expect(releaseSums()).toBe(released.sums)
  })

  it('a release whose assets GitHub cannot list fails the job and uploads nothing', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    const r = await runStep(MERGE, { FAKE_GH_FAIL: 'view' })
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`could not list ${TAG}'s assets`)
    expect(uploads()).toEqual([])
    expect(releaseSums()).toBe(released.sums)
  })

  it('a SHA256SUMS that already lost a compiled file\'s line is not made worse: the job fails, naming it', async () => {
    const lost = assetName(VERSION, 'linux-x64-musl')
    const broken = `${sumsLines(released.sums).filter((l) => !l.endsWith(`  ${lost}`)).join('\n')}\n`
    makeRelease(state, TAG, { assets: { ...released.assets, SHA256SUMS: broken } })
    const r = await runStep(MERGE)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`would not list ${lost}`)
    expect(uploads()).toEqual([])
    expect(releaseSums()).toBe(broken)
  })

  it('a release holding compiled files but no SHA256SUMS is refused one of archive lines only', async () => {
    const { SHA256SUMS: _sums, ...rest } = released.assets
    makeRelease(state, TAG, { assets: rest })
    const r = await runStep(MERGE)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(assetName(VERSION, 'darwin-arm64'))
    expect(uploads()).toEqual([])
  })

  it('a release from before the compiled file (no SHA256SUMS yet) gets the archives\' lines, and install.sh', async () => {
    makeRelease(state, TAG, { assets: { 'open-walnut.rb': 'class OpenWalnut; end\n' } })
    const shas = archives('first build')
    const r = await runStep(MERGE)
    expect(r.code, r.out).toBe(0)
    expect(sumsLines(releaseSums())).toEqual(Object.entries(shas).map(([name, sha]) => `${sha}  ${name}`))
    expect(uploads().at(-1)).toMatch(/^release upload v0\.7\.0 install\.sh --clobber$/)
    expect(fs.readFileSync(path.join(state, 'releases', TAG, 'install.sh'), 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'scripts/install.sh'), 'utf8'))
  })

  it('keeps lines it does not know, and sha256sum\'s binary-mode lines, as they were', async () => {
    const extra = `${sumsLines(released.sums).map((l) => l.replace('  walnut-', ' *walnut-')).join('\n')}\n${'f'.repeat(64)}  open-walnut.rb\n${'e'.repeat(64)}  open-walnut-0.6.9-linux-x64.tar.gz\n`
    makeRelease(state, TAG, { assets: { ...released.assets, SHA256SUMS: extra } })
    const r = await runStep(MERGE)
    expect(r.code, r.out).toBe(0)
    expect(releaseSums().startsWith(extra)).toBe(true)
  })
})

describe('release-archive-sums.sh', () => {
  const sums = (args: string[], extra: Record<string, string> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
    execFile('/bin/sh', [path.join(ROOT, 'scripts/release-archive-sums.sh'), ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: guardedPath([bin], process.env.PATH), FAKE_STATE: state, ...extra },
    }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, out: `${stdout}${stderr}` }))
  })

  it('needs its four arguments and an archive of the version, and writes nothing otherwise', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    const out = path.join(tmp, 'SHA256SUMS')
    expect((await sums([TAG, VERSION, path.join(runner, 'archives')])).code).not.toBe(0)
    const none = await sums([TAG, '0.8.0', path.join(runner, 'archives'), out])
    expect(none.code).not.toBe(0)
    expect(none.out).toContain('no open-walnut-0.8.0-*.tar.gz')
    expect(fs.existsSync(out)).toBe(false)
    const ok = await sums([TAG, VERSION, path.join(runner, 'archives'), out])
    expect(ok.code, ok.out).toBe(0)
    expect(fs.readFileSync(out, 'utf8').startsWith(released.sums)).toBe(true)
    expect(ghCalls(state).filter((c) => c.startsWith('release upload'))).toEqual([])
  })
})

describe('release-archives.yml: whether the release has the compiled files', { timeout: 60_000 }, () => {
  it('a release with them: yes', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    const r = await runStep(HAS_FILES)
    expect(r.code, r.out).toBe(0)
    expect(r.output).toBe('has_files=true\n')
  })

  it('a release from before them, with or without an archives-only SHA256SUMS: no', async () => {
    makeRelease(state, TAG, { assets: { [`open-walnut-${VERSION}-linux-x64.tar.gz`]: 'a' } })
    let r = await runStep(HAS_FILES)
    expect(r.code, r.out).toBe(0)
    expect(r.output).toBe('has_files=false\n')
    makeRelease(state, TAG, { assets: { SHA256SUMS: `${'a'.repeat(64)}  open-walnut-${VERSION}-linux-x64.tar.gz\n` } })
    r = await runStep(HAS_FILES)
    expect(r.code, r.out).toBe(0)
    expect(r.output).toBe('has_files=false\n')
  })

  it('GitHub failing to list the assets or to hand over SHA256SUMS fails the job, never reads as "no files"', async () => {
    makeRelease(state, TAG, { assets: released.assets })
    for (const failing of ['view', 'download']) {
      const r = await runStep(HAS_FILES, { FAKE_GH_FAIL: failing })
      expect(r.code, failing).not.toBe(0)
      expect(r.output, failing).toBe('')
    }
  })

  it('a release holding the file that its SHA256SUMS does not list fails the job', async () => {
    const lost = assetName(VERSION, 'darwin-arm64')
    makeRelease(state, TAG, { assets: { ...released.assets, SHA256SUMS: `${sumsLines(released.sums).filter((l) => !l.endsWith(`  ${lost}`)).join('\n')}\n` } })
    const r = await runStep(HAS_FILES)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`::error::${TAG} holds ${lost}: true, its SHA256SUMS lists it: false`)
    expect(r.output).toBe('')
  })
})
