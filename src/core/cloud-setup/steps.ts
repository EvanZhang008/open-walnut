/**
 * Step implementations for the cloud-companion setup job.
 *
 * Each step is idempotent: the runner persists state before running a step, so
 * a crash mid-step re-runs it on resume. Steps either complete, or return a
 * `pause` — the runner then parks the job in 'awaiting-input' and stops until
 * POST /api/cloud-setup/job/input arrives.
 *
 * Test-visible design note: `state.domain` may be a full origin
 * (`http://127.0.0.1:1234`) instead of a bare hostname. That is the ONE hook
 * that lets an integration test point the job at a real second Walnut booted in
 * cloud mode on loopback without TLS. Bare hostnames get `https://` — so
 * production behavior is unchanged, and there is no test-only branch in the
 * claim or polling code.
 */

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
import net from 'node:net'
import os from 'node:os'
import { getCloudRemoteCredentials, gitSafeAsync, initSync, sync } from '../../integrations/git-sync.js'
import { log } from '../../logging/index.js'
import type { CloudSetupAwaitingInput, CloudSetupJobState, CloudSetupStepId } from './job-types.js'
import { getDriver } from './providers/index.js'
import { buildUserData, SSLIP_AUTO } from './user-data.js'

/** Poll intervals and budgets. Mutable so tests can shrink them. */
export const CLOUD_SETUP_TIMINGS = {
  dnsIntervalMs: 15_000,
  /** After this, ask the operator to confirm — but keep polling in background. */
  dnsPatienceMs: 30 * 60_000,
  serverIntervalMs: 10_000,
  serverBudgetMs: 20 * 60_000,
  /** Per-request timeout for the setup status/claim calls. */
  httpTimeoutMs: 10_000,
}

export interface StepContext {
  state: CloudSetupJobState
  /**
   * Appends to logTail + emits progress. Don't pass secrets — though the runner
   * scrubs the pairing code (raw and base64-wrapped) as a last line of defense,
   * since drivers stream provider CLI output verbatim.
   */
  log: (line: string) => void
  /** Provider credential for this run — in-memory only, never persisted. */
  credentials?: string
  /** Cooperative cancellation: long polls check this between attempts. */
  isCancelled: () => boolean
  /**
   * Mark the job 'awaiting-input' WITHOUT ending the step — for a poll that has
   * run long enough to want an operator override but must keep polling, so a
   * late-landing DNS record still unblocks the job with no click.
   */
  requestConfirmation: (input: CloudSetupAwaitingInput) => void
  /** True once the operator answered a requestConfirmation prompt. */
  confirmed: () => boolean
}

export interface StepOutcome {
  /** Park the job here and wait for operator input. */
  pause?: CloudSetupAwaitingInput
  /** Mark the step 'skipped' rather than 'done' (mode made it a no-op). */
  skipped?: boolean
}

export class CloudSetupCancelled extends Error {
  constructor() { super('cloud setup cancelled') }
}

// ── Target resolution ────────────────────────────────────────────────────────

interface Target { origin: string; scheme: 'http:' | 'https:'; host: string; hostname: string }

/** Normalize `state.domain` into an origin. Bare hostnames imply https. */
export function resolveTarget(domain: string): Target {
  const raw = /^https?:\/\//.test(domain) ? domain : `https://${domain}`
  const url = new URL(raw)
  return {
    origin: url.origin,
    scheme: url.protocol as 'http:' | 'https:',
    host: url.host,
    hostname: url.hostname,
  }
}

/** True when the hostname can't meaningfully be checked against a DNS A record. */
function isLiteralHost(hostname: string): boolean {
  return net.isIP(hostname) !== 0 || hostname === 'localhost' || hostname.endsWith('.localhost')
}

/** `<dashed-ip>.sslip.io` — resolves to the IP without any registrar. */
export function sslipHostname(ip: string): string {
  return `${ip.replace(/\./g, '-')}.sslip.io`
}

