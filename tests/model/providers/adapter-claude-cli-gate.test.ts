/**
 * The claude-cli adapter's process gate (ClaudeCliAdapter.withSlot): at most
 * MAX_CONCURRENT_CLI turns at once, a turn someone waits on goes ahead of
 * queued background turns, and background turns never hold the last slot.
 * Background turns run in the utility band once the deploy raised the server,
 * so they take longer, and with one FIFO an interactive turn queued behind
 * three of them (measured 2026-10-04 at load ~375: 5.7 s against 2.9 s).
 *
 * `claude` is a fake script: it logs its job name when it starts, waits for a
 * release file when its prompt asks it to hold, then answers one stream-json
 * result line. Every hold is bounded, so no process outlives the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeCliAdapter, MAX_CONCURRENT_CLI } from '../../../src/model/providers/adapter-claude-cli.js'
import type { AdapterCallOptions } from '../../../src/model/providers/types.js'

// Every process the adapter starts, counted: an aborted turn must start none
// (the fake would be killed before it could say so itself).
const spawned = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, spawn: ((...args: Parameters<typeof real.spawn>) => { spawned.n++; return real.spawn(...args) }) as typeof real.spawn }
})

let dir = ''
let fake = ''
let startLog = ''
let pending: Array<Promise<unknown>> = []
const names = new Set<string>()

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-gate-'))
  fake = path.join(dir, 'fake-claude.sh')
  startLog = path.join(dir, 'starts.log')
  fs.writeFileSync(fake, `#!/usr/bin/env bash
p=$(cat)
job=$(printf '%s' "$p" | grep -o 'job-[a-z0-9]*' | head -1)
echo "$job" >> ${JSON.stringify(startLog)}
if printf '%s' "$p" | grep -q 'hold-please'; then
  n=0
  while [ ! -e ${JSON.stringify(dir)}/"release-$job" ] && [ $n -lt 1200 ]; do sleep 0.05; n=$((n + 1)); done
fi
echo '{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":1,"output_tokens":1}}'
`, { mode: 0o755 })
  pending = []
  names.clear()
})

afterEach(async () => {
  for (const n of names) fs.writeFileSync(path.join(dir, `release-${n}`), '')
  await Promise.allSettled(pending)
  fs.rmSync(dir, { recursive: true, force: true })
})

const adapterCall = (job: string, purpose: AdapterCallOptions['purpose'], hold: boolean, signal?: AbortSignal): AdapterCallOptions => ({
  providerConfig: { api: 'claude-cli', claude_cli_command: fake },
  model: 'haiku', maxTokens: 64, system: 'Answer.',
  messages: [{ role: 'user', content: `${job}${hold ? ' hold-please' : ''}` }],
  purpose,
  ...(signal ? { signal } : {}),
})

/** Start one turn; its promise is awaited in afterEach whatever the test does. */
function run(adapter: ClaudeCliAdapter, job: string, purpose: AdapterCallOptions['purpose'], hold: boolean, signal?: AbortSignal) {
  names.add(job)
  const p = adapter.sendMessage(adapterCall(job, purpose, hold, signal))
  pending.push(p)
  return p
}
const release = (job: string): void => { fs.writeFileSync(path.join(dir, `release-${job}`), '') }
const starts = (): string[] => (fs.existsSync(startLog) ? fs.readFileSync(startLog, 'utf8').split('\n').filter(Boolean) : [])

