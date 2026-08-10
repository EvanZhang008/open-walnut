/**
 * GCP driver — everything through the operator's own `gcloud` CLI.
 *
 * Like azure, no SDK and no credential Walnut holds: `gcloud` carries both the
 * active account and the target project, so detectCreds has TWO things to check
 * (signed in, and a project actually configured) and reports `needs: 'cli-login'`
 * for either gap. A missing CLI routes the wizard to the manual paste path.
 *
 * Resume safety: createVM adopts an existing instance by NAME in the target zone
 * before it would create one, so a job that died mid-provision converges on the
 * box it already made.
 *
 * ALREADY_EXISTS tolerance: unlike Azure's PUT-shaped `create`, gcloud's create
 * verbs are strict POSTs — re-running one against an existing address or
 * firewall rule exits non-zero. That is a SUCCESS for our purposes (the resource
 * we wanted is there), so those two calls check for the marker rather than
 * throwing. The instance create is deliberately NOT in that set: a name
 * collision there means the adopt check above should have caught it, and
 * swallowing it would hide a real bug.
 */

import { log } from '../../../logging/index.js'
import { sslipHostname } from '../user-data.js'
import {
  cliErrorDetail, CliMissingError, cliVerb, parseJsonSafe, runCli, withSecretFile, type CliResult,
} from './cli-exec.js'
import type {
  CloudProviderDriver,
  CreateVMParams,
  CreateVMResult,
  DetectCredsResult,
  DriverInstructions,
  InstructionsParams,
} from './types.js'

const ADDRESS_NAME = 'walnut-cloud-ip'
const FIREWALL_NAME = 'walnut-cloud-web'
const NETWORK_TAG = 'walnut-cloud'
const DEFAULT_ZONE = 'us-central1-a'
/** e2-small — 2 vCPU (shared) / 2 GiB, the cheapest size that clears the 2 GB floor. */
const DEFAULT_MACHINE_TYPE = 'e2-small'
const IMAGE_FAMILY = 'ubuntu-2404-lts-amd64'
const IMAGE_PROJECT = 'ubuntu-os-cloud'

export const GCP_TIMINGS = {
  detectMs: 5_000,
  shortMs: 3 * 60_000,
  createMs: 15 * 60_000,
}

/** `us-central1-a` → `us-central1`. Addresses are regional, instances zonal. */
export function regionFromZone(zone: string): string {
  const parts = zone.split('-')
  return parts.length > 2 ? parts.slice(0, -1).join('-') : zone
}

async function gcloud(
  args: string[],
  onLog: ((line: string) => void) | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CliResult> {
  const res = await runCli('gcloud', args, { timeoutMs, onLog, signal })
  if (res.code !== 0) {
    const detail = cliErrorDetail(res)
    throw new Error(`gcloud ${cliVerb(args)} failed (exit ${res.code})${detail ? `: ${detail}` : ''}`)
  }
  return res
}

/** Non-zero exit is an answer, not a throw (absent resource / already exists). */
async function gcloudSoft(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliResult> {
  return runCli('gcloud', args, { timeoutMs, signal })
}

/**
 * gcloud reports a duplicate as `ALREADY_EXISTS` in the error body, sometimes
 * phrased as "already exists". Match either, so a retried job does not fail on
 * a resource a previous attempt already made.
 */
function isAlreadyExists(res: CliResult): boolean {
  return /ALREADY_EXISTS|already exists/i.test(res.output)
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`gcloud returned output that is not JSON for ${what}`)
  }
}

interface GcpInstance {
  networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string | null }> }>
}

/** First external address on an instance description, if it has one. */
function instanceNatIp(instance: GcpInstance): string | undefined {
  for (const nic of instance.networkInterfaces ?? []) {
    for (const cfg of nic.accessConfigs ?? []) {
      if (cfg.natIP) return cfg.natIP
    }
  }
  return undefined
}

async function detectCreds(): Promise<DetectCredsResult> {
  const notReady = (detail: string): DetectCredsResult => ({ available: false, detail, needs: 'cli-login' })

  let project: CliResult
  try {
    project = await runCli('gcloud', ['config', 'get-value', 'project'], { timeoutMs: GCP_TIMINGS.detectMs })
  } catch (err) {
    if (err instanceof CliMissingError) {
      return notReady('Install the Google Cloud CLI (gcloud) and run gcloud init, or use the manual path.')
    }
    return notReady('The gcloud CLI did not respond. Run `gcloud init`, then re-check.')
  }
  // `get-value` prints the literal '(unset)' and still exits 0 when no project
  // is configured, so an exit-code check alone would report a false ready.
  const projectId = project.code === 0 ? project.stdout.trim() : ''
  if (!projectId || projectId === '(unset)') {
    return notReady('The gcloud CLI has no project set. Run `gcloud config set project <project-id>`, then re-check.')
  }

  const accounts = await gcloudSoft(
    ['auth', 'list', '--filter=status:ACTIVE', '--format=json'],
    GCP_TIMINGS.detectMs,
  )
  const active = accounts.code === 0
    ? (parseJsonSafe<unknown[]>(accounts.stdout) ?? []).length > 0
    : false
  if (!active) {
    return notReady('The gcloud CLI is installed but has no active account. Run `gcloud auth login`, then re-check.')
  }
  // The project id is operator-chosen and appears throughout their own console;
  // the account email is NOT surfaced — that is a personal identifier.
  return { available: true, detail: `Google Cloud CLI — project ${projectId}`, needs: 'nothing' }
}

