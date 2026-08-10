/**
 * Azure driver — everything through the operator's own `az` CLI.
 *
 * No SDK, no service principal, no credential Walnut ever holds: `az` inherits
 * the login already on the machine, which is why detectCreds reports
 * `needs: 'cli-login'` rather than asking for a token. If `az` is absent the
 * wizard paints "CLI missing or signed out" and the operator takes the manual
 * paste path — that routing is already in CloudProviderPicker, so this driver
 * only has to be honest about what it found.
 *
 * Resume safety, same contract as hetzner: createVM adopts an existing VM by
 * NAME inside the walnut-cloud resource group before it would create one, so a
 * job that died mid-provision converges on the box it already made rather than
 * leaving a second chargeable VM behind.
 *
 * Every resource lands in ONE resource group (walnut-cloud) so teardown is a
 * single documented command the operator can run without Walnut's help.
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

const RESOURCE_GROUP = 'walnut-cloud'
const PUBLIC_IP_NAME = 'walnut-cloud-ip'
const NSG_NAME = 'walnut-cloud-nsg'
const DEFAULT_LOCATION = 'eastus'
/**
 * B2ats_v2 — 2 vCPU / 1 GiB, the cheapest v2 burstable that still has 2 vCPUs.
 * 1 GiB is under the build's comfort line on paper, but setup.sh adds a 2 GB
 * swapfile, and the Bs-series is the only line at this price point. An operator
 * who wants headroom overrides with B2as_v2 (2 vCPU / 8 GiB) in the wizard's
 * placement field.
 */
const DEFAULT_SIZE = 'Standard_B2ats_v2'
/** Canonical's URN alias for Ubuntu 24.04 LTS; `az` resolves it to the image. */
const IMAGE = 'Ubuntu2404'
const ADMIN_USERNAME = 'walnut'

export const AZURE_TIMINGS = {
  detectMs: 5_000,
  /** Group/IP/NSG calls: fast control-plane operations. */
  shortMs: 3 * 60_000,
  /** `az vm create` waits for the VM to be allocated and running. */
  createMs: 15 * 60_000,
}

interface AzurePublicIp { ipAddress?: string | null }
/** `az vm list-ip-addresses` returns one entry per VM. */
interface AzureVmIpEntry {
  virtualMachine?: { network?: { publicIpAddresses?: AzurePublicIp[] } }
}

/**
 * Run `az`, throwing an operator-legible error on non-zero exit. `az` puts its
 * real diagnosis on stderr ("ResourceGroupNotFound", quota messages, …), which
 * cliErrorDetail surfaces — a bare exit code would strand the operator.
 */
async function az(
  args: string[],
  onLog: ((line: string) => void) | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CliResult> {
  const res = await runCli('az', args, { timeoutMs, onLog, signal })
  if (res.code !== 0) {
    const detail = cliErrorDetail(res)
    throw new Error(`az ${cliVerb(args)} failed (exit ${res.code})${detail ? `: ${detail}` : ''}`)
  }
  return res
}

/** Same call, but a non-zero exit is an ANSWER (absent / already-exists), not a throw. */
async function azSoft(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<CliResult> {
  return runCli('az', args, { timeoutMs, signal })
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`az returned output that is not JSON for ${what}`)
  }
}

async function detectCreds(): Promise<DetectCredsResult> {
  const notReady = (detail: string): DetectCredsResult => ({ available: false, detail, needs: 'cli-login' })
  let res: CliResult
  try {
    res = await runCli('az', ['account', 'show', '-o', 'json'], { timeoutMs: AZURE_TIMINGS.detectMs })
  } catch (err) {
    if (err instanceof CliMissingError) {
      return notReady('Install the Azure CLI (az) and run az login, or use the manual path.')
    }
    // A timeout or a spawn failure that is not ENOENT: the CLI exists but did
    // not answer, which is still "not ready" from the wizard's point of view.
    return notReady('The az CLI did not respond. Run `az login`, then re-check.')
  }
  if (res.code !== 0) {
    return notReady('The az CLI is installed but not signed in. Run `az login`, then re-check.')
  }
  // Only the subscription NAME is surfaced. The id is a tenant-identifying
  // value and this string is rendered in the wizard and written to the log.
  const account = parseJsonSafe<{ name?: string }>(res.stdout)
  return {
    available: true,
    detail: account?.name ? `Azure CLI — subscription ${account.name}` : 'Azure CLI signed in',
    needs: 'nothing',
  }
}

/** Public IP of an existing VM, via the group+name the adopt path found. */
async function adoptedVmIp(
  name: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await az(
    ['vm', 'list-ip-addresses', '-g', RESOURCE_GROUP, '-n', name, '-o', 'json'],
    onLog,
    AZURE_TIMINGS.shortMs,
    signal,
  )
  const entries = parseJson<AzureVmIpEntry[]>(res.stdout, 'vm list-ip-addresses')
  for (const entry of entries) {
    for (const ip of entry.virtualMachine?.network?.publicIpAddresses ?? []) {
      if (ip.ipAddress) return ip.ipAddress
    }
  }
  return undefined
}