/** Device name for this Mac's own row on the companion. */
export function selfDeviceName(): string {
  const host = os.hostname().split('.')[0].replace(/[^A-Za-z0-9_.-]/g, '-')
  const name = `mac-${host}`.slice(0, 64)
  return /^[A-Za-z0-9]/.test(name) ? name : `mac-${Date.now()}`
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CLOUD_SETUP_TIMINGS.httpTimeoutMs) })
  let body: unknown = null
  try { body = await res.json() } catch { /* non-JSON error page */ }
  return { status: res.status, body }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })
}

/** True when the data repo's cloud remote already points at this host. */
function remoteAlreadyPointsAt(host: string): boolean {
  const creds = getCloudRemoteCredentials()
  return creds?.domain === host
}

// ── Steps ───────────────────────────────────────────────────────────────────

async function preflight(ctx: StepContext, force: boolean): Promise<StepOutcome> {
  const { state } = ctx
  const driver = getDriver(state.provider)
  if (!driver) throw new Error(`Unknown provider: ${state.provider}`)
  if (state.domainMode === 'own-domain' && !state.domain) {
    throw new Error('own-domain mode requires a domain')
  }
  if (!force && getCloudRemoteCredentials()) {
    throw new Error(
      'Cloud sync is already configured on this machine — replacing an existing companion '
      + 'is not supported in this version. Remove the cloud git remote first, or start with force.',
    )
  }
  ctx.log(`provider ${driver.label}, ${state.domainMode === 'sslip' ? 'auto hostname (sslip.io)' : `domain ${state.domain}`}`)
  return {}
}

/**
 * The hostname Caddy should serve, for the boot script. Derived from
 * `state.domain` so an operator who pasted a full URL still gets a valid
 * script — buildUserData only accepts a bare hostname.
 */
function bootScriptDomain(state: CloudSetupJobState): string {
  if (state.domainMode === 'sslip') return SSLIP_AUTO
  if (!state.domain) throw new Error('no domain to generate a boot script for')
  return resolveTarget(state.domain).hostname
}

async function generate(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  // Reuse on resume/retry: the code may already be baked into a booting VM.
  state.pairingCode ??= crypto.randomBytes(16).toString('hex')
  // Validates the inputs and throws on anything shell-unsafe.
  buildUserData({ domain: bootScriptDomain(state), pairingCode: state.pairingCode, flavor: 'al2023' })
  ctx.log('generated the first-boot script and a fresh pairing code')
  return {}
}

async function provision(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  const driver = getDriver(state.provider)
  if (!driver) throw new Error(`Unknown provider: ${state.provider}`)
  if (!state.pairingCode) throw new Error('no pairing code — the generate step did not run')

  if (!driver.createVM) {
    // Manual path: the operator provisions. Already answered (resume, or a
    // second pass after provideInput) → nothing to do here; await-vm owns the
    // rest. Without this check the step would re-pause on every re-entry.
    if (state.ip) return { skipped: true }
    ctx.log(`${driver.label}: create the VM with the script Walnut generated, then enter its public IP`)
    return {
      pause: {
        kind: 'vm-ip',
        prompt: 'Paste the boot script into your VM, then enter its public IPv4 address.',
      },
    }
  }

  const userData = buildUserData({
    domain: bootScriptDomain(state),
    pairingCode: state.pairingCode,
    flavor: 'al2023',
  })
  const result = await driver.createVM({
    userData,
    region: state.region,
    instanceType: state.instanceType,
    name: 'walnut-cloud',
    domainMode: state.domainMode,
    domain: state.domain,
    credentials: ctx.credentials,
  }, ctx.log)
  state.ip = result.ip
  state.instanceRef = result.instanceRef
  state.domain = result.domain
  ctx.log(`VM ready at ${result.ip} — hostname ${result.domain}`)
  return {}
}

