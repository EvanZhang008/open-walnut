/**
 * Cloud-setup job: the target (account, region, project, subscription) a job
 * resolved is recorded before any VM exists, and a resume builds there or
 * refuses. The product risk is money: a resume that follows a changed ambient
 * default adopts nothing (drivers adopt by NAME inside the place they resolve)
 * and pays for a second VM the operator does not know about.
 *
 * A fake "cloud" driver is injected into the real registry. It holds VMs per
 * place and models the three real driver shapes: 'pin' (gcp/azure: the recorded
 * place is passed explicitly), 'refuse' (aws: the account cannot be passed, so a
 * different one is refused) and 'token' (hetzner: a pasted token reaches its own
 * project; a token for another one is refused and a new one asked for).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-setup-target'))

// The job's one real side effect on the machine: never touch a data repo.
let cloudRemote: { domain: string; token: string; secure: boolean } | null = null
vi.mock('../../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentials: () => cloudRemote,
  initSync: (url?: string) => {
    if (!url) return
    const parsed = new URL(url)
    cloudRemote = { domain: parsed.host, token: parsed.password, secure: parsed.protocol === 'https:' }
  },
  sync: async () => ({ pulled: 0, pushed: 1, conflicts: 0 }),
  gitSafeAsync: async (args: string) => (args.startsWith('ls-remote') ? 'ref\tHEAD' : null),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  _resetCloudSetupJobForTesting,
  _settleCloudSetupWritesForTesting,
  cancelCloudSetupJob,
  getCloudSetupJob,
  provideCloudSetupInput,
  resumeCloudSetupJobIfAny,
  retryCloudSetupJob,
  startCloudSetupJob,
} from '../../../src/core/cloud-setup/job.js'
import { CLOUD_SETUP_TIMINGS } from '../../../src/core/cloud-setup/steps.js'
import { _setCloudProviderDriverForTesting } from '../../../src/core/cloud-setup/providers/index.js'
import {
  CloudTargetChangedError,
  incompleteTargetError,
  type CloudProviderDriver,
  type CreateVMParams,
  type ResolveTargetParams,
} from '../../../src/core/cloud-setup/providers/types.js'
import type { CloudSetupJobState, CloudSetupProviderId, CloudSetupTarget } from '../../../src/core/cloud-setup/job-types.js'

// ── Fake box: the companion answers status and claim ────────────────────────

let bootedAfter = 0
let statusCalls = 0
function installFetchStub(): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/api/v1/setup/status')) {
      statusCalls++
      if (statusCalls <= bootedAfter) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify({ claimed: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/v1/setup/claim')) {
      return new Response(JSON.stringify({ token: 'devtok-abc123' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
}

// ── Fake cloud driver ───────────────────────────────────────────────────────

type Kind = 'pin' | 'refuse' | 'token'
const ID: Record<Kind, CloudSetupProviderId> = { pin: 'gcp', refuse: 'aws', token: 'hetzner' }
const TOKENS: Record<string, string> = { 'tok-A': 'A', 'tok-A2': 'A', 'tok-B': 'B' }

interface PlaceDriver extends CloudProviderDriver {
  /** The CLI's ambient default place (pin/refuse kinds). */
  ambient: string
  /** VMs that exist, by place. Adopt-by-name means one per place at most. */
  cloud: Map<string, string>
  resolveCalls: ResolveTargetParams[]
  createVMCalls: CreateVMParams[]
  /** The job record's target on disk at the moment each createVM started. */
  diskTargetAtCreate: Array<CloudSetupTarget | undefined>
  /** When set, the next createVM makes its VM and then blocks here (a crash mid-create). */
  gate: Promise<void> | null
}

function placeOfTarget(kind: Kind, t: CloudSetupTarget | undefined): string | undefined {
  if (!t) return undefined
  if (kind === 'token') return t.firewallId === 1 ? 'A' : t.firewallId === 2 ? 'B' : undefined
  return kind === 'pin' ? t.project : t.account
}

