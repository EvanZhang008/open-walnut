import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

// Every CI run installs the dependencies in about 30 jobs at once. With no shared
// package store each one downloaded every tarball from the npm registry, which
// then rate-limited them ("registry asked to wait 60s"): installs of 20 to 40
// minutes ran jobs into their timeouts in 6 of 12 runs (2026-10-28, run
// 40673940417). bun's store, restored from the Actions cache, holds every tarball
// the two lockfiles name, so a warm install fetches nothing (measured with all
// outbound network denied). The store is set on the install step alone, so later
// steps that act as a fresh user never see it.
const ROOT = path.resolve(__dirname, '../..')
const WORKFLOWS = path.join(ROOT, '.github/workflows')
const STORE = '${{ runner.temp }}/bun-store'
const KEY_PREFIX = 'bun-store-${{ runner.os }}-${{ runner.arch }}-'
const KEY = `${KEY_PREFIX}\${{ hashFiles('bun.lock', 'web/bun.lock') }}`

// Jobs whose install stays cold on purpose, with why.
const COLD = new Map([
  ['ci.yml:onboarding', 'a fresh machine running the README install command, as a new user does'],
])

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> }

function installSteps() {
  const found: { where: string; job: string; steps: Step[]; at: number }[] = []
  for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
    const wf = parseYaml(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'))
    for (const [job, def] of Object.entries<{ steps?: Step[] }>(wf.jobs ?? {})) {
      const steps = def.steps ?? []
      steps.forEach((s, at) => {
        if (/^bun install\b/m.test(s.run ?? '')) found.push({ where: `${file}:${job}`, job, steps, at })
      })
    }
  }
  return found
}

describe('CI installs from a shared bun package store', () => {
  const sites = installSteps()

  it('finds the installs', () => {
    expect(sites.length).toBeGreaterThan(10)
  })

  it('every install restores the store first and installs into it', () => {
    const bad: string[] = []
    for (const { where, steps, at } of sites) {
      if (COLD.has(where)) continue
      const install = steps[at]!
      const cache = steps.slice(0, at).find((s) => s.uses?.startsWith('actions/cache@'))
      if (!cache) { bad.push(`${where}: no actions/cache step before the install`); continue }
      if (cache.with?.path !== STORE || cache.with?.key !== KEY || cache.with?.['restore-keys'] !== KEY_PREFIX) {
        bad.push(`${where}: the cache step is not the bun store (${JSON.stringify(cache.with)})`)
      }
      if (cache.if !== install.if) bad.push(`${where}: the cache step and the install run under different conditions`)
      if (install.env?.BUN_INSTALL_CACHE_DIR !== STORE) bad.push(`${where}: the install does not set BUN_INSTALL_CACHE_DIR to the store`)
    }
    expect(bad).toEqual([])
  })

  it('the cold installs are the listed ones, and still exist', () => {
    const cold = sites.filter((s) => !s.steps.slice(0, s.at).some((x) => x.uses?.startsWith('actions/cache@')))
    expect(cold.map((s) => s.where).sort()).toEqual([...COLD.keys()].sort())
  })

  it('no install downloads onnxruntime-node\'s CUDA provider', () => {
    // It is about 240 MB from api.nuget.org on every Linux x64 install, outside the store,
    // and Walnut never uses it; a nuget timeout failed a job before its tests (2026-10-28).
    const bad: string[] = []
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      const wf = parseYaml(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'))
      for (const [job, def] of Object.entries<{ env?: Record<string, string>; steps?: Step[] }>(wf.jobs ?? {})) {
        for (const step of def.steps ?? []) {
          if (!/^bun install\b/m.test(step.run ?? '')) continue
          const skip = step.env?.ONNXRUNTIME_NODE_INSTALL ?? def.env?.ONNXRUNTIME_NODE_INSTALL ?? wf.env?.ONNXRUNTIME_NODE_INSTALL
          if (skip !== 'skip') bad.push(`${file}:${job}`)
        }
      }
    }
    expect(bad, 'set ONNXRUNTIME_NODE_INSTALL: skip in the workflow env').toEqual([])
  })

  it('no workflow sets the store for a whole job or workflow', () => {
    for (const file of fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml'))) {
      const wf = parseYaml(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'))
      expect(wf.env?.BUN_INSTALL_CACHE_DIR, file).toBeUndefined()
      for (const [job, def] of Object.entries<{ env?: Record<string, string> }>(wf.jobs ?? {})) {
        expect(def.env?.BUN_INSTALL_CACHE_DIR, `${file}:${job}`).toBeUndefined()
      }
    }
  })
})