/**
 * Idempotent static public IP. Created BEFORE the VM so the address is stable
 * across a stop/start — a dynamic Azure IP changes on deallocation, which would
 * silently break both an own-domain A record and the sslip hostname.
 *
 * `az network public-ip create` is a PUT: re-running it against an existing IP
 * returns the same resource rather than failing, so no adopt branch is needed.
 */
async function ensurePublicIp(
  location: string,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await az([
    'network', 'public-ip', 'create',
    '-g', RESOURCE_GROUP, '-n', PUBLIC_IP_NAME, '-l', location,
    '--sku', 'Standard', '--allocation-method', 'Static',
    '-o', 'json',
  ], onLog, AZURE_TIMINGS.shortMs, signal)
  const parsed = parseJson<{ publicIp?: AzurePublicIp } & AzurePublicIp>(res.stdout, 'public-ip create')
  // `create` wraps the resource in {publicIp}; `show` returns it bare. Accept both.
  const ip = parsed.publicIp?.ipAddress ?? parsed.ipAddress
  if (!ip) {
    throw new Error(
      `Azure created the static IP ${PUBLIC_IP_NAME} but reported no address. `
      + `Check it with: az network public-ip show -g ${RESOURCE_GROUP} -n ${PUBLIC_IP_NAME}`,
    )
  }
  return ip
}

async function createVM(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult> {
  const sslip = params.domainMode === 'sslip'
  if (!sslip && !params.domain) {
    throw new Error('Azure provisioning in own-domain mode requires a domain')
  }
  const location = params.region ?? DEFAULT_LOCATION
  const size = params.instanceType ?? DEFAULT_SIZE

  // `az group create` is idempotent (PUT) and cheap; running it first means
  // every later call has a group to talk to even on a fresh subscription.
  onLog(`ensuring resource group ${RESOURCE_GROUP} in ${location}`)
  await az(
    ['group', 'create', '-n', RESOURCE_GROUP, '-l', location, '-o', 'json'],
    onLog, AZURE_TIMINGS.shortMs, params.signal,
  )

  // Adopt before create — the resume contract. A soft call because "not found"
  // is the normal first-run answer, not a failure.
  const existing = await azSoft(
    ['vm', 'show', '-g', RESOURCE_GROUP, '-n', params.name, '-o', 'json'],
    AZURE_TIMINGS.shortMs,
    params.signal,
  )
  if (existing.code === 0) {
    onLog(`found an existing Azure VM named ${params.name} in ${RESOURCE_GROUP} — adopting it instead of creating one`)
    const adoptedIp = await adoptedVmIp(params.name, onLog, params.signal)
    if (!adoptedIp) {
      throw new Error(
        `Azure VM ${params.name} exists but has no public IP address. Attach one in the portal `
        + '(or delete the VM and retry this step), then retry.',
      )
    }
    log.web.info('cloud-setup: azure vm adopted', { location, size })
    return {
      ip: adoptedIp,
      instanceRef: `${RESOURCE_GROUP}/${params.name}`,
      domain: sslip ? sslipHostname(adoptedIp) : (params.domain as string),
    }
  }

  const ip = await ensurePublicIp(location, onLog, params.signal)
  onLog(`static public IP ${PUBLIC_IP_NAME} is ${ip}`)

  // The boot script goes through a 0600 tempfile, never the argv: it embeds the
  // pairing code, and this driver echoes its own command lines to the operator log.
  await withSecretFile('walnut-az-', 'cloud-init.sh', params.userData, async (userDataFile) => {
    // az REQUIRES an admin credential for a Linux VM, and its own
    // --generate-ssh-keys writes into the operator's ~/.ssh (the docs are
    // explicit: "the keys will be stored in the ~/.ssh directory"). Nobody ever
    // logs into this box — it is reached over HTTPS and claims itself with the
    // pairing code — so generate a throwaway key inside the temp dir this
    // callback owns and hand az only its PUBLIC half. The private key is deleted
    // with the dir, and no key of the operator's is read, written or reused.
    //
    // NOT --ssh-dest-key-path: despite the name that is a path ON THE VM
    // (authorized_keys), not a local destination.
    const keyFile = `${userDataFile}.key`
    await runCli('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'open-walnut-throwaway', '-f', keyFile], {
      timeoutMs: AZURE_TIMINGS.shortMs,
      signal: params.signal,
    }).then((res) => {
      if (res.code !== 0) {
        throw new Error(
          'Could not generate a throwaway SSH key for the VM (az requires an admin credential): '
          + `ssh-keygen exited ${res.code}${cliErrorDetail(res) ? `: ${cliErrorDetail(res)}` : ''}`,
        )
      }
    })

    onLog(`creating ${size} in ${location} from image ${IMAGE} — this usually takes 2-5 minutes`)
    await az([
      'vm', 'create',
      '-g', RESOURCE_GROUP, '-n', params.name, '-l', location,
      '--image', IMAGE, '--size', size,
      '--public-ip-address', PUBLIC_IP_NAME,
      '--nsg', NSG_NAME,
      // Without this az seeds a brand-new NSG with an inbound SSH rule. Nothing
      // here uses SSH, so start closed and let `vm open-port` add 80/443 only.
      '--nsg-rule', 'NONE',
      '--admin-username', ADMIN_USERNAME,
      '--ssh-key-values', `${keyFile}.pub`,
      '--custom-data', userDataFile,
      '-o', 'json',
    ], onLog, AZURE_TIMINGS.createMs, params.signal)
  })

  // 80 as well as 443: Caddy's HTTP-01 challenge lands on 80, and so does the
  // redirect-to-https listener. `az vm open-port` edits the NSG created above.
  onLog('opening inbound tcp 80 and 443')
  await az([
    'vm', 'open-port', '-g', RESOURCE_GROUP, '-n', params.name,
    '--port', '80,443', '--priority', '1001', '-o', 'json',
  ], onLog, AZURE_TIMINGS.shortMs, params.signal)

  log.web.info('cloud-setup: azure vm created', { location, size })
  return {
    ip,
    instanceRef: `${RESOURCE_GROUP}/${params.name}`,
    domain: sslip ? sslipHostname(ip) : (params.domain as string),
  }
}

