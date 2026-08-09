/**
 * Cloud-setup job state machine.
 *
 * Design under test: the job outlives the request that started it and must
 * survive a process restart, so most of these cases kill the runner at a step
 * boundary and re-enter through resumeCloudSetupJobIfAny() — asserting via the
 * fake driver's call counter that an expensive createVM never runs twice.
 *
 * A fake driver is injected into the real registry (_setCloudProviderDriverForTesting)
 * rather than mocking the module, so the job resolves it through the same
 * getDriver() path production uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-setup-job'))

// git-sync is the one real side effect the job has on the machine. Stub it and
// record the calls — a test must never touch the operator's data repo.
const gitCalls: { initSync: string[]; syncCount: number; lsRemote: number } = {
  initSync: [], syncCount: 0, lsRemote: 0,
}
let cloudRemote: { domain: string; token: string; secure: boolean } | null = null
let syncShouldFail = false
let lsRemoteAnswer: string | null = 'ref\tHEAD'

vi.mock('../../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentials: () => cloudRemote,
  // Faithful to the real thing: once initSync writes a credentialed remote,
  // getCloudRemoteCredentials() reports it. That is the signal claim-and-wire
  // uses to stay idempotent, so a fake that skipped it would hide the bug.
  initSync: (url?: string) => {
    if (!url) return
    gitCalls.initSync.push(url)
    const parsed = new URL(url)
    cloudRemote = { domain: parsed.host, token: parsed.password, secure: parsed.protocol === 'https:' }
  },
  sync: async () => {
    gitCalls.syncCount++
    if (syncShouldFail) throw new Error('push rejected')
    return { pulled: 0, pushed: 1, conflicts: 0 }
  },
  gitSafeAsync: async (args: string) => {
    if (args.startsWith('ls-remote')) { gitCalls.lsRemote++; return lsRemoteAnswer }
    return null
  },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  CloudSetupJobExistsError,
  _resetCloudSetupJobForTesting,
  cancelCloudSetupJob,
  deleteCloudSetupJob,
  getCloudSetupJob,
  provideCloudSetupInput,
  redactCloudSetupJob,
  resumeCloudSetupJobIfAny,
  retryCloudSetupJob,
  startCloudSetupJob,
} from '../../../src/core/cloud-setup/job.js'
import { CLOUD_SETUP_TIMINGS } from '../../../src/core/cloud-setup/steps.js'
import { sslipHostname } from '../../../src/core/cloud-setup/user-data.js'
import { _setCloudProviderDriverForTesting } from '../../../src/core/cloud-setup/providers/index.js'
import type { CloudProviderDriver, CreateVMParams } from '../../../src/core/cloud-setup/providers/types.js'
import type { CloudSetupJobState, CloudSetupProviderId } from '../../../src/core/cloud-setup/job-types.js'

// ── Fake box: answers /api/v1/setup/status + /claim over a stubbed fetch ─────

interface FakeBox {
  claimed: boolean
  bootedAfter: number
  claimCalls: Array<{ setupToken: string; deviceName: string }>
  statusCalls: number
  issuedToken: string
}
let box: FakeBox

function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/api/v1/setup/status')) {
      box.statusCalls++
      if (box.statusCalls <= box.bootedAfter) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ claimed: box.claimed }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.endsWith('/api/v1/setup/claim')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { setupToken: string; deviceName: string }
      box.claimCalls.push(body)
      if (box.claimed) {
        return new Response(JSON.stringify({ error: 'Instance already claimed' }), { status: 403 })
      }
      box.claimed = true
      return new Response(JSON.stringify({ deviceName: body.deviceName, token: box.issuedToken }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

// ── Fake drivers ────────────────────────────────────────────────────────────

interface FakeDriver extends CloudProviderDriver { createVMCalls: CreateVMParams[] }

function makeAutoDriver(opts: { ip?: string; failFirst?: boolean } = {}): FakeDriver {
  const calls: CreateVMParams[] = []
  let failures = 0
  const driver: FakeDriver = {
    id: 'aws',
    label: 'Fake Auto',
    costHint: 'free',
    createVMCalls: calls,
    detectCreds: async () => ({ available: true, detail: 'ok', needs: 'nothing' }),
    createVM: async (params, onLog) => {
      calls.push(params)
      onLog('fake: creating VM')
      if (opts.failFirst && failures === 0) { failures++; throw new Error('quota exceeded') }
      const ip = opts.ip ?? '203.0.113.10'
      // Mirrors the real drivers' contract: in sslip mode there is no domain to
      // echo back, so the driver derives one from the IP it just got.
      return {
        ip,
        instanceRef: 'i-fake',
        domain: params.domainMode === 'sslip' ? sslipHostname(ip) : (params.domain as string),
      }
    },
    instructions: ({ userData }) => ({ steps: ['fake'], userData }),
  }
  return driver
}

function makeManualDriver(): FakeDriver {
  const driver = makeAutoDriver() as FakeDriver
  return { ...driver, id: 'manual', label: 'Fake Manual', createVM: undefined, createVMCalls: driver.createVMCalls }
}

// ── Harness ─────────────────────────────────────────────────────────────────

const restores: Array<() => void> = []

/** Point the job at a fake box: an origin, so no TLS/DNS is involved. */
const ORIGIN = 'http://127.0.0.1:9/api'.replace('/api', '')