/**
 * Idempotent regional static address. Reserved BEFORE the instance so the IP
 * survives a stop/start — an ephemeral GCP address is released on stop, which
 * would break both an own-domain A record and the sslip hostname.
 */
async function ensureAddress(
  region: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const created = await gcloudSoft(
    ['compute', 'addresses', 'create', ADDRESS_NAME, '--region', region],
    GCP_TIMINGS.shortMs,
    signal,
  )
  if (created.code === 0) {
    onLog(`reserved static address ${ADDRESS_NAME} in ${region}`)
  } else if (isAlreadyExists(created)) {
    onLog(`static address ${ADDRESS_NAME} already exists in ${region} — reusing it`)
  } else {
    const detail = cliErrorDetail(created)
    throw new Error(`gcloud compute addresses create failed (exit ${created.code})${detail ? `: ${detail}` : ''}`)
  }

  // Always describe, whether we just created it or adopted one: `create` prints
  // a human table, not the address, and only `describe --format=json` is stable.
  const shown = await gcloud(
    ['compute', 'addresses', 'describe', ADDRESS_NAME, '--region', region, '--format=json'],
    onLog,
    GCP_TIMINGS.shortMs,
    signal,
  )
  const { address } = parseJson<{ address?: string }>(shown.stdout, 'addresses describe')
  if (!address) {
    throw new Error(
      `GCP reserved ${ADDRESS_NAME} but reported no address. Check it with: `
      + `gcloud compute addresses describe ${ADDRESS_NAME} --region ${region}`,
    )
  }
  return address
}

/** Idempotent firewall rule for 80 + 443, scoped to our network tag. */
async function ensureFirewall(onLog: (line: string) => void, signal?: AbortSignal): Promise<void> {
  // Tag-scoped rather than open to every instance in the project: the operator's
  // other VMs in this project must not inherit an inbound web rule from us.
  const res = await gcloudSoft([
    'compute', 'firewall-rules', 'create', FIREWALL_NAME,
    // 80 matters as much as 443: Caddy's HTTP-01 challenge lands there.
    '--allow', 'tcp:80,tcp:443',
    '--target-tags', NETWORK_TAG,
    '--source-ranges', '0.0.0.0/0',
    '--description', 'open-walnut cloud companion: inbound web',
  ], GCP_TIMINGS.shortMs, signal)
  if (res.code === 0) {
    onLog(`created firewall rule ${FIREWALL_NAME} — inbound tcp 80 + 443 on tag ${NETWORK_TAG}`)
    return
  }
  if (isAlreadyExists(res)) {
    onLog(`firewall rule ${FIREWALL_NAME} already exists — reusing it`)
    return
  }
  const detail = cliErrorDetail(res)
  throw new Error(`gcloud compute firewall-rules create failed (exit ${res.code})${detail ? `: ${detail}` : ''}`)
}