function makePlaceDriver(kind: Kind): PlaceDriver {
  const d: PlaceDriver = {
    id: ID[kind],
    label: `Fake ${kind}`,
    costHint: 'free',
    ...(kind === 'token' ? { credentialInput: 'api-token' as const } : {}),
    ambient: 'A',
    cloud: new Map(),
    resolveCalls: [],
    createVMCalls: [],
    diskTargetAtCreate: [],
    gate: null,
    detectCreds: async () => ({ available: true, detail: 'ok', needs: 'nothing' }),
    instructions: ({ userData }) => ({ steps: ['fake'], userData }),
    resolveTarget: async (params) => {
      d.resolveCalls.push(params)
      const here = kind === 'token' ? TOKENS[params.credentials ?? ''] : d.ambient
      if (!here) throw new Error('fake: no place to resolve')
      if (kind === 'token') return { firewallId: here === 'A' ? 1 : 2 }
      return kind === 'pin' ? { project: here } : { account: here }
    },
    createVM: async (params) => {
      d.createVMCalls.push(params)
      d.diskTargetAtCreate.push((JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as CloudSetupJobState).target)
      const now = kind === 'token' ? TOKENS[params.credentials ?? ''] : d.ambient
      const recorded = placeOfTarget(kind, params.target)
      // As every real driver does: a record without its field is refused, never guessed.
      if (params.target && !recorded) throw incompleteTargetError('place')
      if (recorded && recorded !== now && kind !== 'pin') {
        throw new CloudTargetChangedError(`This setup started in place ${recorded}, but it now reaches place ${now}.`, {
          newCredentialHelps: kind === 'token',
        })
      }
      const place = kind === 'pin' ? (recorded ?? now) : now
      let ref = d.cloud.get(place)
      if (!ref) {
        ref = `vm-${place}-${d.cloud.size + 1}`
        d.cloud.set(place, ref)
      }
      if (d.gate) {
        const gate = d.gate
        d.gate = null
        await gate
      }
      return { ip: '203.0.113.10', instanceRef: ref, domain: params.domain as string }
    },
  }
  return d
}

// ── Harness ─────────────────────────────────────────────────────────────────

const ORIGIN = 'http://127.0.0.1:9'
const restores: Array<() => void> = []
const gates: Array<() => void> = []

function jobFile(): string {
  return path.join(WALNUT_HOME, 'cloud-setup-job.json')
}

function useDriver(kind: Kind): PlaceDriver {
  const d = makePlaceDriver(kind)
  restores.push(_setCloudProviderDriverForTesting(d.id, d))
  return d
}

/** Make the next createVM block after making its VM; returns when it has. */
function crashMidCreate(d: PlaceDriver): void {
  d.gate = new Promise<void>((resolve) => { gates.push(resolve) })
}