/**
 * 10s: loose enough that scheduler starvation on a loaded machine (concurrent
 * agents, Playwright, other vitest tiers) can't masquerade as a product failure,
 * but under the quick tier's 15s testTimeout so a genuine hang still reports as
 * this assertion rather than an opaque tier timeout. Normal case: milliseconds.
 */
async function waitFor(predicate: (s: CloudSetupJobState) => boolean, label: string, timeoutMs = 10_000): Promise<CloudSetupJobState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await getCloudSetupJob()
    if (state && predicate(state)) return state
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}; last state = ${JSON.stringify(state)}`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

function jobFile(): string {
  return path.join(WALNUT_HOME, 'cloud-setup-job.json')
}

/**
 * Wipe WALNUT_HOME, tolerating a persist that is still mid-write. Cancelling a
 * runner only sets a flag — a `fs.writeFile` already in flight still lands its
 * tmp file, which races `rm -rf` to ENOTEMPTY. Retrying is enough: the writer
 * cannot start a NEW persist once cancelled, so the second pass finds it quiet.
 */
async function wipeHome(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true })
      await fs.mkdir(WALNUT_HOME, { recursive: true })
      return
    } catch (err) {
      if (attempt >= 20) throw err
      await new Promise((r) => setTimeout(r, 25))
    }
  }
}

/** Like waitFor, but reads the FILE — for cases that then simulate a restart. */
async function waitForOnDisk(
  predicate: (s: CloudSetupJobState) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<CloudSetupJobState> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const state = JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as CloudSetupJobState
      if (predicate(state)) return state
    } catch { /* mid-write / not created yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} on disk`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  // Reset the runner FIRST: a leftover runner from a previous file-level failure
  // must stop writing before the dir is wiped.
  _resetCloudSetupJobForTesting()
  await wipeHome()
  gitCalls.initSync = []; gitCalls.syncCount = 0; gitCalls.lsRemote = 0
  cloudRemote = null
  syncShouldFail = false
  lsRemoteAnswer = 'ref\tHEAD'
  box = { claimed: false, bootedAfter: 0, claimCalls: [], statusCalls: 0, issuedToken: 'devtok-abc123' }
  installFetchStub()
  // Fast polls (the real budgets are minutes). serverBudgetMs must stay WELL
  // under the quick tier's 15s testTimeout: cases that park mid-await-server
  // wait the budget out, so a budget at/over the tier timeout makes them fail in
  // the suite while passing in isolation (focus allows 60s). 4s is generous
  // relative to the 5ms poll interval yet safe under every tier.
  CLOUD_SETUP_TIMINGS.serverIntervalMs = 5
  CLOUD_SETUP_TIMINGS.serverBudgetMs = 4_000
  CLOUD_SETUP_TIMINGS.dnsIntervalMs = 5
  CLOUD_SETUP_TIMINGS.dnsPatienceMs = 50
})

