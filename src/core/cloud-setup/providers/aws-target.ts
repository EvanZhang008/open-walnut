/**
 * Where an aws deploy lands: the account the credentials reach and the region.
 *
 * The CDK app takes both from the deploy child's environment, so without a
 * record a resumed job deploys wherever the ambient default points at that
 * moment, and the fixed stack name then names a NEW stack there. The job
 * records both once (resolveAwsTarget); every deploy passes the region
 * explicitly and checks the account first (verifyAwsAccount), and the CDK app
 * itself is pinned to both through `-c account` / `-c region`.
 */

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import type { CloudSetupTarget } from '../job-types.js'
import { CloudTargetChangedError, type ResolveTargetParams } from './types.js'

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 8_000
/** What the CDK CLI uses when neither the environment nor the profile names a region. */
export const CDK_FALLBACK_REGION = 'us-east-1'
const ACCOUNT_RE = /^\d{12}$/
const IMDS = 'http://169.254.169.254'
/** us-east-1, eu-central-2, us-gov-west-1, cn-north-1, eusc-de-east-1 ... (it also reaches argv). */
const REGION_RE = /^[a-z]{2,4}(-[a-z0-9]+)+-\d{1,2}$/

/**
 * The environment an `aws`/`cdk` child should run with.
 *
 * An explicitly chosen profile wins over whatever Walnut itself was started with,
 * and AWS_DEFAULT_PROFILE is cleared alongside it: the CLI honours that variable
 * too, so leaving a stale one in place could silently send the deploy to a
 * different account than the wizard displayed.
 */
export function envForProfile(profile: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!profile) return base
  return { ...base, AWS_PROFILE: profile, AWS_DEFAULT_PROFILE: profile }
}

export function isAwsRegion(value: string | undefined): value is string {
  return !!value && REGION_RE.test(value)
}

/** The account id the credentials in `env` reach. Throws an operator-legible error. */
export async function callerAccount(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  let account: string | undefined
  try {
    const { stdout } = await execFileAsync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      timeout: TIMEOUT_MS,
      env,
      signal,
    })
    account = (JSON.parse(stdout) as { Account?: string }).Account
  } catch (err) {
    if (signal?.aborted) throw new Error('aws sts get-caller-identity cancelled')
    // Classified, never quoted: the CLI's text can carry the caller ARN (a user
    // name) or the profile name.
    const e = err as { stderr?: unknown; message?: unknown }
    const text = `${String(e.stderr ?? '')} ${String(e.message ?? '')}`
    const signIn = /ExpiredToken|InvalidClientTokenId|UnrecognizedClient|SignatureDoesNotMatch|Unable to locate credentials|sso|expired|could not be found/i
    throw new Error(signIn.test(text)
      ? 'Walnut could not confirm which AWS account your credentials reach: they are missing or expired. '
        + 'Sign in again (for SSO: `aws sso login`), then retry.'
      : 'Walnut could not confirm which AWS account your credentials reach: aws sts get-caller-identity failed '
        + '(the network, throttling, or the CLI itself). Retry in a moment.')
  }
  if (!account || !ACCOUNT_RE.test(account)) {
    throw new Error('aws sts get-caller-identity returned no account id, so Walnut cannot tell where it would deploy.')
  }
  return account
}

/**
 * The region the CDK CLI would pick from `env`, in its own order: AWS_REGION,
 * AMAZON_REGION, AWS_DEFAULT_REGION, AMAZON_DEFAULT_REGION, the profile's
 * `region` (credentials file, then config), the same for [default], the EC2
 * instance metadata when this host is an EC2 instance, then us-east-1.
 */
async function ambientRegion(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ region: string; source: string }> {
  for (const name of ['AWS_REGION', 'AMAZON_REGION', 'AWS_DEFAULT_REGION', 'AMAZON_DEFAULT_REGION']) {
    const value = env[name]?.trim()
    if (value) return { region: value, source: name }
  }
  // CDK's profile choice, named explicitly so the CLI reads the same section.
  const profile = env.AWS_PROFILE?.trim() || env.AWS_DEFAULT_PROFILE?.trim() || 'default'
  const fromProfile = await profileRegion(profile, env, signal)
  if (fromProfile) return { region: fromProfile, source: 'the AWS profile config' }
  if (profile !== 'default') {
    const fromDefault = await profileRegion('default', env, signal)
    if (fromDefault) return { region: fromDefault, source: 'the [default] AWS profile config' }
  }
  const fromInstance = await instanceRegion(signal)
  if (fromInstance) return { region: fromInstance, source: 'this EC2 instance\'s metadata' }
  return { region: CDK_FALLBACK_REGION, source: 'no region configured, the CDK default' }
}

