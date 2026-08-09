/**
 * Hetzner Cloud driver — the cheap tier, plain REST, no CLI, no SDK.
 *
 * Everything is `fetch` against https://api.hetzner.cloud/v1 with a bearer token
 * the operator pastes into the wizard. That token is a RUNNER-MEMORY value: it
 * arrives on POST /api/cloud-setup/start, lives in the job's credential map, and
 * must never reach the persisted job, a log line, or an error message — so every
 * throw here goes through redact(), and nothing echoes a request header.
 *
 * Resume safety: createVM adopts an existing `walnut-cloud` server by NAME
 * before it would create one. A job that crashed after the POST but before the
 * poll finished therefore converges on the same box rather than leaving a second
 * one running (and chargeable) with nobody watching it.
 */

import { log } from '../../../logging/index.js'
import { sslipHostname } from '../user-data.js'
import type {
  CloudProviderDriver,
  CreateVMParams,
  CreateVMResult,
  DetectCredsResult,
  DriverInstructions,
  InstructionsParams,
} from './types.js'

const API = 'https://api.hetzner.cloud/v1'

const DEFAULT_LOCATION = 'fsn1'
const IMAGE = 'ubuntu-24.04'

/**
 * Server type per location, because NO single shared-vCPU plan name is orderable
 * in all six locations — verified against Hetzner's own deprecation notices
 * rather than assumed:
 *
 *   - The CX line (Intel/AMD shared) is EU-only, and its Gen2 names (cx22 …)
 *     stopped being orderable on 2026-01-01. Hetzner's notice is explicit that
 *     this "also affects any usage 'by name'", so cx22 is not a valid default.
 *     Gen3 (cx23) replaces it and is cheaper than CPX, but Hetzner currently
 *     shows the whole cost-optimized line as unavailable, so it is documented in
 *     instructions() as the cheaper override rather than used as the default.
 *   - CPX (AMD shared) is the only line present in all six locations, but it too
 *     split: Gen1 (cpx11 …) is now US-only, Gen2 (cpx12 …) is EU + Singapore.
 *
 * Both defaults clear the 2 GB floor the build needs. Anything the operator
 * types in the wizard's placement field wins over all of this.
 */
const DEFAULT_SERVER_TYPE_BY_LOCATION: Record<string, string> = {
  fsn1: 'cpx22', nbg1: 'cpx22', hel1: 'cpx22', sin: 'cpx22',
  ash: 'cpx11', hil: 'cpx11',
}
/** EU Gen2 is the safest guess for a location slug we do not know about yet. */
const FALLBACK_SERVER_TYPE = 'cpx22'

function defaultServerType(location: string): string {
  return DEFAULT_SERVER_TYPE_BY_LOCATION[location] ?? FALLBACK_SERVER_TYPE
}

/** Statuses a freshly created server legitimately passes through on its way up. */
const PENDING_STATUSES = new Set(['initializing', 'starting', 'running'])

const FIREWALL_SUFFIX = '-fw'
/** Hetzner's documented cloud-init user-data ceiling. */
const USER_DATA_MAX_BYTES = 32 * 1024

/**
 * Mutable so tests can shrink the poll loop, the same way CLOUD_SETUP_TIMINGS
 * does for the job's own steps. Nothing in production writes to it.
 */
export const HETZNER_TIMINGS = {
  requestTimeoutMs: 20_000,
  pollIntervalMs: 5_000,
  pollBudgetMs: 5 * 60_000,
}

interface HetznerServer {
  id: number
  name: string
  status: string
  public_net?: { ipv4?: { ip?: string } | null }
}

interface HetznerError { error?: { code?: string; message?: string } }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.() })
}

/**
 * Strip the token from anything operator-visible. The API never echoes it, but
 * a fetch/undici error can quote the request it failed on, and this driver's
 * throws land in logTail → SSE → every REST response carrying the job.
 */
function redact(text: string, token: string): string {
  if (!token) return text
  return text.split(token).join('<redacted>')
}