afterEach(async () => {
  _resetCloudSetupJobForTesting()
  while (restores.length) restores.pop()?.()
  vi.unstubAllGlobals()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

function useDriver(driver: FakeDriver): FakeDriver {
  restores.push(_setCloudProviderDriverForTesting(driver.id, driver))
  return driver
}

// ── Happy path ──────────────────────────────────────────────────────────────

describe('happy path (auto-provisioning driver)', () => {
  it('runs every step, claims the box, wires the remote, and finishes', async () => {
    const driver = useDriver(makeAutoDriver())
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')

    expect(done.status).toBe('done')
    expect(driver.createVMCalls).toHaveLength(1)
    expect(done.ip).toBe('203.0.113.10')
    expect(done.instanceRef).toBe('i-fake')
    expect(box.claimCalls).toHaveLength(1)
    // The claim carried the code that was baked into the boot script.
    expect(box.claimCalls[0].setupToken).toMatch(/^[0-9a-f]{32}$/)
    expect(box.claimCalls[0].deviceName).toMatch(/^mac-/)
    // Remote wired with the token the box issued.
    expect(gitCalls.initSync).toHaveLength(1)
    expect(gitCalls.initSync[0]).toContain('walnut:devtok-abc123@127.0.0.1:9/git/data')
    // Scheme carried through from the job's origin-style domain (no https upgrade).
    expect(gitCalls.initSync[0].startsWith('http://')).toBe(true)
    expect(gitCalls.syncCount).toBe(1)
    expect(gitCalls.lsRemote).toBe(1)

    for (const id of ['preflight', 'generate', 'provision', 'await-server', 'claim-and-wire', 'verify-sync', 'done'] as const) {
      expect(done.steps[id].status, id).toBe('done')
    }
    // Skipped, not run: an auto driver needs no manual IP, and a literal host
    // has no A record to wait for.
    expect(done.steps['await-vm'].status).toBe('skipped')
    expect(done.steps.dns.status).toBe('skipped')
  })

  it('erases the pairing code from state and disk once the claim succeeds', async () => {
    useDriver(makeAutoDriver())
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')

    const usedCode = box.claimCalls[0].setupToken
    expect(done.pairingCode).toBeUndefined()
    const onDisk = await fs.readFile(jobFile(), 'utf-8')
    expect(onDisk).not.toContain(usedCode)
    expect(onDisk).not.toContain('pairingCode')
  })

  it('redactCloudSetupJob strips the pairing code while a job still holds one', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000 // never boots — the job parks with the code held
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const state = await waitFor((s) => s.pairingCode != null, 'a generated pairing code')
    const code = state.pairingCode as string
    expect(code).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(redactCloudSetupJob(state))).not.toContain(code)
    await cancelCloudSetupJob()
  })
})

// ── Manual / awaiting-input flow ────────────────────────────────────────────

describe('manual driver (awaiting-input)', () => {
  it('parks on vm-ip, then continues to done once the IP arrives', async () => {
    useDriver(makeManualDriver())
    await startCloudSetupJob({ provider: 'manual', domainMode: 'own-domain', domain: ORIGIN })
    const parked = await waitFor((s) => s.status === 'awaiting-input', 'awaiting-input')
    expect(parked.awaitingInput?.kind).toBe('vm-ip')
    expect(parked.currentStep).toBe('provision')
    // Not consumed yet — a resumed job must re-enter the step.
    expect(parked.steps.provision.status).toBe('pending')

    await provideCloudSetupInput({ ip: '203.0.113.55' })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')
    expect(done.ip).toBe('203.0.113.55')
    expect(box.claimCalls).toHaveLength(1)
  })

  it('rejects a malformed IP and stays awaiting', async () => {
    useDriver(makeManualDriver())
    await startCloudSetupJob({ provider: 'manual', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.status === 'awaiting-input', 'awaiting-input')
    await expect(provideCloudSetupInput({ ip: 'not-an-ip' })).rejects.toThrow(/valid IPv4/)
    expect((await getCloudSetupJob())?.status).toBe('awaiting-input')
  })

  it('sslip mode derives the hostname from the supplied IP', async () => {
    useDriver(makeManualDriver())
    await startCloudSetupJob({ provider: 'manual', domainMode: 'sslip' })
    await waitFor((s) => s.status === 'awaiting-input', 'awaiting-input')
    await provideCloudSetupInput({ ip: '203.0.113.77' })
    const state = await waitFor((s) => s.domain != null, 'a derived domain')
    expect(state.domain).toBe('203-0-113-77.sslip.io')
    await cancelCloudSetupJob()
  })

  it('sslip mode hands an auto driver a SSLIP_AUTO boot script, not a literal hostname', async () => {
    // The box resolves its own hostname at boot, so the generated script must
    // carry the resolver block — a driver that got a literal hostname here would
    // bake in the wrong name (or "undefined") for every sslip deploy.
    const driver = makeAutoDriver({ ip: '203.0.113.77' })
    useDriver(driver)
    box.bootedAfter = 0
    await startCloudSetupJob({ provider: 'aws', domainMode: 'sslip' })
    const state = await waitFor((s) => s.domain != null, 'a derived domain')
    expect(driver.createVMCalls).toHaveLength(1)
    const { userData, domainMode, domain } = driver.createVMCalls[0]
    expect(domainMode).toBe('sslip')
    expect(domain).toBeUndefined()
    // The resolver block, and never the raw sentinel.
    expect(userData).toContain('.sslip.io')
    expect(userData).toContain('169.254.169.254/latest/meta-data/public-ipv4')
    expect(userData).not.toContain('SSLIP_AUTO')
    // The fake driver echoes the sslip hostname back; the job keeps it.
    expect(state.domain).toBe('203-0-113-77.sslip.io')
    await cancelCloudSetupJob()
  })

  it('input on a non-awaiting job throws', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.steps.provision.status === 'done', 'provision done')
    await expect(provideCloudSetupInput({ ip: '203.0.113.1' })).rejects.toThrow(/not awaiting input/)
    await cancelCloudSetupJob()
  })
})

