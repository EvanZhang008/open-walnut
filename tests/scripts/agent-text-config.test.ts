/**
 * The agent-text Playwright config names its specs in a testMatch so the main config leaves them
 * out (side-config-specs.ts). The projects it takes from the main config carry that same list as
 * their testIgnore, so unless it takes its own specs off, none of them runs under it ("No tests
 * found": the first review of the committed config ran nothing).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sideConfigSpecs, testMatchNames } from '../e2e/browser/side-config-specs'

const DIR = path.resolve(__dirname, '../e2e/browser')
const FILE = path.join(DIR, 'agent-text.config.ts')

describe('the agent-text Playwright config', () => {
  const own = testMatchNames(fs.readFileSync(FILE, 'utf8')).map((name) => `**/${name}`)

  it('names specs that exist', () => {
    expect(own.length).toBeGreaterThan(0)
    for (const glob of own) expect(fs.existsSync(path.join(DIR, glob.slice(3))), glob).toBe(true)
  })

  it('leaves none of its own specs in a testIgnore, top level or project', async () => {
    const config = (await import('../e2e/browser/agent-text.config')).default
    const ignores = [config.testIgnore, ...(config.projects ?? []).map((project) => project.testIgnore)]
    expect(ignores.length).toBeGreaterThan(1)
    for (const ignore of ignores) {
      const globs = (Array.isArray(ignore) ? ignore : ignore ? [ignore] : []).map(String)
      for (const glob of own) expect(globs, glob).not.toContain(glob)
    }
  })

  it('runs only its own specs: no project brings a testMatch of its own (the host-fixture projects)', async () => {
    const config = (await import('../e2e/browser/agent-text.config')).default
    expect((config.projects ?? []).length).toBeGreaterThan(0)
    for (const project of config.projects ?? []) expect(project.testMatch, project.name).toBeUndefined()
  })

  it('is left out of the main config, which still ignores every other side config', () => {
    const left = sideConfigSpecs(DIR)
    for (const glob of own) expect(left, glob).toContain(glob)
  })
})
