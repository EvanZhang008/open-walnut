/**
 * The repo installs with Bun: one pinned version, text bun.lock files, Bun's own
 * patch mechanism, and a postinstall that installs web/ the same way. These
 * pin what a later edit could silently undo (a workflow back on `npm ci`, a
 * setup-bun on `latest`, a dependency bump that leaves its patch behind).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { readBunLock, splitSpec } from '../helpers/bun-lock.js'
import { applySdkPatch, buildSqliteDylib, installerOf, isDevCheckout, npmWebInstallArgs, sdkPatchOf, webInstallCommand } from '../../scripts/postinstall.mjs'

const REPO = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
  packageManager?: string
  patchedDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const BUN_VERSION = /^bun@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? '')?.[1]

/** Every package dir with its own lockfile; each one installs with Bun. */
const LOCK_DIRS = ['.', 'web', 'infra', 'ios']

interface Step { uses?: string; run?: string; with?: Record<string, unknown> }
function workflowSteps(): Array<{ file: string; job: string; step: Step }> {
  const dir = path.join(REPO, '.github', 'workflows')
  const out: Array<{ file: string; job: string; step: Step }> = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
    const doc = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8')) as { jobs?: Record<string, { steps?: Step[] }> }
    for (const [job, def] of Object.entries(doc.jobs ?? {})) for (const step of def.steps ?? []) out.push({ file, job, step })
  }
  return out
}

describe('one pinned Bun', () => {
  it('package.json names an exact Bun as its packageManager', () => {
    expect(BUN_VERSION).toBeDefined()
  })

  it('every CI setup-bun installs that version', () => {
    const setups = workflowSteps().filter(({ step }) => step.uses?.startsWith('oven-sh/setup-bun'))
    expect(setups.length).toBeGreaterThan(0)
    for (const { file, job, step } of setups) expect(String(step.with?.['bun-version']), `${file} ${job}`).toBe(BUN_VERSION)
  })

  it('CI installs dependencies with Bun, never from an npm lockfile', () => {
    for (const { file, job, step } of workflowSteps()) {
      expect(step.run ?? '', `${file} ${job}`).not.toMatch(/(^|\n|&&\s*)npm (ci|install)\s*($|\n)/)
      // setup-node's npm cache keys on package-lock.json, which no longer exists.
      if (step.uses?.startsWith('actions/setup-node')) expect(step.with?.cache, `${file} ${job}`).toBeUndefined()
    }
    const installs = workflowSteps().filter(({ step }) => /^bun install( --frozen-lockfile)?$/.test(step.run ?? ''))
    expect(installs.length).toBeGreaterThan(0)
  })
})

describe('lockfiles', () => {
  it('each package dir has a text bun.lock and no package-lock.json', () => {
    for (const dir of LOCK_DIRS) {
      expect(fs.existsSync(path.join(REPO, dir, 'bun.lock')), `${dir}/bun.lock`).toBe(true)
      expect(fs.existsSync(path.join(REPO, dir, 'bun.lockb')), `${dir}/bun.lockb`).toBe(false)
      expect(readBunLock(path.join(REPO, dir, 'bun.lock')).packages).toBeTypeOf('object')
    }
    // Tracked, not on disk: npm writes an (ignored) package-lock.json when a checkout
    // is installed with it anyway, and that must not fail anyone's test run.
    // An inherited GIT_DIR (git exports one while it runs hooks) would answer for another repo.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', env }).split('\0')
    expect(tracked.filter((f) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f))).toEqual([])
    for (const dir of LOCK_DIRS) expect(tracked, dir).toContain(dir === '.' ? 'bun.lock' : `${dir}/bun.lock`)
  })

  it('the root installs into one flat node_modules', () => {
    expect(fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8')).toMatch(/^linker = "hoisted"$/m)
  })

  it('patch-package is gone; tests that parse YAML name the package they import', () => {
    expect(pkg.devDependencies?.['patch-package']).toBeUndefined()
    expect(pkg.devDependencies?.yaml).toBeDefined()
  })
})

describe('patches', () => {
  const lock = readBunLock(path.join(REPO, 'bun.lock'))

  it('every patch targets the version bun.lock installs, and exists', () => {
    const entries = Object.entries(pkg.patchedDependencies ?? {})
    expect(entries.length).toBeGreaterThan(0)
    for (const [key, file] of entries) {
      const [name, version] = splitSpec(key)
      expect(fs.existsSync(path.join(REPO, file)), file).toBe(true)
      // A bump that leaves the patch behind fails here, not silently at install.
      expect(lock.packages[name]?.[0], key).toBe(`${name}@${version}`)
      expect(lock.patchedDependencies?.[key], key).toBe(file)
    }
  })

  it('the SDK patch is the one-line change the published postinstall can apply', () => {
    const patch = sdkPatchOf(pkg)
    expect(patch).not.toBeNull()
    const lines = fs.readFileSync(path.join(REPO, patch.file), 'utf8').split('\n')
    expect(lines.filter((l) => l.startsWith('-') && !l.startsWith('---'))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('+') && !l.startsWith('+++'))).toHaveLength(1)
  })

  it('the published package ships the patch it names', () => {
    const files = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { files: string[] }).files
    expect(files).toContain('patches')
    expect(files).toContain('scripts/postinstall.mjs')
  })
})