/** CDK's own EC2 test: the board asset tag is an instance id (Linux, Windows) or the Xen uuid starts with ec2. */
async function detectEc2(): Promise<boolean> {
  const read = (file: string): Promise<string> => fs.readFile(file, 'utf-8').then((t) => t.trim(), () => '')
  if (process.platform === 'linux') {
    return (await read('/sys/devices/virtual/dmi/id/board_asset_tag')).startsWith('i-')
      || (await read('/sys/hypervisor/uuid')).toLowerCase().startsWith('ec2')
  }
  if (process.platform === 'win32') {
    const tag = await execFileAsync('reg', ['query', 'HKLM\\SYSTEM\\HardwareConfig\\Current', '/v', 'BaseBoardAssetTag'], { timeout: 500 })
      .then((r) => r.stdout, () => '')
    return /i-[0-9a-f]+/i.test(tag)
  }
  return false
}
let ec2Probe: () => Promise<boolean> = detectEc2

/** Tests only: say whether this host is an EC2 instance, or restore the real check. */
export function _setEc2ProbeForTesting(probe?: () => Promise<boolean>): void {
  ec2Probe = probe ?? detectEc2
}

/** The instance's region from IMDSv2, as CDK reads it (1 s per request), or undefined. */
async function instanceRegion(signal?: AbortSignal): Promise<string | undefined> {
  if (!(await ec2Probe())) return undefined
  const within = (): AbortSignal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(1_000)]) : AbortSignal.timeout(1_000))
  try {
    const tokenRes = await fetch(`${IMDS}/latest/api/token`, {
      method: 'PUT',
      headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '60' },
      signal: within(),
    })
    if (!tokenRes.ok) return undefined
    const token = await tokenRes.text()
    const doc = await fetch(`${IMDS}/latest/dynamic/instance-identity/document`, {
      headers: { 'x-aws-ec2-metadata-token': token },
      signal: within(),
    })
    if (!doc.ok) return undefined
    return ((await doc.json()) as { region?: string }).region?.trim() || undefined
  } catch {
    return undefined
  }
}

/** One profile's `region` (the CLI merges its credentials and config entries), or undefined. */
async function profileRegion(profile: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('aws', ['configure', 'get', 'region', '--profile', profile], {
      timeout: TIMEOUT_MS,
      env,
      signal,
    })
    return stdout.trim() || undefined
  } catch {
    // Exit 1 with no output is the CLI's "not set"; a missing profile reads the same.
    return undefined
  }
}

export async function resolveAwsTarget(
  params: ResolveTargetParams,
  onLog: (line: string) => void,
): Promise<CloudSetupTarget> {
  const env = envForProfile(params.profile?.trim() || undefined)
  const chosen = params.region?.trim()
  const { region, source } = chosen ? { region: chosen, source: 'chosen in the wizard' } : await ambientRegion(env, params.signal)
  if (!isAwsRegion(region)) {
    throw new Error(`"${region}" (${source}) is not an AWS region id like us-west-2. Choose a region in the wizard, or fix your AWS config.`)
  }
  const account = await callerAccount(env, params.signal)
  onLog(`AWS target: account ${account}, region ${region} (${source})`)
  return { account, region }
}

/** Refuse a deploy whose credentials now reach a different account than the job recorded. */
export async function verifyAwsAccount(recorded: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  const now = await callerAccount(env, signal)
  if (now === recorded) return
  throw new CloudTargetChangedError(
    `This setup started in AWS account ${recorded}, but your credentials now reach account ${now}. `
    + 'Walnut will not build a second companion in another account. Sign back in to account '
    + `${recorded} (the same profile, SSO login or environment) and retry, or cancel this setup and start a new one.`,
  )
}
