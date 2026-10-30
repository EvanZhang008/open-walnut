/**
 * The release gate (scripts/release-leak-gate.sh): nothing of a release reaches npm or its
 * GitHub Release while the leak scan finds a hit in it. The first half runs the workflow's
 * own gate and publish commands, read from release.yml, against real built packages with a
 * fake npm on PATH: a planted hit leaves npm untouched, a clean release reaches the dry-run
 * publish. The second half pins that every step of Walnut's release workflows that
 * publishes runs the gate first. The rules here are invented words; the real ones are a
 * repository secret.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { TARGETS, builtName, writeAssets } from '../../scripts/release-files.mjs'
import { buildPackages } from '../../scripts/npm-packages.mjs'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const GATE = path.join(ROOT, 'scripts/release-leak-gate.sh')
const VERSION = '0.7.0'
const PLANTED = 'zorblax'

interface Step { name?: string; if?: string; run?: string; env?: Record<string, string>; 'continue-on-error'?: unknown }
interface Workflow { jobs: Record<string, { steps: Step[] }> }
const workflow = (file: string) => parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8')) as Workflow

let tmp = ''
let rules = ''
let bin = ''

/** A release as the publishing job holds it: the npm packages, the release files and notes. */
function release(name: string, plant?: (dir: string) => void): string {
  const temp = path.join(tmp, name)
  const files = path.join(temp, 'files')
  fs.mkdirSync(files, { recursive: true })
  for (const { target } of TARGETS) fs.writeFileSync(path.join(files, builtName(target)), `#!/bin/sh\necho '${VERSION} (${target})'\n`, { mode: 0o755 })
  plant?.(files)
  return temp
}

async function lay(temp: string): Promise<void> {
  await writeAssets({ files: path.join(temp, 'files'), version: VERSION, out: path.join(temp, 'release/assets') })
  buildPackages({ files: path.join(temp, 'files'), version: VERSION, out: path.join(temp, 'release/npm'), gitHead: 'a'.repeat(40) })
  fs.writeFileSync(path.join(temp, 'notes.md'), `## ${VERSION}\n\n- Faster startup.\n`)
}

/** The job's gate step, then its npm publish as a dry run, the way the job runs them. */
function gateThenPublish(job: string, temp: string, env: Record<string, string> = {}) {
  const steps = workflow('release.yml').jobs[job]!.steps
  const gate = steps.find((s) => s.run?.includes('release-leak-gate.sh'))!
  const publish = steps.find((s) => s.run?.includes('npm-packages.mjs publish'))!
  const script = `set -e\n${gate.run}\n${publish.run!.replace('--provenance', '--dry-run')}\n`
  const log = path.join(temp, 'npm.log')
  // The job's workspace: the release's checkout at the root, this commit's in harness/.
  const work = path.join(temp, 'work')
  fs.mkdirSync(work, { recursive: true })
  fs.symlinkSync(path.join(ROOT, 'scripts'), path.join(work, 'scripts'))
  fs.symlinkSync(ROOT, path.join(work, 'harness'))
  const r = spawnSync('bash', ['-c', script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: guardedPath([bin, path.dirname(process.execPath)], '/usr/bin:/bin'),
      RUNNER_TEMP: temp,
      VERSION,
      FAKE_NPM_LOG: log,
      LEAK_SCAN_RULES: rules,
      ...env,
    },
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}`, npm: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] }
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-leak-gate-')))
  const src = path.join(tmp, 'rules.tsv')
  fs.writeFileSync(src, `# invented rules\ntool\tterm\t${PLANTED}\n`)
  const out = path.join(tmp, 'rules.json')
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/leak-scan/build-rules.mjs'), src, '--out', out], { stdio: 'pipe' })
  rules = fs.readFileSync(out, 'utf8')
  bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  // npm, as far as a dry-run publish asks it: say each call, publish nothing.
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "$*" >> "$FAKE_NPM_LOG"\n', { mode: 0o755 })
})

afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('the release gate stops a publish', () => {
  for (const job of ['stable', 'nightly', 'promote']) {
    it(`${job}: a hit in a packaged file publishes nothing; a clean release reaches the dry-run publish`, async () => {
      const dirty = release(`${job}-dirty`, (files) => {
        fs.appendFileSync(path.join(files, builtName('linux-x64')), `# built for the ${PLANTED} team\n`)
      })
      await lay(dirty)
      const stopped = gateThenPublish(job, dirty)
      expect(stopped.code, stopped.out).not.toBe(0)
      expect(stopped.out).toContain('HIT tool')
      expect(stopped.out).toContain('the leak scan found a hit in the npm packages')
      expect(stopped.out).not.toContain(PLANTED)
      expect(stopped.npm).toEqual([])

      const clean = release(`${job}-clean`)
      await lay(clean)
      const passed = gateThenPublish(job, clean)
      expect(passed.code, passed.out).toBe(0)
      expect(passed.out).toContain('release-leak-gate: no hit in what this release publishes')
      expect(passed.npm).toHaveLength(TARGETS.length + 1)
      for (const call of passed.npm) expect(call).toMatch(/^publish .* --dry-run/)
    })
  }

  it('a hit only in the release notes stops a promotion before npm and the GitHub Release', async () => {
    const temp = release('notes-dirty')
    await lay(temp)
    // The promote job scans the notes the plan wrote; the stable job writes its own from CHANGELOG.
    fs.appendFileSync(path.join(temp, 'notes.md'), `- Works with ${PLANTED} now.\n`)
    const stopped = gateThenPublish('promote', temp)
    expect(stopped.code, stopped.out).not.toBe(0)
    expect(stopped.out).toContain('the leak scan found a hit in the GitHub Release files')
    expect(stopped.npm).toEqual([])
  })

  it('no rules, or nothing to scan, stops it too: the gate never passes by not looking', async () => {
    const temp = release('no-rules')
    await lay(temp)
    const norules = gateThenPublish('promote', temp, { LEAK_SCAN_RULES: '' })
    expect(norules.code).not.toBe(0)
    expect(norules.out).toMatch(/no rules: LEAK_SCAN_RULES is empty or unset/)
    expect(norules.out).toContain('the leak scan could not check the npm packages')
    expect(norules.npm).toEqual([])

    const empty = path.join(tmp, 'empty-npm')
    fs.mkdirSync(empty)
    const r = spawnSync('sh', [GATE, '--npm', empty], { encoding: 'utf8', env: { ...process.env, PATH: guardedPath([path.dirname(process.execPath)], '/usr/bin:/bin'), LEAK_SCAN_RULES: rules } })
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toMatch(/fewer than --min-files 2/)
    expect(spawnSync('sh', [GATE], { encoding: 'utf8' }).status).toBe(2)
  })
})