function instructions(params: InstructionsParams): DriverInstructions {
  const location = params.region ?? DEFAULT_LOCATION
  const size = params.instanceType ?? DEFAULT_SIZE
  const dnsStep = params.domainMode === 'sslip'
    ? 'No DNS record to create — the box serves itself at `<dashed-ip>.sslip.io`, derived from its own public IP on first boot.'
    : `Point an A record for ${params.domain} at the static public IP (DNS-only, no CDN proxy — Caddy terminates TLS itself).`
  return {
    steps: [
      'Sign in first: `az login` (or in the portal, Virtual machines → Create → Azure virtual machine).',
      `Resource group: \`az group create -n ${RESOURCE_GROUP} -l ${location}\` — keeping everything in one group makes teardown one command.`,
      `Static IP: \`az network public-ip create -g ${RESOURCE_GROUP} -n ${PUBLIC_IP_NAME} --sku Standard --allocation-method Static\`. Static, not dynamic: a dynamic address changes when the VM is deallocated and would break your DNS record.`,
      `Image: Ubuntu 24.04 LTS (\`--image ${IMAGE}\`). Size: ${size}, or anything with 2 vCPUs (the script adds a 2 GB swapfile, so 1 GiB of RAM is workable).`,
      'Save the script below to a file, then pass it as `--custom-data <file>` (in the portal it is Advanced → Custom data). Use a file rather than pasting it on a command line — it contains a one-time pairing code.',
      `Create: \`az vm create -g ${RESOURCE_GROUP} -n walnut-cloud --image ${IMAGE} --size ${size} --public-ip-address ${PUBLIC_IP_NAME} --nsg ${NSG_NAME} --custom-data ./cloud-init.sh\`.`,
      `Open ports: \`az vm open-port -g ${RESOURCE_GROUP} -n walnut-cloud --port 80,443\` (80 is required for the certificate challenge).`,
      dnsStep,
      'First boot takes 5-15 minutes; follow it with `az vm run-command invoke -g walnut-cloud -n walnut-cloud --command-id RunShellScript --scripts "tail -n 50 /var/log/walnut-setup.log"`.',
    ],
    userData: params.userData,
    consoleUrl: 'https://portal.azure.com/#browse/Microsoft.Compute%2FVirtualMachines',
  }
}

export const azureDriver: CloudProviderDriver = {
  id: 'azure',
  label: 'Azure (VM via az CLI)',
  // B2ats_v2 (2 vCPU / 1 GiB) is the cheapest v2 burstable: ~$5/mo of compute in
  // eastus pay-as-you-go, plus ~$3/mo for a Standard static IPv4 and ~$2/mo for
  // a 30 GiB standard SSD OS disk. Quote the all-in figure, not the compute line
  // alone — the IP and disk are more than half of it at this size.
  costHint: '~$10/mo — B2ats_v2 (2 vCPU, 1 GiB) + static IP + 30 GiB OS disk',
  // No AL2023 on Azure; the boot script must reach for apt first.
  userDataFlavor: 'ubuntu',
  detectCreds,
  createVM,
  instructions,
  // No teardown on purpose. The honest unit of deletion here is the whole
  // resource group — deleting just the VM strands the static IP, the NSG, the
  // NIC and the OS disk, all of which keep charging. The contract's
  // teardown(instanceRef) cannot express "and everything around it" safely, and
  // an implementation that deleted a group the operator may have put other
  // things in would be worse than the documented one-liner:
  //   az group delete -n walnut-cloud
}