async function waitFor(predicate: (s: CloudSetupJobState) => boolean, label: string): Promise<CloudSetupJobState> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const state = await getCloudSetupJob()
    if (state && predicate(state)) return state
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; last state = ${JSON.stringify(state)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function waitForOnDisk(predicate: (s: CloudSetupJobState) => boolean, label: string): Promise<CloudSetupJobState> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const state = JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as CloudSetupJobState
      if (predicate(state)) return state
    } catch { /* mid-write */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} on disk`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A process restart: no new write from the old runner, the issued ones land, resume from disk. */
async function restart(): Promise<void> {
  _resetCloudSetupJobForTesting()
  await _settleCloudSetupWritesForTesting()
  await resumeCloudSetupJobIfAny()
}

const terminal = (s: CloudSetupJobState): boolean => s.status === 'done' || s.status === 'failed'

beforeEach(async () => {
  _resetCloudSetupJobForTesting()
  await _settleCloudSetupWritesForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  cloudRemote = null
  bootedAfter = 0
  statusCalls = 0
  installFetchStub()
  CLOUD_SETUP_TIMINGS.serverIntervalMs = 5
  CLOUD_SETUP_TIMINGS.serverBudgetMs = 4_000
})

afterEach(async () => {
  _resetCloudSetupJobForTesting()
  while (gates.length) gates.pop()?.()
  while (restores.length) restores.pop()?.()
  await _settleCloudSetupWritesForTesting()
  vi.unstubAllGlobals()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Cases ───────────────────────────────────────────────────────────────────

describe('a cloud setup job records where it builds', () => {
  it('preflight records the target, and it is on disk before createVM runs', async () => {
    const d = useDriver('pin')
    await startCloudSetupJob({ provider: 'gcp', domainMode: 'own-domain', domain: ORIGIN })
    const done = await waitFor(terminal, 'terminal state')
    expect(done.status, done.error ?? '').toBe('done')
    expect(done.target).toEqual({ project: 'A' })
    expect(d.resolveCalls).toHaveLength(1)
    expect(d.createVMCalls[0].target).toEqual({ project: 'A' })
    expect(d.diskTargetAtCreate[0]).toEqual({ project: 'A' })
    expect(done.logTail.join('\n')).toMatch(/this setup builds in Fake pin: project A/)
  })

  it('a preflight that cannot resolve a target fails before anything is created', async () => {
    const d = useDriver('refuse')
    d.resolveTarget = async () => { throw new Error('not signed in') }
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    const failed = await waitFor(terminal, 'terminal state')
    expect(failed.status).toBe('failed')
    expect(failed.currentStep).toBe('preflight')
    expect(d.createVMCalls).toHaveLength(0)
  })
})

describe('a crash, then the ambient default moves', () => {
  it('pinning drivers (gcp, azure): the resume builds where it started, one VM', async () => {
    const d = useDriver('pin')
    crashMidCreate(d)
    await startCloudSetupJob({ provider: 'gcp', domainMode: 'own-domain', domain: ORIGIN })
    await until(() => d.cloud.size === 1, 'the first VM to exist')
    d.ambient = 'B' // e.g. `gcloud config set project` while Walnut was down
    await restart()
    const done = await waitFor(terminal, 'terminal state')
    expect(done.status, done.error ?? '').toBe('done')
    expect([...d.cloud.keys()]).toEqual(['A'])
    expect(done.instanceRef).toBe('vm-A-1')
    expect(d.resolveCalls).toHaveLength(1) // never re-resolved from the new default
  })

  it('aws: the resume refuses, naming both, creates nothing; after switching back a retry finishes on the one VM', async () => {
    const d = useDriver('refuse')
    crashMidCreate(d)
    await startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: ORIGIN })
    await until(() => d.cloud.size === 1, 'the first VM to exist')
    d.ambient = 'B'
    await restart()
    const failed = await waitFor(terminal, 'terminal state')
    expect(failed.status).toBe('failed')
    expect(failed.currentStep).toBe('provision')
    expect(failed.error).toMatch(/started in place A, but it now reaches place B/)
    expect(d.cloud.size).toBe(1)

    d.ambient = 'A'
    await retryCloudSetupJob()
    const done = await waitFor(terminal, 'terminal state after retry')
    expect(done.status, done.error ?? '').toBe('done')
    expect([...d.cloud.entries()]).toEqual([['A', 'vm-A-1']])
  })

  it('hetzner: a token for another project parks the job on a new token, keeps no token, creates nothing', async () => {
    const d = useDriver('token')
    crashMidCreate(d)
    await startCloudSetupJob({ provider: 'hetzner', domainMode: 'own-domain', domain: ORIGIN, credentials: 'tok-A' })
    await until(() => d.cloud.size === 1, 'the first VM to exist')
    await restart()
    const parked = await waitFor((s) => s.status === 'awaiting-input', 'the token prompt after restart')
    expect(parked.awaitingInput?.kind).toBe('credentials')

    await provideCloudSetupInput({ credentials: 'tok-B' })
    const again = await waitFor(
      (s) => s.status === 'awaiting-input' && /started in place A/.test(s.awaitingInput?.prompt ?? ''),
      'the job to ask for a token from the original project',
    )
    expect(again.awaitingInput?.kind).toBe('credentials')
    expect(again.steps.provision.status).toBe('pending')
    expect(d.cloud.size).toBe(1)

    await provideCloudSetupInput({ credentials: 'tok-A2' })
    const done = await waitFor(terminal, 'terminal state')
    expect(done.status, done.error ?? '').toBe('done')
    expect([...d.cloud.entries()]).toEqual([['A', 'vm-A-1']])
  })
})

describe('records older and other Walnuts wrote', () => {
  /** Run a job until it waits for the box, stop it, and rewrite the record as `edit` says. */
  async function recordAtProvision(d: PlaceDriver, edit: (s: CloudSetupJobState) => void): Promise<void> {
    bootedAfter = 10_000
    await startCloudSetupJob({ provider: d.id, domainMode: 'own-domain', domain: ORIGIN })
    const state = await waitForOnDisk((s) => s.steps['await-server'].status === 'running', 'the runner waiting for the box')
    _resetCloudSetupJobForTesting()
    await _settleCloudSetupWritesForTesting()
    state.currentStep = 'provision'
    state.steps.provision = { status: 'pending' }
    state.status = 'running'
    edit(state)
    await fs.writeFile(jobFile(), JSON.stringify(state))
    bootedAfter = 0
    statusCalls = 0
  }

  it('a record with no target (an older Walnut) resumes: the target is pinned and on disk before the create', async () => {
    const d = useDriver('refuse')
    await recordAtProvision(d, (s) => { delete s.target })
    await restart()
    const done = await waitFor(terminal, 'terminal state')
    expect(done.status, done.error ?? '').toBe('done')
    expect(d.resolveCalls).toHaveLength(2)
    expect(d.diskTargetAtCreate[1]).toEqual({ account: 'A' })
    expect(d.createVMCalls[1].target).toEqual({ account: 'A' })
    expect(d.cloud.size).toBe(1)
  })

  it('a cancel while that pin is being written stops the job before any create', async () => {
    const d = useDriver('refuse')
    await recordAtProvision(d, (s) => { delete s.target })
    const creates = d.createVMCalls.length
    let land!: () => void
    const held = new Promise<void>((resolve) => { land = resolve })
    let sawHold!: () => void
    const holding = new Promise<void>((resolve) => { sawHold = resolve })
    const rename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === jobFile()) {
        const s = JSON.parse(await fs.readFile(from, 'utf-8')) as CloudSetupJobState
        if (s.target && s.status === 'running' && s.steps.provision.status === 'running') {
          sawHold()
          await held
        }
      }
      return rename(from, to)
    })
    restores.push(() => { land(); spy.mockRestore() })
    await restart()
    await holding
    const cancelled = cancelCloudSetupJob()
    await new Promise((r) => setTimeout(r, 50))
    land()
    await cancelled
    await _settleCloudSetupWritesForTesting()
    await new Promise((r) => setTimeout(r, 50))
    expect(d.createVMCalls.length).toBe(creates)
    expect((JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as CloudSetupJobState).status).toBe('cancelled')
  })

  it('a damaged target is kept as an empty one: refused, never re-resolved from the ambient default', async () => {
    const d = useDriver('pin')
    await recordAtProvision(d, (s) => { (s as unknown as { target: unknown }).target = 'garbage' })
    d.ambient = 'B'
    _resetCloudSetupJobForTesting()
    expect((await getCloudSetupJob())?.target).toEqual({})
    await restart()
    const failed = await waitFor(terminal, 'terminal state')
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/has no place, so Walnut will not guess one/)
    expect(d.resolveCalls).toHaveLength(1)
    expect(d.createVMCalls[1].target).toEqual({})
    expect([...d.cloud.keys()]).toEqual(['A'])
  })

  it('the record stays version 1 with the target as one more optional field, so an older reader still loads it', async () => {
    useDriver('pin')
    await startCloudSetupJob({ provider: 'gcp', domainMode: 'own-domain', domain: ORIGIN })
    await waitFor(terminal, 'terminal state')
    await _settleCloudSetupWritesForTesting()
    const raw = JSON.parse(await fs.readFile(jobFile(), 'utf-8')) as Record<string, unknown>
    // The older loader accepts a record on exactly these two checks.
    expect(raw.version).toBe(1)
    expect(typeof raw.id).toBe('string')
    expect(raw.target).toEqual({ project: 'A' })
  })
})

describe('what leaves the process', () => {
  it('the REST view keeps the azure subscription name and drops its id', async () => {
    const { redactCloudSetupJob } = await import('../../../src/core/cloud-setup/job.js')
    const view = redactCloudSetupJob({
      version: 1, id: 'cs-x', provider: 'azure', domainMode: 'sslip', status: 'running', currentStep: 'provision',
      steps: {} as CloudSetupJobState['steps'], logTail: [], createdAt: '', updatedAt: '',
      pairingCode: 'secret-code',
      target: { subscription: '11111111-2222-3333-4444-555555555555', subscriptionName: 'Pay-As-You-Go' },
    })
    expect(view.target).toEqual({ subscriptionName: 'Pay-As-You-Go' })
    expect(JSON.stringify(view)).not.toContain('secret-code')
  })
})
