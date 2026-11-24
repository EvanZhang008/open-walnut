/**
 * What the leader-switch-real-*.test.ts files share (docs/reference/leader-switch.md): one temp
 * root per file, two ports per scenario, the failed checks of a scenario, two worlds at once
 * (worldSlots), and the scaled permit for the files whose scenarios wait a record out.
 *
 * The scenarios themselves live in scripts/leader-switch/rehearsal.ts and stop-rehearsal.ts (the
 * rehearsal script runs the same, one line per check). They were one file until 2026-11-24, when it
 * took 1126 s of one CI shard (vitest shards by file): now each file holds a few of them, and a
 * file of several runs two worlds at once.
 *
 * Scaled permit (WALNUT_LEADER_PERMIT_VALID_MS, settings.ts permitParamsFor): the lease validMs 6 s
 * for the product's 60 s, renew, margins and back-off scaled with it. Honoured only when every
 * witness is a witness dir, which is what makeWorld (scripts/leader-switch/world.ts) sets up. Set in
 * this process's environment for the whole file (useScaledPermit), so every process of its worlds
 * agrees on it: the servers, the switch command and its jobs inherit it (a witness dir refuses a
 * record of another validity: bad-validity). Only files whose scenarios wait a record out take it
 * (a rollback, a cancel, a take-back); a switch that commits keeps the product's lease, so its commit is a renew inside the
 * handover's lease as the product's is. Under the scaled lease a commit that comes later than 6 s
 * after the handover still stands as a renew: a witness dir counts a record from the first read of
 * the process that asks (the companion e2e's header, measured 2026-11-23), so the scenarios that
 * take it assert outcomes (done or rolled back, one leader, everything carried), never the path.
 */
import { afterAll, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Check } from '../../scripts/leader-switch/rehearsal.js'

/** The scaled lease (one test second for ten product seconds), as the companion e2e runs it. */
export const SCALED_PERMIT_VALID_MS = 6_000

/** A temp root for one file's worlds, opened (read-only standby copies) and removed after the file. */
export function realSwitchRoot(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `leader-switch-${name}-`))
  afterAll(() => {
    const open = (p: string) => {
      try { fs.chmodSync(p, 0o700); if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) open(path.join(p, e)) } catch { /* gone */ }
    }
    open(root)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

/** Two ports per scenario; `block` keeps the files apart when they run side by side on one host. */
export function portsFrom(block: number): () => { portA: number; portB: number } {
  let port = 4950 + block * 200 + (process.pid % 20) * 4
  return () => { port += 2; return { portA: port, portB: port + 1 } }
}

export const failed = (checks: Check[]): string[] => checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`)

/**
 * The scaled lease for every scenario of the file: set in this process's environment before the
 * first one starts (every child a world starts inherits it), the old value back after the last.
 */
export function useScaledPermit(): void {
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env.WALNUT_LEADER_PERMIT_VALID_MS
    process.env.WALNUT_LEADER_PERMIT_VALID_MS = String(SCALED_PERMIT_VALID_MS)
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.WALNUT_LEADER_PERMIT_VALID_MS
    else process.env.WALNUT_LEADER_PERMIT_VALID_MS = saved
  })
}

/**
 * How many worlds of one file run at once. Each world is its own root, ports and processes, so
 * two run side by side without sharing anything; most of a scenario's time is its servers' boots
 * and waits, so two at a time nearly halve a file's time on CI's 4-core runners. Not more: every
 * world runs two or three servers of its own.
 */
export const WORLDS_AT_ONCE = 2

/**
 * A scenario's run inside one of the file's WORLDS_AT_ONCE slots (declare the tests it.concurrent).
 * `budgetMs` is the scenario's own timeout, counted from when it gets its slot (what its test's
 * timeout was when the scenarios ran one by one); the test's own timeout covers the wait for a slot
 * too, so these files give it the file's whole budget.
 */
export function worldSlots(n = WORLDS_AT_ONCE): <T>(budgetMs: number, fn: () => Promise<T>) => Promise<T> {
  let free = n
  const waiting: Array<() => void> = []
  return async (budgetMs, fn) => {
    if (free > 0) free--
    else await new Promise<void>((r) => waiting.push(r))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the scenario ran past its ${budgetMs / 1000} s`)), budgetMs) }),
      ])
    } finally {
      clearTimeout(timer)
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}
