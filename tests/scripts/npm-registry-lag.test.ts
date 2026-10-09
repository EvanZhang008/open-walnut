/**
 * An npm install that fails because the registry does not serve a dependency's
 * new version yet runs again after a wait (scripts/npm-registry-lag.mjs).
 * 2026-10-09: the AWS SDK published a family of packages at 20:57-21:01 UTC and
 * nine CI jobs installing at 21:00-21:04 failed with ETARGET on two of them; the
 * same installs passed once npm served the whole family.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { LAG_WAITS_MS, missingVersion, retryRegistryLag, runPassingThrough } from '../../scripts/npm-registry-lag.mjs'
import { IsolatedWalnut } from '../../scripts/release-rehearsal/walnut.mjs'

const REPO = path.resolve(__dirname, '../..')
const CLI = path.join(REPO, 'scripts/npm-registry-lag.mjs')

// npm's own words, as the runners printed them that day.
const ETARGET_HTTP = [
  'npm error code ETARGET',
  'npm error notarget No matching version found for @aws-sdk/credential-provider-http@^3.972.75.',
  'npm error notarget In most cases you or one of your dependencies are requesting',
  "npm error notarget a package version that doesn't exist.",
].join('\n')
const ETARGET_STREAM = [
  'npm error code ETARGET',
  'npm error notarget No matching version found for @aws-sdk/middleware-eventstream@^3.972.31.',
].join('\n')

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-npm-lag-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

/**
 * A stand-in npm that fails with `failure` on its first `fails` runs, then
 * succeeds (and, for `install -g`, leaves the bin a real install would).
 */