// ── Crash / resume at each boundary ─────────────────────────────────────────

describe('crash-resume', () => {
  /**
   * Simulates a process restart: drop all in-memory runner state (the file is
   * the only thing that survives), then resume from disk.
   */
  async function restart(): Promise<void> {
    _resetCloudSetupJobForTesting()
    await resumeCloudSetupJobIfAny()
  }

  it('resuming after provision does not create a second VM', async () => {
    const driver = useDriver(makeAutoDriver())
    box.bootedAfter = 10_000 // park in await-server so we can restart mid-job
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.steps.provision.status === 'done', 'provision done')
    expect(driver.createVMCalls).toHaveLength(1)

    // The state on disk says 'running' at await-server.
    const persisted = JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as CloudSetupJobState
    expect(persisted.status).toBe('running')
    expect(persisted.steps.provision.status).toBe('done')

    box.bootedAfter = 0 // the box comes up while we were down
    await restart()
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')
    // The whole point: no duplicate provision across the restart.
    expect(driver.createVMCalls).toHaveLength(1)
  })

  // One case PER boundary rather than a loop in a single test: four full job
  // runs in one `it` exceeded the quick tier's 15s testTimeout (it passed under
  // focus's 60s), and a loop also hides WHICH boundary regressed.
  for (const boundary of ['generate', 'provision', 'await-server', 'claim-and-wire'] as const) {
    it(`resuming right after ${boundary} still reaches done exactly once`, async () => {
      const driver = useDriver(makeAutoDriver())
      await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
      // Cut the runner as soon as this boundary's step has been recorded done.
      await waitFor((s) => s.steps[boundary].status === 'done' || s.status === 'done', `${boundary} done`)
      await restart()
      const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', `terminal after ${boundary}`)

      expect(done.status, `restart after ${boundary}: ${done.error ?? ''}`).toBe('done')
      expect(driver.createVMCalls.length, 'createVM calls').toBeLessThanOrEqual(1)
      // Claiming twice would 403 — the second run must skip a completed claim.
      expect(box.claimCalls.length, 'claim calls').toBeLessThanOrEqual(1)
      expect(done.pairingCode).toBeUndefined()
    })
  }

  it('generate reuses the pairing code already baked into a booting VM', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const first = await waitFor((s) => s.pairingCode != null, 'a pairing code')
    const code = first.pairingCode

    await restart()
    const after = await waitFor((s) => s.pairingCode != null, 'a pairing code after restart')
    expect(after.pairingCode).toBe(code)
    await cancelCloudSetupJob()
  })

  it('a terminal job is not resumed', async () => {
    useDriver(makeAutoDriver())
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.status === 'done', 'done')
    const before = box.claimCalls.length
    await restart()
    await new Promise((r) => setTimeout(r, 50))
    expect(box.claimCalls.length).toBe(before)
    expect((await getCloudSetupJob())?.status).toBe('done')
  })

  it('a non-aws driver needing a credential parks on awaiting-input after a restart', async () => {
    const driver = { ...makeAutoDriver(), id: 'hetzner' as const, label: 'Fake Token Driver' }
    restores.push(_setCloudProviderDriverForTesting('hetzner', driver))
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'hetzner', domainMode: 'own-domain', domain: ORIGIN, credentials: 'secret-token' })
    await waitFor((s) => s.steps.provision.status === 'done', 'provision done')

    // Stop the runner BEFORE editing the file, or it keeps advancing and
    // overwrites the edit (the state file has exactly one writer by design).
    const state = await waitForOnDisk((s) => s.steps.provision.status === 'done', 'provision done on disk')
    _resetCloudSetupJobForTesting()
    // Rewind to a not-yet-provisioned job, then restart: the credential lived
    // only in memory, so it cannot silently be reused.
    state.currentStep = 'provision'
    state.steps.provision = { status: 'pending' }
    state.status = 'running'
    await fs.writeFile(jobFile(), JSON.stringify(state))
    await restart()

    const parked = await waitFor((s) => s.status === 'awaiting-input', 'awaiting credentials')
    expect(parked.awaitingInput?.kind).toBe('credentials')
    // And the credential is nowhere on disk.
    expect(await fs.readFile(jobFile(), 'utf-8')).not.toContain('secret-token')

    await provideCloudSetupInput({ credentials: 'secret-token' })
    box.bootedAfter = 0
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')
  })
})