/** Manual path only: the operator supplied the IP, so this is bookkeeping. */
async function awaitVm(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  const driver = getDriver(state.provider)
  if (driver?.createVM) return { skipped: true }
  if (!state.ip) {
    return {
      pause: {
        kind: 'vm-ip',
        prompt: 'Enter the public IPv4 address of the VM you created.',
      },
    }
  }
  if (state.domainMode === 'sslip') {
    state.domain = sslipHostname(state.ip)
    ctx.log(`using the automatic hostname ${state.domain}`)
  }
  return {}
}

/**
 * Own-domain only: wait for the A record to point at our IP. After the patience
 * window the job asks for confirmation but KEEPS polling — DNS that lands late
 * should unblock the job on its own, without the operator clicking anything.
 */
async function dnsStep(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  if (state.domainMode === 'sslip') return { skipped: true }
  if (!state.domain) throw new Error('no domain to check DNS for')
  const target = resolveTarget(state.domain)
  if (isLiteralHost(target.hostname)) {
    ctx.log(`${target.hostname} is a literal address — no DNS record to wait for`)
    return { skipped: true }
  }
  if (!state.ip) throw new Error('no IP to match the DNS record against')

  const startedAt = Date.now()
  let askedForConfirmation = false
  ctx.log(`waiting for ${target.hostname} to resolve to ${state.ip} (A record, DNS-only — no CDN proxy)`)
  for (;;) {
    if (ctx.isCancelled()) throw new CloudSetupCancelled()
    // An operator "skip the DNS check" answer wins immediately.
    if (ctx.confirmed()) {
      ctx.log('continuing on your confirmation without a matching A record')
      return {}
    }
    try {
      const addrs = await dns.resolve4(target.hostname)
      if (addrs.includes(state.ip)) {
        ctx.log(`${target.hostname} now resolves to ${state.ip}`)
        return {}
      }
      if (!askedForConfirmation) ctx.log(`${target.hostname} resolves to ${addrs.join(', ')} — still waiting for ${state.ip}`)
    } catch {
      if (!askedForConfirmation) ctx.log(`${target.hostname} does not resolve yet`)
    }
    if (!askedForConfirmation && Date.now() - startedAt > CLOUD_SETUP_TIMINGS.dnsPatienceMs) {
      askedForConfirmation = true
      // A prompt, not a hard stop: the loop keeps polling, so a record that
      // appears in minute 40 resolves the step with no operator action at all.
      ctx.requestConfirmation({
        kind: 'dns-confirm',
        prompt: `${target.hostname} still does not resolve to ${state.ip}. Walnut keeps checking — confirm to continue anyway.`,
      })
      ctx.log('DNS has not propagated yet — still checking in the background.')
    }
    await sleep(CLOUD_SETUP_TIMINGS.dnsIntervalMs)
  }
}