/** The commands that publish: to npm, or to a GitHub Release. */
const PUBLISHES = /npm-packages\.mjs publish|npm publish|gh release (?:create|upload|edit)|release-attach\.sh/

describe('every step of Walnut\'s release workflows that publishes runs the gate first', () => {
  // Third-party runtime builds Walnut downloads, not a Walnut release; the daily leak
  // audit reads their releases. Their llama.cpp library holds a rule word inside a C++
  // symbol name, so gating them needs the scanner to read symbol names first.
  const LEFT_OUT: Record<string, string> = {
    'components.yml': 'third-party runtime archives (pinned, checked by SHA-256)',
    'stt-runtime.yml': 'the llama-server build of llama.cpp',
  }

  it('names every workflow that publishes', () => {
    const publishing = fs.readdirSync(path.join(ROOT, '.github/workflows'))
      .filter((f) => /\.ya?ml$/.test(f))
      .filter((f) => Object.values(workflow(f).jobs).some((j) => (j.steps ?? []).some((s) => PUBLISHES.test(s.run ?? ''))))
      .sort()
    expect(publishing).toEqual(['mac-app.yml', 'release-archives.yml', 'release.yml', ...Object.keys(LEFT_OUT)].sort())
  })

  for (const file of ['release.yml', 'release-archives.yml', 'mac-app.yml']) {
    it(file, () => {
      const jobs = workflow(file).jobs
      let checked = 0
      for (const [name, job] of Object.entries(jobs)) {
        const steps = job.steps ?? []
        steps.forEach((step, i) => {
          const run = step.run ?? ''
          const lines = run.split('\n')
          const first = lines.findIndex((l) => PUBLISHES.test(l) && !/^\s*#|::error::/.test(l))
          if (first < 0) return
          checked++
          const where = `${file} ${name} "${step.name ?? run.slice(0, 40)}"`
          // The gate runs in this step before the line, or in an earlier step with the same condition.
          const inStep = lines.slice(0, first).some((l) => l.includes('release-leak-gate.sh'))
          const gate = inStep ? step : steps.slice(0, i).reverse().find((s) => (s.run ?? '').includes('release-leak-gate.sh'))
          expect(gate, `${where}: no release-leak-gate.sh before it`).toBeDefined()
          expect(gate!.env?.LEAK_SCAN_RULES, where).toBe('${{ secrets.LEAK_SCAN_RULES }}')
          expect(gate!['continue-on-error'], where).toBeUndefined()
          if (!inStep) expect(gate!.if, `${where}: the gate runs whenever the publish does`).toBe(step.if)
        })
      }
      expect(checked, file).toBeGreaterThan(0)
    })
  }

  it('a job that checks out an older commit runs this commit\'s gate, from harness/', () => {
    for (const file of ['release.yml', 'release-archives.yml', 'mac-app.yml']) {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        const steps = (job.steps ?? []) as Array<Step & { uses?: string; with?: Record<string, string> }>
        const gates = steps.filter((s) => (s.run ?? '').includes('release-leak-gate.sh'))
        if (!gates.length) continue
        const root = steps.find((s) => s.uses?.startsWith('actions/checkout') && !s.with?.path)
        const ref = root?.with?.ref
        if (!ref || ref === '${{ github.sha }}') continue
        const where = `${file} ${name} (checks out ${ref})`
        // The release's commit may predate the gate: it would have no script to run.
        expect(steps.some((s) => s.uses?.startsWith('actions/checkout') && s.with?.path === 'harness' && (!s.with?.ref || s.with.ref === '${{ github.sha }}')), where).toBe(true)
        for (const g of gates) expect(g.run, where).toMatch(/sh harness\/scripts\/release-leak-gate\.sh/)
      }
    }
  })

  it('a step that uploads install.sh (release-attach.sh) is gated on install.sh too', () => {
    let checked = 0
    for (const file of ['release.yml', 'release-archives.yml']) {
      for (const job of Object.values(workflow(file).jobs)) {
        const steps = job.steps ?? []
        steps.forEach((step, i) => {
          if (!(step.run ?? '').split('\n').some((l) => l.includes('release-attach.sh') && !/^\s*#|::error::/.test(l))) return
          checked++
          const gates = steps.slice(0, i).filter((s) => (s.run ?? '').includes('release-leak-gate.sh'))
          expect(gates.some((g) => /release-leak-gate\.sh[^\n]*\bscripts\/install\.sh\b/.test(g.run!)), `${file} ${step.name}`).toBe(true)
        })
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