/** One JSON call. Throws a message that names the cause, never the token. */
async function api<T>(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  pathAndQuery: string,
  body?: unknown,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(HETZNER_TIMINGS.requestTimeoutMs),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(redact(`Hetzner API ${method} ${pathAndQuery} failed: ${message}`, token))
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Hetzner rejected the API token (HTTP ${res.status}). Check that you pasted a Cloud API token `
      + 'with READ & WRITE permission, for the right project (Console → the project → Security → '
      + 'API tokens), and that it has not been revoked.',
    )
  }
  let parsed: unknown = null
  try { parsed = await res.json() } catch { /* empty body (204 on delete) */ }
  if (!res.ok) {
    const apiError = (parsed as HetznerError | null)?.error
    const detail = apiError?.message ?? `HTTP ${res.status}`
    const code = apiError?.code ? ` [${apiError.code}]` : ''
    throw new Error(redact(`Hetzner API ${method} ${pathAndQuery} failed: ${detail}${code}`, token))
  }
  return (parsed ?? {}) as T
}

/**
 * No stored-credential path exists by design: Hetzner has no local CLI login to
 * inherit, so the wizard always asks. `needs: 'api-token'` is what routes the
 * configure screen to its password field (CloudConfigureForm) and paints the
 * "Needs API token" pill (CloudProviderPicker) — the driver is fully usable,
 * it just cannot prove it before the operator types.
 */
async function detectCreds(): Promise<DetectCredsResult> {
  return {
    available: false,
    detail: 'Needs a Hetzner Cloud API token (Console → your project → Security → API tokens, Read & Write).',
    needs: 'api-token',
  }
}

/** Exact-name lookup. Hetzner's `name=` filter is an equality match. */
async function findServerByName(token: string, name: string): Promise<HetznerServer | undefined> {
  const res = await api<{ servers?: HetznerServer[] }>(
    token, 'GET', `/servers?name=${encodeURIComponent(name)}`,
  )
  return (res.servers ?? []).find((s) => s.name === name)
}

/** Idempotent: reuse the firewall if a previous run already made it. */
async function ensureFirewall(token: string, name: string, onLog: (line: string) => void): Promise<number> {
  const existing = await api<{ firewalls?: Array<{ id: number; name: string }> }>(
    token, 'GET', `/firewalls?name=${encodeURIComponent(name)}`,
  )
  const found = (existing.firewalls ?? []).find((f) => f.name === name)
  if (found) {
    onLog(`reusing firewall ${name} (id ${found.id})`)
    return found.id
  }
  // 80 as well as 443: Caddy needs the HTTP-01 challenge to reach it, and the
  // redirect-to-https listener lives there too.
  const created = await api<{ firewall?: { id: number } }>(token, 'POST', '/firewalls', {
    name,
    rules: [80, 443].map((port) => ({
      direction: 'in',
      protocol: 'tcp',
      port: String(port),
      source_ips: ['0.0.0.0/0', '::/0'],
    })),
  })
  const id = created.firewall?.id
  if (id == null) throw new Error('Hetzner created a firewall but returned no id')
  onLog(`created firewall ${name} (id ${id}) — inbound tcp 80 + 443`)
  return id
}

/** Poll until the server reports `running`, then hand back its IPv4. */
async function waitForRunning(
  token: string,
  id: number,
  onLog: (line: string) => void,
): Promise<HetznerServer> {
  const deadline = Date.now() + HETZNER_TIMINGS.pollBudgetMs
  let lastStatus = ''
  for (;;) {
    const { server } = await api<{ server: HetznerServer }>(token, 'GET', `/servers/${id}`)
    if (server.status !== lastStatus) {
      onLog(`server ${id} is ${server.status}`)
      lastStatus = server.status
    }
    if (server.status === 'running') return server
    // The API's full status enum is running/initializing/starting/stopping/off/
    // deleting/migrating/rebuilding/unknown. Only the first three are on the way
    // to a usable box; treat everything else as terminal rather than waiting out
    // the budget on a server that is being torn down.
    if (!PENDING_STATUSES.has(server.status)) {
      throw new Error(
        `Hetzner server ${id} reached status "${server.status}" instead of running — check the `
        + 'server in the Hetzner Console, then retry this step.',
      )
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Hetzner server ${id} did not reach status "running" within `
        + `${Math.round(HETZNER_TIMINGS.pollBudgetMs / 60_000)} minutes (last status "${server.status}"). `
        + 'It may still be starting — retry this step, which adopts the existing server rather than creating another.',
      )
    }
    await sleep(HETZNER_TIMINGS.pollIntervalMs)
  }
}