/** Poll the companion's public setup status until it answers. */
async function awaitServer(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  if (!state.domain) throw new Error('no domain to poll')
  const target = resolveTarget(state.domain)
  const statusUrl = `${target.origin}/api/v1/setup/status`
  const deadline = Date.now() + CLOUD_SETUP_TIMINGS.serverBudgetMs
  ctx.log(`waiting for ${target.origin} to finish first boot (clone, build, certificate — usually 5-15 min)`)

  let lastNote = ''
  for (;;) {
    if (ctx.isCancelled()) throw new CloudSetupCancelled()
    try {
      const { status, body } = await fetchJson(statusUrl)
      if (status === 200 && body && typeof body === 'object') {
        const claimed = (body as { claimed?: boolean }).claimed
        if (claimed === false) {
          ctx.log('the companion is up and unclaimed — claiming it now')
          return {}
        }
        if (claimed === true) {
          if (remoteAlreadyPointsAt(target.host)) {
            ctx.log('the companion is already paired with this machine — skipping the claim')
            return {}
          }
          throw new Error(
            `${target.origin} is already claimed by another device, so the pairing code cannot be used. `
            + 'Wipe the box\'s auth.json (or redeploy it) to pair again.',
          )
        }
      }
      const note = `${target.origin} answered ${status} — still booting`
      if (note !== lastNote) { ctx.log(note); lastNote = note }
    } catch (err) {
      if (err instanceof CloudSetupCancelled) throw err
      // A claimed-by-someone-else box is terminal; connection errors are not.
      if (err instanceof Error && err.message.includes('already claimed by another device')) throw err
      const note = `${target.origin} not reachable yet (${err instanceof Error ? err.message : String(err)})`
      if (note !== lastNote) { ctx.log(note); lastNote = note }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${target.origin} did not come up within ${Math.round(CLOUD_SETUP_TIMINGS.serverBudgetMs / 60000)} minutes. `
        + 'Check /var/log/walnut-setup.log on the box, then retry this step.',
      )
    }
    await sleep(CLOUD_SETUP_TIMINGS.serverIntervalMs)
  }
}

/**
 * Claim + wire in one step on purpose: between the claim and initSync we hold
 * the only copy of the device token that will ever exist (the companion returns
 * it once). Splitting them would create a window where a crash loses it and the
 * box is claimed but unusable.
 */
async function claimAndWire(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  if (!state.domain) throw new Error('no domain to claim')
  const target = resolveTarget(state.domain)

  if (remoteAlreadyPointsAt(target.host)) {
    ctx.log('git remote already points at this companion — nothing to claim')
    state.pairingCode = undefined
    return {}
  }
  if (!state.pairingCode) throw new Error('no pairing code — cannot claim')

  const deviceName = selfDeviceName()
  const { status, body } = await fetchJson(`${target.origin}/api/v1/setup/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupToken: state.pairingCode, deviceName }),
  })
  if (status !== 200) {
    const message = (body as { error?: string } | null)?.error ?? `HTTP ${status}`
    throw new Error(`claim rejected by ${target.origin}: ${message}`)
  }
  const token = (body as { token?: string } | null)?.token
  if (!token) throw new Error(`claim succeeded but ${target.origin} returned no device token`)
  ctx.log(`claimed as device "${deviceName}"`)

  // Credentialed remote — the token lives only in .git/config, which setRemote
  // chmods to 0600 (hardenGitConfigPerms).
  initSync(`${target.scheme}//walnut:${token}@${target.host}/git/data`)
  ctx.log('data repo remote configured')
  // The code is spent the moment the claim lands; drop it before the runner's
  // next persist so it never survives a crash.
  state.pairingCode = undefined
  log.web.info('cloud-setup: companion claimed and wired', { host: target.host, deviceName })
  return {}
}

async function verifySync(ctx: StepContext): Promise<StepOutcome> {
  const { state } = ctx
  const target = resolveTarget(state.domain as string)
  ctx.log('pushing the data repo to the companion')
  try {
    const result = await sync()
    ctx.log(`sync ok (pulled ${result.pulled}, pushed ${result.pushed})`)
  } catch (err) {
    throw new Error(`first sync to ${target.origin} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  // Independent proof the credential in .git/config actually authenticates.
  const refs = await gitSafeAsync('ls-remote origin')
  if (refs === null) {
    throw new Error(`the companion at ${target.origin} did not answer git ls-remote — the device token may not have taken effect`)
  }
  ctx.log('companion answered git ls-remote — sync is live')
  return {}
}

async function doneStep(ctx: StepContext): Promise<StepOutcome> {
  const target = resolveTarget(ctx.state.domain as string)
  ctx.log(`cloud companion ready at ${target.origin}`)
  return {}
}

/** Step id → implementation. `force` only affects preflight. */
export function stepRunners(force: boolean): Record<CloudSetupStepId, (ctx: StepContext) => Promise<StepOutcome>> {
  return {
    preflight: (ctx) => preflight(ctx, force),
    generate,
    provision,
    'await-vm': awaitVm,
    dns: dnsStep,
    'await-server': awaitServer,
    'claim-and-wire': claimAndWire,
    'verify-sync': verifySync,
    done: doneStep,
  }
}
