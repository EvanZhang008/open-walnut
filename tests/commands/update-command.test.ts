/**
 * `walnut update`: the plan for every install kind, and the run with every
 * side effect stubbed (the installer is never spawned here; the test asserts
 * the argv it would get).
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-update-cmd'))

import { installArgv, planUpdate, runUpdateWith, type UpdateDeps } from '../../src/commands/update.js'
import type { UpdateStatus } from '../../src/core/self-update/update-check.js'

const NPM_UP_TO_DATE: UpdateStatus = {
  enabled: true,
  install: { kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' },
  current: '0.5.1', latest: '0.5.1', available: false, checkedAt: '2026-09-30T10:00:00.000Z', error: null, checking: false,
  packageUrl: 'https://www.npmjs.com/package/open-walnut',
}
const NPM_NEWER: UpdateStatus = { ...NPM_UP_TO_DATE, latest: '0.6.0', available: true }
const SOURCE: UpdateStatus = {
  ...NPM_UP_TO_DATE, enabled: false, reason: 'source', latest: null, checkedAt: null,
  install: { kind: 'source', sourceDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut', manager: null, updateCommand: null },
}
const REPLICA: UpdateStatus = { ...SOURCE, reason: 'replica', install: { ...SOURCE.install, kind: 'replica', sourceDir: null } }
const OTHER_NEWER: UpdateStatus = { ...NPM_NEWER, install: { kind: 'other', sourceDir: null, packageRoot: '/opt/open-walnut', manager: null, updateCommand: null } }
const UNREACHABLE: UpdateStatus = { ...NPM_UP_TO_DATE, latest: null, checkedAt: null, error: 'fetch failed' }

describe('installArgv', () => {
  it('spells each manager\'s global install as argv (no shell)', () => {
    expect(installArgv('npm', 'open-walnut@0.6.0')).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0'] })
    expect(installArgv('pnpm', 'open-walnut@0.6.0')).toEqual({ file: 'pnpm', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(installArgv('bun', 'open-walnut@0.6.0')).toEqual({ file: 'bun', args: ['add', '-g', 'open-walnut@0.6.0'] })
    expect(installArgv('yarn', 'open-walnut@0.6.0')).toEqual({ file: 'yarn', args: ['global', 'add', 'open-walnut@0.6.0'] })
  })
})

describe('planUpdate', () => {
  it('tells a source checkout the git steps and runs nothing', () => {
    const plan = planUpdate(SOURCE, { check: false })
    expect(plan.install).toBeUndefined()
    expect(plan.exitCode).toBe(0)
    expect(plan.lines[0]).toContain('source checkout (/Users/alice/open-walnut)')
    expect(plan.lines[1]).toBe('  cd /Users/alice/open-walnut && git pull && npm run build')
  })

  it('points a replica at the primary console', () => {
    expect(planUpdate(REPLICA, { check: false })).toMatchObject({ exitCode: 0, lines: [expect.stringContaining('cloud replica')] })
  })

  it('says when the current release is the newest', () => {
    expect(planUpdate(NPM_UP_TO_DATE, { check: false })).toEqual({ exitCode: 0, lines: ['Open Walnut 0.5.1 is the newest release.'] })
  })

  it('installs the exact newer version through the manager that installed Walnut', () => {
    const plan = planUpdate(NPM_NEWER, { check: false })
    expect(plan.install).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0'] })
    expect(plan.lines).toEqual([
      'A newer Open Walnut is available: 0.5.1 → 0.6.0.',
      'Running: npm install -g open-walnut@0.6.0',
    ])
  })

  it('--check reports the command without running it', () => {
    const plan = planUpdate(NPM_NEWER, { check: true })
    expect(plan.install).toBeUndefined()
    expect(plan.lines[1]).toBe('Run: npm install -g open-walnut@latest')
  })

  it('an install without a manager gets the package page', () => {
    const plan = planUpdate(OTHER_NEWER, { check: false })
    expect(plan.install).toBeUndefined()
    expect(plan.lines[1]).toContain('https://www.npmjs.com/package/open-walnut')
  })

  it('an unreachable registry is exit 1 with the reason', () => {
    expect(planUpdate(UNREACHABLE, { check: true })).toMatchObject({ exitCode: 1, lines: [expect.stringContaining('fetch failed')] })
  })

  it('an opted-out check says so', () => {
    const plan = planUpdate({ ...NPM_UP_TO_DATE, enabled: false, reason: 'opted-out', latest: null }, { check: false })
    expect(plan).toMatchObject({ exitCode: 0, lines: [expect.stringContaining('opted-out')] })
  })
})

function deps(status: UpdateStatus, over: Partial<UpdateDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const run = vi.fn(async () => 0)
  const d: UpdateDeps = {
    checkNow: async () => status,
    run,
    serverRunning: async () => false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  }
  return { d, out, err, run }
}

describe('runUpdateWith', () => {
  it('runs the installer and reports success; mentions a running server that still has the old code', async () => {
    const { d, out, run } = deps(NPM_NEWER, { serverRunning: async () => true })
    const code = await runUpdateWith({}, { json: false }, d)
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('npm', ['install', '-g', 'open-walnut@0.6.0'])
    expect(out[2]).toBe('Installed Open Walnut 0.6.0.')
    expect(out[3]).toContain('still runs 0.5.1 until it is restarted')
  })

  it('does not mention a server when none answers', async () => {
    const { d, out } = deps(NPM_NEWER)
    await runUpdateWith({}, { json: false }, d)
    expect(out).toHaveLength(3)
  })

  it('--check never runs the installer', async () => {
    const { d, run, out } = deps(NPM_NEWER)
    expect(await runUpdateWith({ check: true }, { json: false }, d)).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(out).toEqual(['A newer Open Walnut is available: 0.5.1 → 0.6.0.', 'Run: npm install -g open-walnut@latest'])
  })

  it('a failing installer is the exit code, and the version is reported unchanged', async () => {
    const { d, err } = deps(NPM_NEWER, { run: async () => 243 })
    expect(await runUpdateWith({}, { json: false }, d)).toBe(243)
    expect(err[0]).toBe('npm exited with 243; Open Walnut 0.5.1 is unchanged.')
  })

  it('an installer that cannot start is exit 1 with the reason', async () => {
    const { d, err } = deps(NPM_NEWER, { run: async () => { throw new Error('spawn npm ENOENT') } })
    expect(await runUpdateWith({}, { json: false }, d)).toBe(1)
    expect(err[0]).toBe('Could not run npm: spawn npm ENOENT')
  })

  it('a source checkout prints the steps and exits 0 without running anything', async () => {
    const { d, run, out } = deps(SOURCE)
    expect(await runUpdateWith({}, { json: false }, d)).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(out).toHaveLength(3)
  })

  it('an unreachable registry goes to stderr with exit 1', async () => {
    const { d, err, out } = deps(UNREACHABLE)
    expect(await runUpdateWith({}, { json: false }, d)).toBe(1)
    expect(out).toEqual([])
    expect(err[0]).toContain('Could not reach the npm registry')
  })

  it('--json prints the status with the plan', async () => {
    const { d, out } = deps(NPM_NEWER)
    await runUpdateWith({ check: true }, { json: true }, d)
    const parsed = JSON.parse(out[0]!) as { latest: string; plan: { install: unknown; lines: string[] } }
    expect(parsed.latest).toBe('0.6.0')
    expect(parsed.plan.install).toBeNull()
    expect(parsed.plan.lines).toHaveLength(2)
  })
})
