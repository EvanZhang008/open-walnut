/**
 * A lease on one shared fixture record, held by one test at a time across every worker of a run.
 *
 * The fixture server has ONE record per fixture session, and a spec that writes one resets it
 * first. Run fullyParallel, another worker's reset landed in the middle of a test: N39's
 * `Removed · Undo` placeholder was drawn, then went 2.5 s later when three other tests of the
 * dense session reset it on their workers (2026-11-02, session-thread-fixes-r3 on CI). So a reset
 * takes the session's lease first and keeps it until its test ends.
 *
 * A lease is a file made with O_EXCL in the run's temp dir, naming the worker that holds it; one
 * whose worker is gone, or older than a test can run, is broken. Waiting for it adds to the test's
 * time limit, so a queue of tests on one session never times one of them out.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test as base } from '@playwright/test'

const DIR = path.join(os.tmpdir(), 'walnut-pw-fixture-leases')
/** Longer than any test may run (the longest set timeout is 300 s, plus retries of hooks). */
const STALE_MS = 15 * 60_000
const WAIT_LIMIT_MS = 10 * 60_000

interface Held { file: string; key: string }
let held: Held[] | null = null

const fileOf = (key: string) => path.join(DIR, `${encodeURIComponent(key)}.lease`)

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

function tryTake(file: string, owner: string): boolean {
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, owner)
    fs.closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  try {
    const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: number }
    if (!alive(pid) || Date.now() - at > STALE_MS) fs.rmSync(file, { force: true })
  } catch {
    // Half written by its taker, or gone already: look again on the next turn.
  }
  return false
}

async function take(key: string): Promise<Held> {
  fs.mkdirSync(DIR, { recursive: true })
  const file = fileOf(key)
  const info = base.info()
  const owner = JSON.stringify({ pid: process.pid, at: Date.now(), test: info.titlePath.join(' > ') })
  const start = Date.now()
  while (!tryTake(file, owner)) {
    if (Date.now() - start > WAIT_LIMIT_MS) {
      const holder = (() => { try { return fs.readFileSync(file, 'utf8') } catch { return 'gone' } })()
      throw new Error(`waited ${WAIT_LIMIT_MS / 1000} s for the fixture lease on ${key}, held by ${holder}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  const waited = Date.now() - start
  if (waited > 50 && info.timeout > 0) info.setTimeout(info.timeout + waited)
  return { file, key }
}

/**
 * Run `write` under the lease on `key`. Inside a test (its hooks included) the lease stays until
 * the test ends, so nobody resets the record under it; in a beforeAll / afterAll it is held for the
 * write alone, and so it is in a test that does not come from `test` here (threads-helpers.ts
 * re-exports it; tests/scripts/browser-spec-ratchets.test.ts holds every resetting spec to it).
 */
export async function withFixtureLease<T>(key: string, write: () => Promise<T>): Promise<T> {
  if (held) {
    if (!held.some((one) => one.key === key)) held.push(await take(key))
    return write()
  }
  const lease = await take(key)
  try { return await write() } finally { fs.rmSync(lease.file, { force: true }) }
}

/** `test` whose every test lets its fixture leases go when it ends. */
export const test = base.extend<{ fixtureLeases: void }>({
  fixtureLeases: [async ({}, use) => {
    held = []
    try {
      await use()
    } finally {
      for (const one of held ?? []) fs.rmSync(one.file, { force: true })
      held = null
    }
  }, { auto: true }],
})
