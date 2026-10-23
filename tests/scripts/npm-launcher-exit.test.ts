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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { candidateTargets } from '../../scripts/npm-launcher/launch.js'

const ROOT = path.resolve(__dirname, '../..')
let tmp: string
let entry: string

/** An npm global prefix holding the launcher and a platform package whose `walnut` is `script`. */
function layout(script: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'prefix-'))
  const pkg = path.join(dir, 'node_modules', 'open-walnut')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/npm-launcher/launch.js'), path.join(pkg, 'lib', 'launch.js'))
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"open-walnut","type":"module"}\n')
  fs.writeFileSync(path.join(pkg, 'bin', 'open-walnut.js'), "import { launch } from '../lib/launch.js'\nlaunch(import.meta.url)\n")
  const target = candidateTargets()[0]!
  const platform = path.join(dir, 'node_modules', '@open-walnut', target)
  fs.mkdirSync(platform, { recursive: true })
  fs.writeFileSync(path.join(platform, 'package.json'), `{"name":"@open-walnut/${target}"}\n`)
  fs.writeFileSync(path.join(platform, 'walnut'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return path.join(pkg, 'bin', 'open-walnut.js')
}

const node = process.env.WALNUT_TEST_NODE || 'node'
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
})