async function createVM(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult> {
  const sslip = params.domainMode === 'sslip'
  if (!sslip && !params.domain) {
    throw new Error('GCP provisioning in own-domain mode requires a domain')
  }
  const zone = params.region ?? DEFAULT_ZONE
  const region = regionFromZone(zone)
  const machineType = params.instanceType ?? DEFAULT_MACHINE_TYPE

  // Adopt before create — the resume contract.
  const existing = await gcloudSoft(
    ['compute', 'instances', 'describe', params.name, '--zone', zone, '--format=json'],
    GCP_TIMINGS.shortMs,
    params.signal,
  )
  if (existing.code === 0) {
    onLog(`found an existing GCP instance named ${params.name} in ${zone} — adopting it instead of creating one`)
    const adoptedIp = instanceNatIp(parseJson<GcpInstance>(existing.stdout, 'instances describe'))
    if (!adoptedIp) {
      throw new Error(
        `GCP instance ${params.name} exists but has no external IP address. Add one in the console `
        + '(or delete the instance and retry this step), then retry.',
      )
    }
    log.web.info('cloud-setup: gcp instance adopted', { zone, machineType })
    return {
      ip: adoptedIp,
      instanceRef: `${zone}/${params.name}`,
      domain: sslip ? sslipHostname(adoptedIp) : (params.domain as string),
    }
  }

  const ip = await ensureAddress(region, onLog, params.signal)
  onLog(`static address ${ADDRESS_NAME} is ${ip}`)
  await ensureFirewall(onLog, params.signal)

  // The boot script goes through a 0600 tempfile, never the argv: it embeds the
  // pairing code, and this driver echoes its own command lines to the operator
  // log. GCP re-runs a startup-script on EVERY boot, not just the first — that
  // is safe here because the script is idempotent (it re-clones into /opt/walnut
  // and re-runs setup.sh, which no-ops on an already-configured box).
  await withSecretFile('walnut-gcp-', 'startup-script.sh', params.userData, async (userDataFile) => {
    onLog(`creating ${machineType} in ${zone} from ${IMAGE_FAMILY} — this usually takes 1-3 minutes`)
    await gcloud([
      'compute', 'instances', 'create', params.name,
      '--zone', zone,
      '--machine-type', machineType,
      '--image-family', IMAGE_FAMILY,
      '--image-project', IMAGE_PROJECT,
      '--tags', NETWORK_TAG,
      '--address', ip,
      '--metadata-from-file', `startup-script=${userDataFile}`,
      '--format=json',
    ], onLog, GCP_TIMINGS.createMs, params.signal)
  })

  log.web.info('cloud-setup: gcp instance created', { zone, machineType })
  return {
    ip,
    instanceRef: `${zone}/${params.name}`,
    domain: sslip ? sslipHostname(ip) : (params.domain as string),
  }
}

function instructions(params: InstructionsParams): DriverInstructions {
  const zone = params.region ?? DEFAULT_ZONE
  const region = regionFromZone(zone)
  const machineType = params.instanceType ?? DEFAULT_MACHINE_TYPE
  const dnsStep = params.domainMode === 'sslip'
    ? 'No DNS record to create — the box serves itself at `<dashed-ip>.sslip.io`, derived from its own public IP on first boot.'
    : `Point an A record for ${params.domain} at the reserved static address (DNS-only, no CDN proxy — Caddy terminates TLS itself).`
  return {
    steps: [
      'Sign in and pick a project first: `gcloud auth login` then `gcloud config set project <project-id>`.',
      `Static address: \`gcloud compute addresses create ${ADDRESS_NAME} --region ${region}\`, then read it with \`gcloud compute addresses describe ${ADDRESS_NAME} --region ${region}\`. Reserved, not ephemeral: an ephemeral address is released when the instance stops and would break your DNS record.`,
      `Firewall: \`gcloud compute firewall-rules create ${FIREWALL_NAME} --allow tcp:80,tcp:443 --target-tags ${NETWORK_TAG} --source-ranges 0.0.0.0/0\` (80 is required for the certificate challenge).`,
      `Image: Ubuntu 24.04 LTS (\`--image-family ${IMAGE_FAMILY} --image-project ${IMAGE_PROJECT}\`). Machine type: ${machineType}, or anything with at least 2 GB RAM.`,
      'Save the script below to a file and pass it as `--metadata-from-file startup-script=<file>` (in the console it is Advanced options → Management → Automation → Startup script). Use a file rather than pasting it on a command line — it contains a one-time pairing code.',
      `Create: \`gcloud compute instances create walnut-cloud --zone ${zone} --machine-type ${machineType} --image-family ${IMAGE_FAMILY} --image-project ${IMAGE_PROJECT} --tags ${NETWORK_TAG} --address ${ADDRESS_NAME} --metadata-from-file startup-script=./startup-script.sh\`.`,
      dnsStep,
      `First boot takes 5-15 minutes; follow it with \`gcloud compute ssh walnut-cloud --zone ${zone} --command "tail -f /var/log/walnut-setup.log"\`.`,
    ],
    userData: params.userData,
    consoleUrl: 'https://console.cloud.google.com/compute/instances',
  }
}

export const gcpDriver: CloudProviderDriver = {
  id: 'gcp',
  label: 'Google Cloud (VM via gcloud CLI)',
  // e2-small (2 shared vCPU / 2 GiB) is ~$12-13/mo of compute at on-demand
  // us-central1 rates, plus ~$1-2/mo for the boot disk. A reserved address is
  // free WHILE ATTACHED to a running instance and only starts charging once it
  // is not — which is why teardown has to delete it explicitly.
  costHint: '~$14/mo — e2-small (2 vCPU, 2 GiB) + boot disk, static IP free while attached',
  // No AL2023 on GCP; the boot script must reach for apt first.
  userDataFlavor: 'ubuntu',
  detectCreds,
  createVM,
  instructions,
  // No teardown on purpose, for the same reason as azure: deleting the instance
  // alone strands the reserved address (which DOES start charging once it is
  // unattached) and the firewall rule. The honest sequence, documented rather
  // than automated so the operator sees what goes away:
  //   gcloud compute instances delete walnut-cloud --zone <zone>
  //   gcloud compute addresses delete walnut-cloud-ip --region <region>
  //   gcloud compute firewall-rules delete walnut-cloud-web
}
