#!/usr/bin/env node
/**
 * npm serves a new version of a package before every dependency it names: a
 * family published together (the AWS SDK puts out hundreds of packages at once)
 * reaches the registry one package at a time over several minutes, and an install
 * that resolves inside that window fails with ETARGET for a version that is there
 * minutes later. 2026-10-09: nine CI jobs failed on
 * `@aws-sdk/credential-provider-http@^3.972.75` and
 * `@aws-sdk/middleware-eventstream@^3.972.31`, three to six minutes after both
 * were published.
 *
 * So an install that fails with npm's "No matching version found" runs again
 * after a wait; any other failure is the install's own and ends at once.
 *
 *   node scripts/npm-registry-lag.mjs <command> [args...]
 *     runs the command with its output passed through, and again after 1, 2 and
 *     4 minutes while npm names a version it does not serve yet.
 *
 * Ratchet: tests/scripts/npm-registry-lag.test.ts
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The wait before each new attempt, in ms: about seven minutes in all. */
export const LAG_WAITS_MS = [60_000, 120_000, 240_000]

/** How much of a command's output is kept to read npm's verdict from. */
const TAIL_CHARS = 64 * 1024

/** The dependency npm could not find, when `output` is npm's ETARGET failure; otherwise null. */
export function missingVersion(output) {
  if (!/\b(?:ETARGET|notarget)\b/.test(output)) return null
  const m = /No matching version found for (\S+?)\.?(?:\s|$)/.exec(output)
  return m ? m[1] : null
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `attempt` (resolving `{ code, output }`) until it succeeds, fails for any
 * other reason, or the waits run out. Resolves the last attempt's result.
 */
export async function retryRegistryLag(attempt, { waits = LAG_WAITS_MS, sleep = sleepMs, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  for (let i = 0; ; i++) {
    const result = await attempt()
    const missing = result.code === 0 ? null : missingVersion(result.output)
    if (!missing || i >= waits.length) return result
    log(`npm does not serve ${missing} yet (a publish still reaching the registry); trying again in ${waits[i] / 1000}s`)
    await sleep(waits[i])
  }
}

/**
 * Run a command with its output passed through to ours, keeping the tail of it.
 * Resolves `{ code, output }`; a command killed by a signal or by `timeoutMs` is code 1.
 */
export function runPassingThrough(cmd, args, { env = process.env, cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let tail = ''
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-TAIL_CHARS) }
    const child = spawn(cmd, args, { env, cwd, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); keep(chunk) })
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); keep(chunk) })
    const timer = timeoutMs ? setTimeout(() => { keep(`\n[timed out after ${timeoutMs}ms]\n`); child.kill('SIGTERM') }, timeoutMs) : null
    // A command that cannot start ends in 'error', and maybe also in 'close'.
    let settled = false
    const settle = (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ code, output: tail })
    }
    child.on('error', (err) => { keep(`${err.message}\n`); settle(127) })
    child.on('close', (code) => settle(code === null || code < 0 ? 1 : code))
  })
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd) {
    process.stderr.write('usage: npm-registry-lag.mjs <command> [args...]\n')
    process.exit(2)
  }
  const annotate = process.env.GITHUB_ACTIONS === 'true' ? '::warning title=npm registry::' : ''
  const { code } = await retryRegistryLag(() => runPassingThrough(cmd, args), {
    log: (line) => process.stderr.write(`${annotate}${line}\n`),
  })
  process.exit(code)
}
