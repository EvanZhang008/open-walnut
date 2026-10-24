/**
 * The npm launcher (scripts/npm-launcher/launch.js) ends the way the file it
 * runs ended: the same code, or the same signal. A signal Node ignores
 * (SIGPIPE) cannot end it, so it exits with the shell's code for that signal
 * instead of 0: a pipeline must never read a killed Walnut as a success.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ENTRY } from '../../scripts/npm-packages.mjs'

const { startDir } = createRequire(import.meta.url)('../../scripts/npm-launcher/launch.js')

const ROOT = path.resolve(__dirname, '../..')
const node = process.env.WALNUT_TEST_NODE || 'node'
// The target the Node under test looks for (WALNUT_TEST_NODE may be another arch, under Rosetta say).
const TARGET = spawnSync(node, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(ROOT, 'scripts/npm-launcher/launch.js'))}).candidateTargets()[0])`], { encoding: 'utf8' }).stdout
let tmp: string
let entry: string

/** An npm global prefix holding the launcher and a platform package whose `walnut` is `script`. */
function layout(script: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'prefix-'))
  const pkg = path.join(dir, 'node_modules', 'open-walnut')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/npm-launcher/launch.js'), path.join(pkg, 'lib', 'launch.js'))
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"open-walnut","type":"commonjs"}\n')
  fs.writeFileSync(path.join(pkg, 'bin', 'open-walnut.js'), ENTRY())
  const target = TARGET
  const platform = path.join(dir, 'node_modules', '@open-walnut', target)
  fs.mkdirSync(platform, { recursive: true })
  fs.writeFileSync(path.join(platform, 'package.json'), `{"name":"@open-walnut/${target}"}\n`)
  fs.writeFileSync(path.join(platform, 'walnut'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return path.join(pkg, 'bin', 'open-walnut.js')
}

const run = (bin: string) => spawnSync(node, [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 })

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-launcher-exit-'))
  entry = layout('exit 0')
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('the npm launcher exits as its file did', () => {
  it('an exit code comes back as it is', () => {
    expect(run(entry).status).toBe(0)
    expect(run(layout('exit 3')).status).toBe(3)
  })

  it('a file killed by SIGTERM ends the launcher by SIGTERM', () => {
    const res = run(layout('kill -TERM $$'))
    expect(res.signal).toBe('SIGTERM')
  })

  it('a file killed by SIGPIPE, which Node ignores, ends it with 141, never 0', () => {
    const res = run(layout('kill -PIPE $$'))
    expect(res.signal).toBeNull()
    expect(res.status).toBe(128 + os.constants.signals.SIGPIPE)
  })

  it('a directory deleted under it (npm replaced the package it ran in) starts the file in the same path made again', () => {
    // A 0.6.x Mac app runs its server with the package root as its directory; its
    // update replaces that directory and restarts into the launcher, and bun will
    // not start in a deleted directory ("The current working directory was deleted").
    const bin = layout('/bin/pwd -P || exit 9')
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'cwd-')))
    const res = spawnSync('/bin/sh', ['-c', 'cd "$1" && rm -rf "$1" && mkdir "$1" && exec "$2" "$3"', 'sh', dir, node, bin], { encoding: 'utf8', timeout: 20_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe(dir)
  })

  it('a directory deleted under it and not made again starts the file in the package root, on Node 8 and 10 too', () => {
    // Node 8 and 10 read the working directory to resolve a relative require: the
    // entry and the launcher require by absolute path, so they get as far as startDir.
    const bin = layout('/bin/pwd -P || exit 9')
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'gone-')))
    const res = spawnSync('/bin/sh', ['-c', 'cd "$1" && rm -rf "$1" && PWD= exec "$2" "$3"', 'sh', dir, node, bin], { encoding: 'utf8', timeout: 20_000 })
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout.trim()).toBe(fs.realpathSync(path.dirname(path.dirname(bin))))
  })

  it('startDir: this directory while it exists, else PWD, else the package root, else home', () => {
    const gone = () => { throw Object.assign(new Error('ENOENT: process.cwd failed'), { code: 'ENOENT' }) }
    expect(startDir('/pkg', () => '/here', () => true)).toBe('/here')
    const pwd = process.env.PWD
    try {
      process.env.PWD = '/made/again'
      expect(startDir('/pkg', gone, (p: string) => p === '/made/again')).toBe('/made/again')
      expect(startDir('/pkg', gone, (p: string) => p === '/pkg')).toBe('/pkg')
      // The launcher's own node:os (createRequire skips the test's mocked one): under bun its
      // homedir() keeps the HOME the process started with, not the fake HOME the setup assigns.
      expect(startDir('/pkg', gone, () => false)).toBe(createRequire(import.meta.url)('node:os').homedir())
    } finally {
      if (pwd === undefined) delete process.env.PWD
      else process.env.PWD = pwd
    }
  })
})