// ── DNS confirmation ───────────────────────────────────────────────────────

describe('dns step', () => {
  /**
   * A real hostname that never resolves to our IP, so the step exhausts its
   * patience window and asks for confirmation while still polling.
   */
  const UNRESOLVABLE = 'nonexistent-host.invalid'

  it('asks for confirmation after the patience window but keeps polling', async () => {
    useDriver(makeAutoDriver({ ip: '203.0.113.10' }))
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: UNRESOLVABLE })
    const parked = await waitFor((s) => s.awaitingInput?.kind === 'dns-confirm', 'dns-confirm prompt')
    expect(parked.status).toBe('awaiting-input')
    expect(parked.currentStep).toBe('dns')
    // Still polling: the step is 'running', not parked back to 'pending'.
    expect(parked.steps.dns.status).toBe('running')
    await cancelCloudSetupJob()
  })

  it('confirmDnsSkip continues the live poll', async () => {
    useDriver(makeAutoDriver({ ip: '203.0.113.10' }))
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: UNRESOLVABLE })
    await waitFor((s) => s.awaitingInput?.kind === 'dns-confirm', 'dns-confirm prompt')
    await provideCloudSetupInput({ confirmDnsSkip: true })
    // await-server then fails against an unreachable host — proof we got past dns.
    const after = await waitFor((s) => s.currentStep !== 'dns', 'the job to leave the dns step')
    expect(after.steps.dns.status).toBe('done')
    await cancelCloudSetupJob()
  })

  it('rejects a confirmation that does not set confirmDnsSkip', async () => {
    useDriver(makeAutoDriver({ ip: '203.0.113.10' }))
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: UNRESOLVABLE })
    await waitFor((s) => s.awaitingInput?.kind === 'dns-confirm', 'dns-confirm prompt')
    await expect(provideCloudSetupInput({})).rejects.toThrow(/confirmDnsSkip/)
    await cancelCloudSetupJob()
  })

  it('a confirmation arriving after a restart still advances the job', async () => {
    useDriver(makeAutoDriver({ ip: '203.0.113.10' }))
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: UNRESOLVABLE })
    await waitFor((s) => s.awaitingInput?.kind === 'dns-confirm', 'dns-confirm prompt')
    // waitFor sees the in-memory state; a restart reads DISK, so wait for the
    // prompt to actually land in the file before dropping the cache.
    await waitForOnDisk((s) => s.awaitingInput?.kind === 'dns-confirm', 'dns-confirm persisted')

    // Simulate the restart: the polling runner is gone, so there is nothing left
    // to observe an in-memory "confirmed" flag.
    _resetCloudSetupJobForTesting()
    await resumeCloudSetupJobIfAny() // awaiting-input → no runner re-armed

    await provideCloudSetupInput({ confirmDnsSkip: true })
    const after = await waitFor((s) => s.currentStep !== 'dns', 'the job to leave the dns step')
    expect(after.steps.dns.status).toBe('skipped')
    await cancelCloudSetupJob()
  })
})