async function createVM(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult> {
  const token = params.credentials?.trim()
  if (!token) {
    throw new Error('Hetzner provisioning needs a Cloud API token — paste one in the setup wizard.')
  }
  const sslip = params.domainMode === 'sslip'
  if (!sslip && !params.domain) {
    throw new Error('Hetzner provisioning in own-domain mode requires a domain')
  }
  // Checked before any network call: a blob over the ceiling is a programming
  // error in the generator, and the API's own rejection is far less legible.
  const bytes = Buffer.byteLength(params.userData, 'utf-8')
  if (bytes > USER_DATA_MAX_BYTES) {
    throw new Error(
      `The first-boot script is ${bytes} bytes, over Hetzner's ${USER_DATA_MAX_BYTES}-byte `
      + 'cloud-init user-data limit. Shorten it, or use the paste-a-script path.',
    )
  }

  const location = params.region ?? DEFAULT_LOCATION
  const serverType = params.instanceType ?? defaultServerType(location)

  // Adopt first — this is the whole resume contract. A job that died between
  // POST /servers and the poll finishing must converge on the box it already
  // made, not stand up a second one.
  let server = await findServerByName(token, params.name)
  if (server) {
    onLog(`found an existing Hetzner server named ${params.name} (id ${server.id}) — adopting it instead of creating one`)
  } else {
    const firewallId = await ensureFirewall(token, `${params.name}${FIREWALL_SUFFIX}`, onLog)
    onLog(`creating ${serverType} in ${location} from image ${IMAGE}`)
    const created = await api<{ server?: HetznerServer }>(token, 'POST', '/servers', {
      name: params.name,
      server_type: serverType,
      image: IMAGE,
      location,
      user_data: params.userData,
      firewalls: [{ firewall: firewallId }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
      start_after_create: true,
      labels: { managed_by: 'open-walnut' },
    })
    // The create response also carries `root_password` when no SSH key was
    // given. Never touched, never logged: the box is reached over HTTPS, and
    // the pairing code (not a shell) is what claims it.
    if (!created.server?.id) throw new Error('Hetzner accepted the create call but returned no server')
    server = created.server
    onLog(`server ${server.id} created — waiting for it to boot`)
  }

  const running = server.status === 'running' ? server : await waitForRunning(token, server.id, onLog)
  const ip = running.public_net?.ipv4?.ip
  if (!ip) {
    throw new Error(
      `Hetzner server ${running.id} is running but has no public IPv4 address. `
      + 'Attach one in the Console (or recreate with IPv4 enabled), then retry.',
    )
  }

  log.web.info('cloud-setup: hetzner server ready', { serverId: running.id, location, serverType })
  return {
    ip,
    instanceRef: String(running.id),
    domain: sslip ? sslipHostname(ip) : (params.domain as string),
  }
}

function instructions(params: InstructionsParams): DriverInstructions {
  const location = params.region ?? DEFAULT_LOCATION
  const serverType = params.instanceType ?? defaultServerType(location)
  const dnsStep = params.domainMode === 'sslip'
    ? 'No DNS record to create — the box serves itself at `<dashed-ip>.sslip.io`, derived from its own public IP on first boot.'
    : `Point an A record for ${params.domain} at the server's public IPv4 (DNS-only, no CDN proxy — Caddy terminates TLS itself).`
  return {
    steps: [
      'In the Hetzner Cloud Console, open (or create) a project, then Servers → Add Server.',
      `Location: ${location} (EU: fsn1/nbg1/hel1, US: ash/hil, Asia: sin).`,
      `Image: Ubuntu 24.04. Type: ${serverType}, or anything with at least 2 GB RAM (the build needs the headroom; the script adds swap).`,
      'Plan naming moves around: the CX line is EU-only and its cx22 generation is no longer orderable, so CPX is the safe pick (cpx22 in the EU/Singapore, cpx11 in the US). cx23 is cheaper than cpx22 when Hetzner has it in stock.',
      'Open the "Cloud config" / User data field and paste the script below into it verbatim.',
      'Firewalls: allow inbound TCP 80 and 443 from 0.0.0.0/0 and ::/0 (80 is required for the certificate challenge).',
      'Make sure a public IPv4 address is enabled, then create the server.',
      dnsStep,
      'First boot takes 5-15 minutes; follow it from the Console\'s web console with: tail -f /var/log/walnut-setup.log',
    ],
    userData: params.userData,
    consoleUrl: 'https://console.hetzner.cloud/',
  }
}

export const hetznerDriver: CloudProviderDriver = {
  id: 'hetzner',
  label: 'Hetzner Cloud',
  // CPX22 (EU) ~€11.5/mo + ~€0.50/mo for the primary IPv4. US is dearer: CPX11
  // is ~€17.5/mo. Quote the EU default and name the cheaper override, rather
  // than advertising the retired CX22's ~€4/mo that nobody can order.
  costHint: '~€12/mo — CPX22 (2 vCPU, 4 GB) + IPv4 in the EU; cx23 is cheaper when in stock',
  // Hetzner has no AL2023 image; the boot script must reach for apt first.
  userDataFlavor: 'ubuntu',
  detectCreds,
  createVM,
  instructions,
  // No teardown on purpose: the contract is teardown(instanceRef, onLog), which
  // carries no credentials, and DELETE /servers/{id} cannot be authorized
  // without the token. Widening the interface for one provider would be worse
  // than the honest gap — deleting the server in the Console is one click.
}
