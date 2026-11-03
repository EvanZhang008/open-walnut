/**
 * On macOS, a local test run never turns off the machine-wide brakes.
 *
 * 2026-11-03: four agent sessions ran WebKit Playwright on a developer's Mac with
 * PW_IGNORE_LOAD=1 and PW_TEST_PORT=3491 (around the :3457 lease) while its load sat
 * at 160 to 469; the Mac's WindowServer crashed that afternoon and logged its user out.
 * A Bash hook outside this repo already refuses such command lines, but it cannot see
 * one inside `bash -c` or a script file, so the test entry points refuse it too:
 * `maxWorkers()` (every vitest config) and `perRunWorkers()` (playwright.config.ts).
 *
 * Refused on darwin, unless this is a real hosted CI runner:
 *   PW_IGNORE_LOAD     skips the wait for the load to drop
 *   PW_NO_GATE=1       skips the :3457 run lease (the queue of Playwright runs)
 *   PW_TEST_PORT       anything but 3457 moves the fixture around that lease
 *   CI                 skips the load wait and raises vitest to 4 workers
 *   WALNUT_TEST_WORKERS > 1, PW_WORKERS > 1, --workers / -j / --maxWorkers > 1
 * Linux (a dev host, a container, CI) is never touched: these settings are fine there.
 *
 * "Real CI" is not the CI variable (anyone can set it): a GitHub-hosted runner sets
 * GITHUB_ACTIONS=true, its own RUNNER_TEMP directory and ImageOS together.
 * A person who knowingly wants a brake off on their own idle Mac sets
 * WALNUT_MAC_BRAKES=off for that run.
 */

import fs from 'node:fs'

export interface BrakeContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  argv: readonly string[]
  /** Does this directory exist (RUNNER_TEMP check); injectable for tests. */
  dirExists?: (dir: string) => boolean
}

const WORKER_FLAGS = ['--workers', '-j', '--maxWorkers', '--max-workers']

function dirExistsReal(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** A GitHub-hosted runner, not a local shell that set CI=1. */
export function realCi(env: NodeJS.ProcessEnv, dirExists = dirExistsReal): boolean {
  return env.GITHUB_ACTIONS === 'true' && !!env.ImageOS && !!env.RUNNER_TEMP && dirExists(env.RUNNER_TEMP)
}

function int(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(String(v).replace(/%$/, ''))
  return Number.isFinite(n) ? n : null
}

function workerFlagValues(argv: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  argv.forEach((a, i) => {
    const eq = a.indexOf('=')
    const key = eq > 0 ? a.slice(0, eq) : a
    if (!WORKER_FLAGS.includes(key)) return
    out.push([key, eq > 0 ? a.slice(eq + 1) : (argv[i + 1] ?? '')])
  })
  return out
}

/** Every brake this run turns off, in plain words; empty when the run may start. */
export function macBrakeViolations(ctx: BrakeContext): string[] {
  const { platform, env, argv } = ctx
  if (platform !== 'darwin' || env.WALNUT_MAC_BRAKES === 'off') return []
  if (realCi(env, ctx.dirExists)) return []
  const out: string[] = []
  const ignore = env.PW_IGNORE_LOAD
  if (ignore !== undefined && ignore !== '' && ignore !== '0') out.push('PW_IGNORE_LOAD skips the wait for the load to drop')
  if (env.PW_NO_GATE === '1') out.push('PW_NO_GATE skips the :3457 run lease, the queue that lets one Playwright run at a time')
  const port = env.PW_TEST_PORT
  if (port !== undefined && port !== '' && port !== '3457')
    out.push(`PW_TEST_PORT=${port} moves the fixture off :3457, around the lease that queues runs`)
  if (env.CI !== undefined && env.CI !== '') out.push('CI turns off the load wait and raises vitest to 4 workers')
  const tw = int(env.WALNUT_TEST_WORKERS)
  if (tw !== null && tw > 1) out.push(`WALNUT_TEST_WORKERS=${env.WALNUT_TEST_WORKERS} raises the one-worker test budget`)
  const pw = int(env.PW_WORKERS)
  if (pw !== null && pw > 1) out.push(`PW_WORKERS=${env.PW_WORKERS} starts that many browsers at once`)
  for (const [k, v] of workerFlagValues(argv)) {
    const n = int(v)
    if (n === null || n > 1) out.push(`${k} ${v} runs more than one worker at once`)
  }
  return out
}

export function macBrakeMessage(violations: readonly string[]): string {
  return [
    'This test run turns off a brake that keeps this Mac usable, and that is refused on macOS',
    '(2026-11-03: WebKit runs with PW_IGNORE_LOAD=1 and PW_TEST_PORT=3491 at load 160 to 469 came',
    "before the Mac's WindowServer crash):",
    '',
    ...violations.map((v) => `- ${v}`),
    '',
    'Run it on Linux instead (a remote dev host, a container, or CI), where these settings are fine.',
    'If it truly needs macOS (voice or recording WebKit specs, a macOS pixel layout, the Mac app),',
    'drop those settings and run it with one worker: it waits in the :3457 queue',
    '(`[pw-concurrency] ... Queuing` is normal) and for the load to drop, one run at a time.',
    'That wait is the point; do not work around it.',
  ].join('\n')
}

/** Throws before a test run starts on a Mac with a brake turned off. */
export function assertMacBrakes(ctx: BrakeContext = { platform: process.platform, env: process.env, argv: process.argv }): void {
  const v = macBrakeViolations(ctx)
  if (v.length) throw new Error(macBrakeMessage(v))
}