// ── Failure / retry ────────────────────────────────────────────────────────

describe('failure and retry', () => {
  it('records the failed step, then retryJob re-runs from exactly that step', async () => {
    const driver = useDriver(makeAutoDriver({ failFirst: true }))
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')

    expect(failed.currentStep).toBe('provision')
    expect(failed.steps.provision.status).toBe('error')
    expect(failed.steps.provision.error).toContain('quota exceeded')
    expect(failed.error).toContain('quota exceeded')
    // Earlier steps stay done — a retry must not redo preflight/generate work.
    expect(failed.steps.preflight.status).toBe('done')
    expect(failed.steps.generate.status).toBe('done')
    const codeBefore = failed.pairingCode

    await retryCloudSetupJob()
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal after retry')
    expect(done.status).toBe('done')
    // Second attempt only — the first threw before returning.
    expect(driver.createVMCalls).toHaveLength(2)
    // Same code: the retry must be able to claim a box that already booted.
    expect(box.claimCalls[0].setupToken).toBe(codeBefore)
  })

  it('a failing verify-sync fails the job and is retryable', async () => {
    useDriver(makeAutoDriver())
    syncShouldFail = true
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')
    expect(failed.currentStep).toBe('verify-sync')
    // The claim already happened, so the code is gone even though the job failed.
    expect(failed.pairingCode).toBeUndefined()

    syncShouldFail = false
    // The remote initSync already wrote is what proves the box is ours, so the
    // retry must not try to claim it again (that would 403).
    expect(cloudRemote?.domain).toBe('127.0.0.1:9')
    await retryCloudSetupJob()
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal after retry')
    expect(done.status).toBe('done')
    expect(box.claimCalls).toHaveLength(1) // never re-claimed
  })

  it('a box claimed by someone else fails with an actionable message', async () => {
    useDriver(makeAutoDriver())
    box.claimed = true // claimed, and our remote does not point at it
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')
    expect(failed.currentStep).toBe('await-server')
    expect(failed.error).toMatch(/already claimed by another device/)
    expect(box.claimCalls).toHaveLength(0)
  })

  it('a claimed box whose remote is already ours skips the claim', async () => {
    useDriver(makeAutoDriver())
    box.claimed = true
    cloudRemote = { domain: '127.0.0.1:9', token: 'devtok-abc123', secure: false }
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN, force: true })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')
    expect(box.claimCalls).toHaveLength(0)
    expect(gitCalls.initSync).toHaveLength(0)
  })

  it('verify-sync fails when the companion will not answer ls-remote', async () => {
    useDriver(makeAutoDriver())
    lsRemoteAnswer = null
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')
    expect(failed.currentStep).toBe('verify-sync')
    expect(failed.error).toMatch(/ls-remote/)
  })
})

// ── Single-instance / lifecycle ─────────────────────────────────────────────