describe('postinstall', () => {
  let tmp: string
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-postinstall-')) })
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

  it('tells a checkout from an installed package', () => {
    expect(isDevCheckout(REPO)).toBe(true)
    expect(isDevCheckout(tmp)).toBe(false)
  })

  it('builds the macOS SQLite in a checkout, and only warns when that fails', () => {
    const runs: string[] = []
    const warns: string[] = []
    const run = (status: number | null, error?: Error) => (file: string) => { runs.push(file); if (error) throw error; return { status } }
    expect(buildSqliteDylib(REPO, { platform: 'linux', run: run(0), warn: (m: string) => warns.push(m) })).toBe('skipped')
    expect(runs).toEqual([])
    expect(buildSqliteDylib(REPO, { platform: 'darwin', run: run(0), warn: (m: string) => warns.push(m) })).toBe('ok')
    expect(runs).toEqual([path.join(REPO, 'scripts', 'build-sqlite-dylib.mjs')])
    expect(warns).toEqual([])
    expect(buildSqliteDylib(REPO, { platform: 'darwin', run: run(1), warn: (m: string) => warns.push(m) })).toBe('failed')
    expect(buildSqliteDylib(REPO, { platform: 'darwin', run: run(null, new Error('spawn failed')), warn: (m: string) => warns.push(m) })).toBe('failed')
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain('bun scripts/build-sqlite-dylib.mjs')
    expect(buildSqliteDylib(tmp, { platform: 'darwin', run: run(0) })).toBe('skipped')
  })

  it('reads the installer from the user agent', () => {
    expect(installerOf({ npm_config_user_agent: 'bun/1.4.4 npm/? node/v24.0.0 darwin arm64' })).toBe('bun')
    expect(installerOf({ npm_config_user_agent: 'npm/11.12.1 node/v25.9.0 darwin arm64 workspaces/false' })).toBe('npm')
    expect(installerOf({})).toBe('unknown')
  })

  it('installs web/ with the running Bun, frozen in CI', () => {
    const bun = '/opt/tools/bun-1.4.4/bin/bun'
    expect(webInstallCommand({ npm_execpath: bun })).toEqual({ cmd: bun, args: ['install'] })
    expect(webInstallCommand({ npm_execpath: bun, CI: 'true' })).toEqual({ cmd: bun, args: ['install', '--frozen-lockfile'] })
    expect(webInstallCommand({ npm_execpath: bun, CI: 'false' }).args).toEqual(['install'])
    // npm_execpath names npm's own script under npm: then plain `bun` from PATH.
    expect(webInstallCommand({ npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }).cmd).toBe('bun')
  })

  it('under npm (the Mac app clones and runs npm), installs web/ with npm, letting npm 12 fetch the xlsx tarball', () => {
    expect(npmWebInstallArgs({ npm_config_user_agent: 'npm/11.12.1 node/v25.9.0 darwin arm64' })).toEqual(['install'])
    expect(npmWebInstallArgs({ npm_config_user_agent: 'npm/12.0.1 node/v25.9.0 darwin arm64' })).toEqual(['install', '--allow-remote=root'])
  })

  describe('published package: applies the SDK patch itself', () => {
    const OLD = 'K=J4z(A.file)+(X4z()?j4z:"");'
    const NEW = 'K=J4z(A.file)+("");'
    let sdkDir: string
    const warnings: string[] = []
    const opts = () => ({ warn: (m: string) => warnings.push(m), resolveSdk: () => path.join(sdkDir, 'sdk.mjs') })

    beforeEach(() => {
      warnings.length = 0
      // An npm consumer's layout: the package beside the hoisted SDK.
      sdkDir = path.join(tmp, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
      fs.mkdirSync(sdkDir, { recursive: true })
      fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '9.9.9' }))
      fs.writeFileSync(path.join(sdkDir, 'sdk.mjs'), '')
      fs.writeFileSync(path.join(sdkDir, 'cli.js'), `a\n${OLD}\nb\n`)
      const pkgDir = path.join(tmp, 'node_modules', 'open-walnut')
      fs.mkdirSync(path.join(pkgDir, 'patches'), { recursive: true })
      const file = 'patches/@anthropic-ai%2Fclaude-agent-sdk@9.9.9.patch'
      fs.writeFileSync(path.join(pkgDir, file), `diff --git a/cli.js b/cli.js\n--- a/cli.js\n+++ b/cli.js\n@@ -1,3 +1,3 @@\n a\n-${OLD}\n+${NEW}\n b\n`)
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'open-walnut', patchedDependencies: { '@anthropic-ai/claude-agent-sdk@9.9.9': file } }))
    })

    it('patches once, then finds it already done', () => {
      const pkgDir = path.join(tmp, 'node_modules', 'open-walnut')
      expect(applySdkPatch(pkgDir, opts())).toBe('patched')
      expect(fs.readFileSync(path.join(sdkDir, 'cli.js'), 'utf8')).toBe(`a\n${NEW}\nb\n`)
      expect(applySdkPatch(pkgDir, opts())).toBe('already')
      expect(warnings).toEqual([])
    })

    it('leaves another SDK version alone, with a warning', () => {
      fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '9.9.10' }))
      applySdkPatch(path.join(tmp, 'node_modules', 'open-walnut'), opts())
      expect(fs.readFileSync(path.join(sdkDir, 'cli.js'), 'utf8')).toBe(`a\n${OLD}\nb\n`)
      expect(warnings.join('\n')).toMatch(/9\.9\.10 != patch target 9\.9\.9/)
    })
  })
})