/** Poll until `ok()` holds (a spawn under load can take a second), else fail with `what`. */
async function until(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what} (starts: ${starts().join(',')})`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
/** Give a turn that should NOT start a fair chance to start anyway. */
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))

describe('claude-cli adapter process gate', () => {
  it('runs at most three turns at once', () => {
    expect(MAX_CONCURRENT_CLI).toBe(3)
  })

  it('a turn someone waits on does not queue behind background turns (fails with one FIFO for every purpose)', async () => {
    const adapter = new ClaudeCliAdapter()
    // Three background turns that hold their process until released: a burst
    // of task creates, each with its ledger description.
    for (const j of ['job-bga', 'job-bgb', 'job-bgc']) void run(adapter, j, 'background', true)
    await until(() => starts().length >= 2, 'two background turns running')
    const interactive = run(adapter, 'job-ia', 'interactive', false)
    const answered = await Promise.race([
      interactive.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 15_000)),
    ])
    expect(answered).toBe(true)
    // It went through while every background turn was still held, and the
    // third background turn is still waiting for a slot.
    expect(starts()).toContain('job-ia')
    expect(starts()).not.toContain('job-bgc')
    release('job-bga')
    await until(() => starts().includes('job-bgc'), 'the third background turn once one finished')
  })

  it('a freed slot goes to the queued interactive turn before the background one queued earlier', async () => {
    const adapter = new ClaudeCliAdapter()
    void run(adapter, 'job-bga', 'background', true)
    void run(adapter, 'job-bgb', 'background', true)
    void run(adapter, 'job-ia', 'interactive', true)
    await until(() => starts().length === 3, 'three turns running')
    expect(adapter._gateStateForTesting().inFlight).toBe(3)
    void run(adapter, 'job-bgc', 'background', true)
    await until(() => adapter._gateStateForTesting().waiting === 1, 'the background turn queued')
    void run(adapter, 'job-ib', 'interactive', true)
    await until(() => adapter._gateStateForTesting().waiting === 2, 'the interactive turn queued')
    release('job-bga')
    await until(() => starts().includes('job-ib'), 'the interactive turn started')
    await settle()
    expect(starts()).not.toContain('job-bgc')
    expect(adapter._gateStateForTesting()).toMatchObject({ inFlight: 3, waiting: 1, backgroundInFlight: 1, backgroundWaiting: 1 })
    // An interactive turn ends: the background slot is free again.
    release('job-ia')
    await until(() => starts().includes('job-bgc'), 'the background turn started')
    expect(starts().slice(3)).toEqual(['job-ib', 'job-bgc'])
  })

  it('background turns leave the last slot free even with nothing else queued', async () => {
    const adapter = new ClaudeCliAdapter()
    for (const j of ['job-bga', 'job-bgb', 'job-bgc']) void run(adapter, j, 'background', true)
    await until(() => starts().length === 2, 'two background turns running')
    await settle()
    expect(starts()).toHaveLength(2)
    expect(adapter._gateStateForTesting()).toMatchObject({ inFlight: 2, waiting: 1, backgroundInFlight: 2, backgroundWaiting: 1 })
  })

  it('a background turn queued past its longest wait goes ahead of a queued interactive turn, one at a time', async () => {
    // A steady stream of interactive turns keeps one queued at every release,
    // so without the wait limit the background turn would get no slot at all.
    const adapter = new ClaudeCliAdapter({ backgroundMaxWaitMs: 300 })
    void run(adapter, 'job-bga', 'background', true)
    void run(adapter, 'job-ia', 'interactive', true)
    void run(adapter, 'job-ib', 'interactive', true)
    await until(() => starts().length === 3, 'three turns running')
    void run(adapter, 'job-bgb', 'background', true)
    await until(() => adapter._gateStateForTesting().waiting === 1, 'the background turn queued')
    await settle(500)
    void run(adapter, 'job-ic', 'interactive', true)
    await until(() => adapter._gateStateForTesting().waiting === 2, 'the interactive turn queued')
    // A background turn already runs: the aged one does not take a second slot
    // from the interactive turns.
    release('job-ia')
    await until(() => starts().includes('job-ic'), 'the interactive turn took the freed slot')
    await settle()
    expect(starts()).not.toContain('job-bgb')
    void run(adapter, 'job-id', 'interactive', true)
    await until(() => adapter._gateStateForTesting().waiting === 2, 'another interactive turn queued')
    // No background turn runs any more: the aged one goes ahead.
    release('job-bga')
    await until(() => starts().includes('job-bgb'), 'the background turn that waited longest started')
    await settle()
    expect(starts()).not.toContain('job-id')
    expect(adapter._gateStateForTesting()).toMatchObject({ inFlight: 3, waiting: 1, backgroundInFlight: 1, backgroundWaiting: 0 })
    void run(adapter, 'job-bgc', 'background', true)
    await until(() => adapter._gateStateForTesting().backgroundWaiting === 1, 'a third background turn queued')
    await settle(500)
    release('job-ib')
    await until(() => starts().includes('job-id'), 'the interactive turn took the freed slot')
    await settle()
    expect(starts()).not.toContain('job-bgc')
    release('job-bgb')
    await until(() => starts().includes('job-bgc'), 'the third background turn once the aged one finished')
  })

  it('with one slot (WALNUT_CLAUDE_CLI_CONCURRENCY=1) background turns still run, after queued interactive ones', async () => {
    vi.stubEnv('WALNUT_CLAUDE_CLI_CONCURRENCY', '1')
    vi.resetModules()
    const one = await import('../../../src/model/providers/adapter-claude-cli.js')
    vi.unstubAllEnvs()
    expect(one.MAX_CONCURRENT_CLI).toBe(1)
    const adapter = new one.ClaudeCliAdapter()
    // Nothing else queued: the only slot is the background turn's (a cap of
    // zero would hold every title and summary forever).
    void run(adapter, 'job-bga', 'background', true)
    await until(() => starts().includes('job-bga'), 'a background turn on the only slot')
    void run(adapter, 'job-bgb', 'background', false)
    await until(() => adapter._gateStateForTesting().waiting === 1, 'the second background turn queued')
    void run(adapter, 'job-ia', 'interactive', false)
    await until(() => adapter._gateStateForTesting().waiting === 2, 'the interactive turn queued')
    release('job-bga')
    await until(() => starts().includes('job-bgb'), 'the second background turn ran')
    expect(starts()).toEqual(['job-bga', 'job-ia', 'job-bgb'])
  })

  it('a queued turn whose signal aborts leaves the queue and never spawns', async () => {
    const adapter = new ClaudeCliAdapter()
    void run(adapter, 'job-bga', 'background', true)
    void run(adapter, 'job-bgb', 'background', true)
    void run(adapter, 'job-ia', 'interactive', true)
    await until(() => starts().length === 3, 'three turns running')
    const ctl = new AbortController()
    const queued = run(adapter, 'job-ib', 'interactive', false, ctl.signal)
    await until(() => adapter._gateStateForTesting().waiting === 1, 'the turn queued')
    const before = spawned.n
    ctl.abort()
    const r = await queued
    expect((r as { aborted?: boolean }).aborted).toBe(true)
    expect(spawned.n).toBe(before)
    expect(adapter._gateStateForTesting()).toMatchObject({ inFlight: 3, waiting: 0 })
    // Freeing a slot now starts nobody, and the aborted turn never ran.
    release('job-ia')
    await until(() => adapter._gateStateForTesting().inFlight === 2, 'the interactive turn finished')
    await settle()
    expect(starts()).not.toContain('job-ib')
    // An already aborted signal never queues at all.
    const pre = new AbortController(); pre.abort()
    void run(adapter, 'job-bgc', 'background', true)
    await until(() => adapter._gateStateForTesting().waiting === 1, 'a background turn queued behind the cap')
    const n = spawned.n
    expect(((await run(adapter, 'job-ic', 'background', false, pre.signal)) as { aborted?: boolean }).aborted).toBe(true)
    expect(spawned.n).toBe(n)
    expect(adapter._gateStateForTesting().waiting).toBe(1)
    expect(starts()).not.toContain('job-ic')
  })
})