describe('job lifecycle', () => {
  it('a second start while one is in flight throws CloudSetupJobExistsError', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.status === 'running' || s.status === 'awaiting-input', 'in flight')
    await expect(startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN }))
      .rejects.toThrow(CloudSetupJobExistsError)
    await cancelCloudSetupJob()
  })

  it('force replaces an in-flight job with a new id and stops the old runner', async () => {
    const driver = useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    const first = await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.steps.provision.status === 'done', 'first provision done')

    box.bootedAfter = 0
    const second = await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN, force: true })
    expect(second.id).not.toBe(first.id)
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.id).toBe(second.id)
    expect(done.status).toBe('done')
    // Exactly one extra provision (the new job's) — the superseded runner stopped.
    expect(driver.createVMCalls).toHaveLength(2)
  })

  it('preflight refuses when cloud sync is already configured, unless forced', async () => {
    useDriver(makeAutoDriver())
    cloudRemote = { domain: 'other.example.com', token: 'tok', secure: true }
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')
    expect(failed.currentStep).toBe('preflight')
    expect(failed.error).toMatch(/already configured/)

    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN, force: true })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')
  })

  it('own-domain mode without a domain fails preflight', async () => {
    useDriver(makeAutoDriver())
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain' })
    const failed = await waitFor((s) => s.status === 'failed', 'failed')
    expect(failed.error).toMatch(/requires a domain/)
  })

  it('an unknown provider is rejected at start', async () => {
    // Every id in CloudSetupProviderId now has a registered driver, so the only
    // way to reach this guard is an id from outside the union — which is exactly
    // what it defends against: a hand-rolled POST /start, or a persisted job from
    // a newer build being resumed by an older one.
    await expect(startCloudSetupJob({
      provider: 'not-a-provider' as CloudSetupProviderId,
      domainMode: 'sslip',
    })).rejects.toThrow(/Unknown provider/)
  })

  it('every provider in the id union resolves to a registered driver', async () => {
    // The complement of the test above: an id the wizard can legitimately send
    // must never hit the guard. This is what caught 'gcp' having no driver.
    const ids: CloudSetupProviderId[] = ['aws', 'hetzner', 'azure', 'gcp', 'manual']
    const { getDriver } = await import('../../../src/core/cloud-setup/providers/index.js')
    for (const id of ids) expect(getDriver(id), id).toBeDefined()
  })

  it('cancel stops the runner and DELETE clears the record', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.steps.provision.status === 'done', 'provision done')

    const cancelled = await cancelCloudSetupJob()
    expect(cancelled?.status).toBe('cancelled')
    // The runner is gone: the box coming up must not resurrect the job.
    box.bootedAfter = 0
    await new Promise((r) => setTimeout(r, 60))
    expect(box.claimCalls).toHaveLength(0)
    expect((await getCloudSetupJob())?.status).toBe('cancelled')

    expect(await deleteCloudSetupJob()).toBe(true)
    expect(await getCloudSetupJob()).toBeNull()
    await expect(fs.access(jobFile())).rejects.toThrow()
  })

  it('DELETE refuses while a job is in flight', async () => {
    useDriver(makeAutoDriver())
    box.bootedAfter = 10_000
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor((s) => s.status === 'running', 'running')
    await expect(deleteCloudSetupJob()).rejects.toThrow(CloudSetupJobExistsError)
    await cancelCloudSetupJob()
  })

  it('a driver logging its own userData base64 cannot leak the code into logTail', async () => {
    // Regression guard: the aws driver echoes its cdk command line, which
    // carries `-c userDataB64=<base64 of the boot script>` — and that script
    // embeds the pairing code. Unredacted, the secret would reach logTail and
    // from there the SSE stream and every REST response.
    const base = makeAutoDriver()
    const leaky: FakeDriver = {
      ...base,
      createVM: async (params, onLog) => {
        const b64 = Buffer.from(params.userData, 'utf-8').toString('base64')
        onLog(`$ npx cdk deploy -c userDataB64=${b64}`)
        return { ip: '203.0.113.10', instanceRef: 'i-fake', domain: params.domain as string }
      },
    }
    useDriver(leaky)
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.status).toBe('done')

    const code = box.claimCalls[0].setupToken
    const joined = done.logTail.join('\n')
    // Neither the raw code nor a base64 blob that decodes to it.
    expect(joined).not.toContain(code)
    for (const line of done.logTail) {
      for (const token of line.split(/\s+/)) {
        if (token.length < 64) continue
        const decoded = Buffer.from(token, 'base64').toString('utf-8')
        expect(decoded).not.toContain(code)
      }
    }
  })

  it('logTail is ring-capped and never contains the pairing code', async () => {
    useDriver(makeAutoDriver())
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const done = await waitFor((s) => s.status === 'done' || s.status === 'failed', 'terminal state')
    expect(done.logTail.length).toBeGreaterThan(0)
    expect(done.logTail.length).toBeLessThanOrEqual(200)
    const code = box.claimCalls[0].setupToken
    expect(done.logTail.join('\n')).not.toContain(code)
    // Nor the device token the box issued.
    expect(done.logTail.join('\n')).not.toContain('devtok-abc123')
  })
})