function fakeNpm(fails: number, failure: string): string {
  const file = path.join(tmp, 'fake-npm.cjs')
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs'), path = require('path')
const count = path.join(${JSON.stringify(tmp)}, 'runs')
const n = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0
fs.writeFileSync(count, String(n + 1))
if (n < ${fails}) { process.stderr.write(${JSON.stringify(`${failure}\n`)}); process.exit(1) }
if (process.env.npm_config_prefix) {
  fs.mkdirSync(path.join(process.env.npm_config_prefix, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(process.env.npm_config_prefix, 'bin', 'open-walnut'), '')
}
process.stdout.write('added 1 package\\n')
`, { mode: 0o755 })
  return file
}
const runs = () => Number(fs.readFileSync(path.join(tmp, 'runs'), 'utf8'))
const noWait = { waits: [0, 0, 0], sleep: async () => {}, log: () => {} }

describe('npm-registry-lag · which failures are a publish in flight', () => {
  it('names the dependency npm did not serve, from npm\'s own ETARGET output', () => {
    expect(missingVersion(ETARGET_HTTP)).toBe('@aws-sdk/credential-provider-http@^3.972.75')
    expect(missingVersion(ETARGET_STREAM)).toBe('@aws-sdk/middleware-eventstream@^3.972.31')
  })

  it('leaves every other npm failure alone', () => {
    for (const other of [
      'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/no-such-package',
      'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree',
      'npm error code EACCES\nnpm error syscall mkdir',
      'npm error code ECONNRESET\nnpm error network aborted',
      // The words alone, without npm's code, are not npm's verdict.
      'No matching version found for left-pad@^9 in the docs',
      '',
    ]) expect(missingVersion(other), other).toBeNull()
  })

  it('waits about seven minutes in all, the longest last', () => {
    expect(LAG_WAITS_MS.reduce((a, b) => a + b, 0)).toBe(7 * 60_000)
    expect([...LAG_WAITS_MS].sort((a, b) => a - b)).toEqual(LAG_WAITS_MS)
  })
})

describe('npm-registry-lag · retryRegistryLag', () => {
  it('tries again after each wait while npm names a missing version, then passes', async () => {
    const slept: number[] = []
    let n = 0
    const result = await retryRegistryLag(async () => (++n < 3 ? { code: 1, output: ETARGET_HTTP } : { code: 0, output: '' }), {
      waits: [10, 20, 40], sleep: async (ms: number) => { slept.push(ms) }, log: () => {},
    })
    expect(result.code).toBe(0)
    expect(n).toBe(3)
    expect(slept).toEqual([10, 20])
  })

  it('ends at once on any other failure', async () => {
    let n = 0
    const result = await retryRegistryLag(async () => (n++, { code: 1, output: 'npm error code EACCES' }), noWait)
    expect(result).toEqual({ code: 1, output: 'npm error code EACCES' })
    expect(n).toBe(1)
  })

  it('gives up after the last wait with npm\'s last answer', async () => {
    let n = 0
    const lines: string[] = []
    const result = await retryRegistryLag(async () => (n++, { code: 1, output: ETARGET_STREAM }), { ...noWait, log: (l: string) => lines.push(l) })
    expect(result.code).toBe(1)
    expect(n).toBe(4)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('@aws-sdk/middleware-eventstream@^3.972.31')
  })
})

describe('npm-registry-lag · the command line', () => {
  it('passes the output through and exits with the command\'s code', () => {
    const ok = spawnSync(process.execPath, [CLI, fakeNpm(0, '')], { encoding: 'utf8' })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('added 1 package')
    fs.rmSync(path.join(tmp, 'runs'))
    const failed = spawnSync(process.execPath, [CLI, fakeNpm(5, 'npm error code EACCES')], { encoding: 'utf8' })
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('npm error code EACCES')
    expect(runs()).toBe(1)
  })

  it('reports a command that cannot start, and its usage', () => {
    const missing = spawnSync(process.execPath, [CLI, path.join(tmp, 'no-such-npm')], { encoding: 'utf8' })
    expect(missing.status).toBe(127)
    const usage = spawnSync(process.execPath, [CLI], { encoding: 'utf8' })
    expect(usage.status).toBe(2)
    expect(usage.stderr).toContain('usage:')
  })

  it('stops a command that outlives its deadline', async () => {
    const started = Date.now()
    const r = await runPassingThrough(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 })
    expect(r.code).toBe(1)
    expect(r.output).toContain('timed out after 300ms')
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})

describe('npm-registry-lag · every install of a published package goes through it', () => {
  it('the rehearsal\'s install runs again past a lagging dependency, reading only its own attempt', async () => {
    const w = new IsolatedWalnut({ work: tmp, name: 'iso', npm: fakeNpm(2, ETARGET_HTTP) })
    await w.install('open-walnut@0.0.0', ['open-walnut'], noWait)
    expect(runs()).toBe(3)
    const log = fs.readFileSync(w.logFile, 'utf8')
    expect(log.match(/^\$ .*install -g open-walnut@0\.0\.0/gm)).toHaveLength(3)
    expect(log).toContain('added 1 package')
  })

  it('the rehearsal\'s install stops at once on any other failure', async () => {
    const w = new IsolatedWalnut({ work: tmp, name: 'iso', npm: fakeNpm(5, 'npm error code EACCES') })
    // An earlier attempt's ETARGET in the same log must not count for this one.
    fs.mkdirSync(path.dirname(w.logFile), { recursive: true })
    fs.writeFileSync(w.logFile, `${ETARGET_HTTP}\n`)
    await expect(w.install('open-walnut@0.0.0', ['open-walnut'], noWait)).rejects.toThrow(/exited 1/)
    expect(runs()).toBe(1)
  })

  it('the archive build installs through it', () => {
    const build = fs.readFileSync(path.join(REPO, 'scripts/runtime-bundle/build.mjs'), 'utf8')
    expect(build).toMatch(/retryRegistryLag\(\(\) => runPassingThrough\(node, args, /)
    expect(build).not.toMatch(/execFileSync\(node, args\b/)
  })

  it('every workflow step that installs open-walnut from the registry goes through it', () => {
    const offenders: string[] = []
    let wrapped = 0
    for (const file of fs.readdirSync(path.join(REPO, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
      const doc = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows', file), 'utf8')) as { jobs: Record<string, { steps?: { run?: string }[] }> }
      for (const [job, { steps = [] }] of Object.entries(doc.jobs)) {
        for (const line of steps.flatMap((s) => (s.run ?? '').split('\n'))) {
          if (!/\bnpm install -g "?open-walnut/.test(line)) continue
          if (/node "?(\$GITHUB_WORKSPACE\/)?scripts\/npm-registry-lag\.mjs"? npm install -g/.test(line)) wrapped++
          else offenders.push(`${file} ${job}: ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(wrapped).toBeGreaterThanOrEqual(2)
  })

  it('the wrapper script is plain node, runnable before npm ci', () => {
    const src = fs.readFileSync(CLI, 'utf8')
    for (const m of src.matchAll(/^import .* from '([^']+)'/gm)) expect(m[1]).toMatch(/^node:/)
    expect(execFileSync(process.execPath, ['--check', CLI], { encoding: 'utf8' })).toBe('')
  })
})
