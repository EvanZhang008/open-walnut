/**
 * `walnut update`: the plan for every install kind, and the run with every
 * side effect stubbed (the installer is never spawned here; the test asserts
 * the argv it would get).
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-update-cmd'))

import { parseChannel, planUpdate, runUpdateWith, type UpdateDeps } from '../../src/commands/update.js'
import type { UpdateStatus } from '../../src/core/self-update/update-check.js'
import { INSTALL_SCRIPT_PACKAGES } from '../../src/core/self-update/install-kind.js'

const ALLOW = `--allow-scripts=${INSTALL_SCRIPT_PACKAGES.join(',')}`

const NPM_UP_TO_DATE: UpdateStatus = {
  enabled: true,
  install: { kind: 'npm', sourceDir: null, packageRoot: '/usr/local/lib/node_modules/open-walnut', manager: 'npm', updateCommand: 'npm install -g open-walnut@latest' },
  current: '0.5.1', channel: 'stable', latest: '0.5.1', tags: { latest: '0.5.1', nightly: null }, available: false,
  checkedAt: '2026-09-30T10:00:00.000Z', error: null, checking: false,
  packageUrl: 'https://www.npmjs.com/package/open-walnut',
}
const NPM_NEWER: UpdateStatus = { ...NPM_UP_TO_DATE, latest: '0.6.0', tags: { latest: '0.6.0', nightly: null }, available: true }
const NIGHTLY_NEWER: UpdateStatus = {
  ...NPM_UP_TO_DATE, current: '0.6.1-nightly.20261001.4', channel: 'nightly', latest: '0.6.1-nightly.20261002.1',
  tags: { latest: '0.6.0', nightly: '0.6.1-nightly.20261002.1' }, available: true,
  install: { ...NPM_UP_TO_DATE.install, updateCommand: 'npm install -g open-walnut@nightly' },
}
const SOURCE: UpdateStatus = {
  ...NPM_UP_TO_DATE, enabled: false, reason: 'source', latest: null, checkedAt: null,
  install: { kind: 'source', sourceDir: '/Users/alice/open-walnut', packageRoot: '/Users/alice/open-walnut', manager: null, updateCommand: null },
}
const REPLICA: UpdateStatus = { ...SOURCE, reason: 'replica', install: { ...SOURCE.install, kind: 'replica', sourceDir: null } }
const OTHER_NEWER: UpdateStatus = { ...NPM_NEWER, install: { kind: 'other', sourceDir: null, packageRoot: '/opt/open-walnut', manager: null, updateCommand: null } }
const UNREACHABLE: UpdateStatus = { ...NPM_UP_TO_DATE, latest: null, checkedAt: null, error: 'fetch failed' }

describe('parseChannel', () => {
  it('accepts stable and nightly, nothing else', () => {
    expect(parseChannel(undefined)).toBeUndefined()
    expect(parseChannel('stable')).toBe('stable')
    expect(parseChannel('nightly')).toBe('nightly')
    expect(() => parseChannel('beta')).toThrow('--channel must be stable or nightly')
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

  it('says when the current release is the newest, and names the other channel when it has one', () => {
    expect(planUpdate(NPM_UP_TO_DATE, { check: false })).toEqual({ exitCode: 0, lines: ['Open Walnut 0.5.1 is the newest (0.5.1).'] })
    const withNightly = planUpdate({ ...NPM_UP_TO_DATE, tags: { latest: '0.5.1', nightly: '0.5.2-nightly.20261001.1' } }, { check: false })
    expect(withNightly.lines).toEqual([
      'Open Walnut 0.5.1 is the newest (0.5.1).',
      'The nightly channel is at 0.5.2-nightly.20261001.1: walnut update --channel nightly',
    ])
  })

  it('a nightly build installs the exact newer nightly and says so', () => {
    const plan = planUpdate(NIGHTLY_NEWER, { check: false })
    expect(plan.install).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.1-nightly.20261002.1', ALLOW] })
    expect(plan.lines[0]).toBe('A newer Open Walnut is available on the nightly channel: 0.6.1-nightly.20261001.4 → 0.6.1-nightly.20261002.1.')
    expect(planUpdate(NIGHTLY_NEWER, { check: true }).lines[1]).toBe('Run: npm install -g open-walnut@nightly')
  })

  it('installs the exact newer version through the manager that installed Walnut', () => {
    const plan = planUpdate(NPM_NEWER, { check: false })
    expect(plan.install).toEqual({ file: 'npm', args: ['install', '-g', 'open-walnut@0.6.0', ALLOW] })
    expect(plan.lines).toEqual([
      'A newer Open Walnut is available: 0.5.1 → 0.6.0.',
      `Running: npm install -g open-walnut@0.6.0 ${ALLOW}`,
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
  const checkNow = vi.fn(async () => status)
  const d: UpdateDeps = {
    checkNow,
    run,
    serverRunning: async () => false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  }
  return { d, out, err, run, checkNow }
}

describe('runUpdateWith', () => {
  it('runs the installer and reports success; mentions a running server that still has the old code', async () => {
    const { d, out, run } = deps(NPM_NEWER, { serverRunning: async () => true })
    const code = await runUpdateWith({}, { json: false }, d)
    expect(code).toBe(0)
    expect(run).toHaveBeenCalledWith('npm', ['install', '-g', 'open-walnut@0.6.0', ALLOW])
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

  it('--channel is handed to the check; a bad channel is exit 2 before any network', async () => {
    const { d, checkNow } = deps(NPM_UP_TO_DATE)
    await runUpdateWith({ check: true, channel: 'nightly' }, { json: false }, d)
    expect(checkNow).toHaveBeenCalledWith('nightly')
    const bad = deps(NPM_UP_TO_DATE)
    expect(await runUpdateWith({ channel: 'beta' }, { json: false }, bad.d)).toBe(2)
    expect(bad.checkNow).not.toHaveBeenCalled()
    expect(bad.err[0]).toContain('--channel must be stable or nightly')
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
