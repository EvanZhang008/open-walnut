/**
 * AWS driver — deploys infra/ (WalnutCloudStack) with the local CDK app.
 *
 * Requires a working `aws` CLI (any credential source: profile, SSO, env). The
 * CDK app is infra/ in a source checkout, and an npm install carries the same
 * directory inside the package. Nothing here writes credentials anywhere: `cdk`
 * inherits the operator's own environment.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WALNUT_HOME, WALNUT_INSTALL_DIR, WALNUT_PACKAGE_ROOT } from '../../../constants.js'
import { log } from '../../../logging/index.js'
import { sslipHostname } from '../user-data.js'
import { envForProfile, isAwsRegion, resolveAwsTarget, verifyAwsAccount } from './aws-target.js'
import { killProcessGroup } from './cli-exec.js'
import type {
  CloudProviderDriver,
  CreateVMParams,
  CreateVMResult,
  DetectCredsResult,
  DriverInstructions,
  InstructionsParams,
} from './types.js'
import { incompleteTargetError } from './types.js'
import type { CloudSetupTarget } from '../job-types.js'

const execFileAsync = promisify(execFile)

const STACK_NAME = 'WalnutCloudStack'
const IDENTITY_TIMEOUT_MS = 8_000
/** `bun install` in infra/ pulls the whole CDK library: slow but bounded. */
const INSTALL_TIMEOUT_MS = 10 * 60_000
const DEPLOY_TIMEOUT_MS = 30 * 60_000
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000
/** After a kill, how long a cancelled or timed-out child may take to exit before we stop waiting. */
const CHILD_EXIT_WAIT_MS = 15_000

/** Build state inside a CDK app dir: never copied from the package, kept across refreshes. */
const INFRA_STATE = new Set(['node_modules', 'cdk.out', 'cdk.context.json'])
/**
 * Hash of the bun.lock the copy's node_modules was installed from. It lives
 * INSIDE node_modules and is removed before every install, so an install that
 * is interrupted can never leave an older, matching stamp behind.
 */
const LOCK_STAMP = path.join('node_modules', '.walnut-installed-lock')

/**
 * The Bun that installs infra/ (infra/bun.lock pins the CDK). PATH first, then
 * where Bun's installer and Homebrew put it, because a server started from a
 * thin PATH (launchd) still has it there.
 */
function bunCommand(): string {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), path.join(os.homedir(), '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'bun.exe' : 'bun')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'bun'
}

/**
 * Where the CDK app comes from. A source checkout deploys its own infra/ in
 * place. An npm install ships infra/ inside the package (package.json files[]),
 * but that directory can be root-owned and is replaced by every upgrade, so it
 * is only the source: the app runs from a copy under WALNUT_HOME/cache, where
 * `bun install` and cdk.out can write (cache/ is never git-synced; node_modules and
 * cdk.context.json, which holds the account id, must not travel).
 */
function infraSource(): { dir: string; copy: boolean } | null {
  const has = (root: string | null): root is string => !!root && fs.existsSync(path.join(root, 'infra', 'cdk.json'))
  if (has(WALNUT_INSTALL_DIR)) return { dir: path.join(WALNUT_INSTALL_DIR, 'infra'), copy: false }
  if (has(WALNUT_PACKAGE_ROOT)) return { dir: path.join(WALNUT_PACKAGE_ROOT, 'infra'), copy: true }
  return null
}

const NO_INFRA = 'This Walnut install has no CDK app (infra/) to deploy the AWS stack with. '
  + 'Update Walnut, run it from a git clone, or use the manual provider.'

const NO_NPM = 'Deploying the AWS stack needs Node.js and npm on this machine: the CDK CLI runs '
  + 'with them (npx cdk). Install Node.js 22 or newer, then re-check, or use the manual provider.'

/**
 * Whether `npm` runs here. Only a missing binary counts: the deploy needs it,
 * nothing more. A yes is kept for the life of the process, so the credentials
 * probe (which has a few seconds in all) pays for this spawn once, not on every
 * check; a no is asked again, so installing Node.js shows up on the next check.
 */
let npmFound = false
async function hasNpm(): Promise<boolean> {
  if (npmFound) return true
  try {
    await execFileAsync('npm', ['--version'], { timeout: IDENTITY_TIMEOUT_MS })
    npmFound = true
  } catch (err) {
    npmFound = (err as { code?: string }).code !== 'ENOENT'
  }
  return npmFound
}

/** Tests only: forget a cached npm answer. */
export function resetNpmProbeForTests(): void {
  npmFound = false
}

/** The directory the npm package's CDK app is copied to and run from. */
function infraWorkDir(): string {
  return path.join(WALNUT_HOME, 'cache', 'cloud-infra')
}

/** Replace the copy's source files with the package's, keeping its build state. */
async function refreshInfraCopy(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true })
  for (const name of await fsp.readdir(dest)) {
    if (INFRA_STATE.has(name)) continue
    await fsp.rm(path.join(dest, name), { recursive: true, force: true })
  }
  for (const name of await fsp.readdir(src)) {
    if (INFRA_STATE.has(name)) continue
    await fsp.cp(path.join(src, name), path.join(dest, name), { recursive: true })
  }
}

async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex')
}

/**
 * One preparation at a time: a job that is cancelled and started again must not
 * refresh the copy or run `bun install` while the previous one still works in the
 * same directory.
 */
let infraQueue: Promise<unknown> = Promise.resolve()
function prepareInfra(onLog: (line: string) => void, signal?: AbortSignal): Promise<string> {
  const run = infraQueue.then(() => prepareInfraNow(onLog, signal))
  infraQueue = run.catch(() => {})
  return run
}

/**
 * The directory to run `cdk` in, with its dependencies installed. A checkout
 * installs once (a fresh clone has no node_modules, and `npx cdk` would then
 * resolve to a download prompt); the package copy reinstalls whenever the
 * shipped bun.lock changed, so an upgrade brings its CDK version along.
 */
async function prepareInfraNow(onLog: (line: string) => void, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled')
  const source = infraSource()
  if (!source) throw new Error(NO_INFRA)
  const cwd = source.copy ? infraWorkDir() : source.dir
  if (source.copy) await refreshInfraCopy(source.dir, cwd)

  const lock = path.join(cwd, 'bun.lock')
  const lockHash = source.copy && fs.existsSync(lock) ? await fileHash(lock) : null
  const stamp = path.join(cwd, LOCK_STAMP)
  const installed = fs.existsSync(path.join(cwd, 'node_modules', 'aws-cdk-lib'))
    && (!lockHash || (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf-8').trim() === lockHash))
  if (!installed) {
    onLog(`installing CDK dependencies in ${cwd} (this takes a few minutes)`)
    // The cdk CLI, ts-node and typescript are devDependencies; bun install takes
    // them whatever NODE_ENV says (measured on bun 1.4.4: npm ci needed --include=dev).
    // No AWS call here (the install only fetches packages), so the ambient env is right.
    await fsp.rm(stamp, { force: true })
    const install = await runStreaming(bunCommand(), ['install', '--frozen-lockfile'], cwd, onLog, INSTALL_TIMEOUT_MS, process.env, signal)
    if (install.code !== 0) throw new Error(`bun install failed in ${cwd} (exit ${install.code})`)
    // Written only after a clean exit, into the directory that run created.
    if (lockHash) await fsp.writeFile(stamp, `${lockHash}\n`, 'utf-8')
  }
  return cwd
}

/**
 * The profile names in the operator's ~/.aws, or null if the CLI could not say.
 *
 * These names go to the WIZARD ONLY (GET /providers → the picker's dropdown), so
 * the operator can choose which account to deploy into. They must never reach a
 * log line or a persisted job: a profile name is the operator's own label for an
 * account and can carry a client, employer or project name. That is the same
 * restraint that keeps the caller ARN out of `detail` — `detail` is written to the
 * log, `profiles` is not, which is why they are separate fields rather than one
 * prose sentence.
 */
async function listProfiles(): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('aws', ['configure', 'list-profiles'], {
      timeout: IDENTITY_TIMEOUT_MS,
    })
    const names = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    return names.length > 0 ? names : null
  } catch {
    // Too old to have the subcommand, or no config at all. Advisory only.
    return null
  }
}

async function detectCreds(profile?: string): Promise<DetectCredsResult> {
  // Said before the operator agrees to anything: without a CDK app the deploy
  // could only fail after the wizard had already been filled in.
  if (!infraSource()) return { available: false, detail: NO_INFRA }
  if (!(await hasNpm())) return { available: false, detail: NO_NPM }
  const chosen = profile?.trim() || undefined
  try {
    const { stdout } = await execFileAsync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      timeout: IDENTITY_TIMEOUT_MS,
      env: envForProfile(chosen),
    })
    // Only the account id is surfaced — never the ARN (it embeds a user/role name).
    const account = (JSON.parse(stdout) as { Account?: string }).Account
    // The chosen profile is echoed back so the wizard can show WHICH account it
    // verified — the operator picked that name, so it is not news to them.
    const via = chosen ? ` via profile ${chosen}` : ''
    return {
      available: true,
      detail: account ? `AWS credentials ready (account ${account})${via}` : `AWS credentials ready${via}`,
      needs: 'nothing',
      profiles: (await listProfiles()) ?? undefined,
      activeProfile: chosen,
    }
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'ENOENT') {
      return {
        available: false,
        detail: 'The aws CLI is not installed. Install it, then run `aws configure` (or sign in with SSO).',
        needs: 'cli-login',
      }
    }
    // Without an explicit profile every `aws` call inherits Walnut's own
    // environment, so it resolves the DEFAULT profile. A machine with several
    // profiles and a stale [default] therefore fails this probe while the profile
    // the operator actually uses works perfectly — telling them to run `aws
    // configure` would be the wrong fix and would overwrite a working config.
    const profiles = await listProfiles()
    const effective = chosen ?? process.env.AWS_PROFILE
    if (effective) {
      return {
        available: false,
        detail: `Profile ${effective} did not authenticate — check that it is still signed in `
          + '(for SSO: `aws sso login`), or pick a different one.',
        needs: 'cli-login',
        profiles: profiles ?? undefined,
        activeProfile: chosen,
      }
    }
    if (profiles && profiles.length > 1) {
      return {
        available: false,
        detail: `The default AWS profile has no usable credentials, but this machine has ${profiles.length} profiles — `
          + 'pick the one you want to deploy with below.',
        needs: 'cli-login',
        profiles,
      }
    }
    return {
      available: false,
      detail: 'The aws CLI is installed but has no usable credentials. Run `aws configure` or sign in with SSO, then re-check.',
      needs: 'cli-login',
      profiles: profiles ?? undefined,
    }
  }
}

/**
 * Command line safe to echo to the operator log. `userDataB64` is the base64 of
 * the boot script, which embeds the PAIRING CODE — logging it verbatim would
 * leak the secret into logTail, and from there into the SSE stream and every
 * REST response carrying the job. Redact its value, keep the flag visible.
 */
function redactArgs(args: string[]): string {
  return args.map((arg) => arg.replace(/^userDataB64=.*/, 'userDataB64=<redacted>')).join(' ')
}

/**
 * Run a command in infra/, streaming both streams to onLog line by line.
 *
 * `detached` + killProcessGroup because `npx cdk deploy` is a process TREE (npx →
 * node → the CDK CLI's own children). Killing only the top-level process orphans
 * a 30-minute CloudFormation deploy to pid 1, where it keeps creating billable
 * resources with nobody reading its output.
 */
async function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  onLog(`$ ${cmd} ${redactArgs(args)}`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    let output = ''
    let settled = false
    // A killed child is waited for (bounded) before the promise settles, so the
    // caller never starts the next step, or the next job, beside a process that
    // is still writing in the same directory.
    const failAfterExit = (err: Error): void => {
      killProcessGroup(child)
      if (child.exitCode !== null || child.signalCode !== null) return reject(err)
      const wait = setTimeout(() => reject(err), CHILD_EXIT_WAIT_MS)
      wait.unref?.()
      child.once('close', () => { clearTimeout(wait); reject(err) })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      failAfterExit(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    timer.unref?.()

    function onAbort(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      failAfterExit(new Error(`${cmd} cancelled`))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const wire = (stream: NodeJS.ReadableStream): void => {
      let buf = ''
      stream.setEncoding('utf-8')
      const emit = (line: string): void => {
        // Belt to redactArgs' braces: cdk echoes its own context back on some
        // paths, so scrub the secret-bearing key on the way out too.
        onLog(line.trimEnd().replace(/userDataB64=\S+/g, 'userDataB64=<redacted>'))
      }
      stream.on('data', (chunk: string) => {
        output += chunk
        buf += chunk
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) emit(line)
      })
      stream.on('end', () => { if (buf.trim()) emit(buf) })
    }
    wire(child.stdout)
    wire(child.stderr)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(err instanceof Error && (err as { code?: string }).code === 'ENOENT'
        ? new Error(`${cmd} is not installed or not on PATH`)
        : err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, output })
    })
  })
}

/** CDK's message when the target account/region has no bootstrap stack. */
function needsBootstrap(output: string): boolean {
  return /has not been bootstrapped/i.test(output) || /SSM parameter \/cdk-bootstrap\//i.test(output)
}

interface StackOutputs { InstanceId?: string; ElasticIp?: string; Domain?: string }

async function readOutputs(file: string): Promise<StackOutputs> {
  const raw = await fsp.readFile(file, 'utf-8')
  const parsed = JSON.parse(raw) as Record<string, StackOutputs>
  const outputs = parsed[STACK_NAME]
  if (!outputs) throw new Error(`cdk deploy produced no outputs for ${STACK_NAME}`)
  return outputs
}

async function createVM(params: CreateVMParams, onLog: (line: string) => void): Promise<CreateVMResult> {
  const sslip = params.domainMode === 'sslip'
  if (!sslip && !params.domain) {
    throw new Error('AWS provisioning in own-domain mode requires a domain')
  }
  // A recorded target decides the account and region; nothing ambient does.
  const target = params.target
  if (target && !/^\d{12}$/.test(target.account ?? '')) throw incompleteTargetError('AWS account')
  if (target && !isAwsRegion(target.region)) throw incompleteTargetError('AWS region')
  const region = target?.region ?? params.region

  // The profile has to reach the CHILD, not just the probe: cdk resolves the
  // target account from its own environment, so a deploy without it would land in
  // whatever [default] points at, a different account than the wizard verified
  // and displayed.
  const profileEnv = envForProfile(params.profile)
  const deployEnv = region
    ? { ...profileEnv, CDK_DEFAULT_REGION: region, AWS_REGION: region }
    : profileEnv
  const cwd = await prepareInfra(onLog, params.signal)
  // Checked after the install (which can take minutes), right before the deploy,
  // with the deploy's own environment.
  if (target) await verifyAwsAccount(target.account as string, deployEnv, params.signal)

  const outputsFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cdk-')), 'outputs.json')
  const deployArgs = [
    'cdk', 'deploy', STACK_NAME,
    '--require-approval', 'never',
    // sslip mode has no hostname to pass: the boot script derives it from the
    // instance's own public IP, and `-c sslip=1` is what makes the stack accept
    // a missing domain. Passing both would be contradictory, so it's either/or.
    ...(sslip ? ['-c', 'sslip=1'] : ['-c', `domain=${params.domain}`]),
    '-c', `userDataB64=${Buffer.from(params.userData, 'utf-8').toString('base64')}`,
    '--outputs-file', outputsFile,
  ]
  if (params.instanceType) deployArgs.push('-c', `instanceType=${params.instanceType}`)
  if (region) deployArgs.push('-c', `region=${region}`)
  // The CDK app pins the stack to this account, so even credentials that change
  // after the check below cannot deploy it anywhere else.
  if (target) deployArgs.push('-c', `account=${target.account}`)

  const deploy = async (): Promise<{ code: number; output: string }> => {
    onLog(`deploying ${STACK_NAME}${region ? ` in ${region}` : ''}, this usually takes 3-6 minutes`)
    return runStreaming('npx', deployArgs, cwd, onLog, DEPLOY_TIMEOUT_MS, deployEnv, params.signal)
  }

  let result = await deploy()
  if (result.code !== 0 && needsBootstrap(result.output)) {
    onLog('this account/region has never been CDK-bootstrapped — running cdk bootstrap once')
    // Same env as the deploy: bootstrapping a DIFFERENT account than the one the
    // deploy targets would leave the real failure unfixed.
    // With a recorded target the environment is named outright and the account
    // checked again, so a bootstrap stack never lands in another account either.
    if (target) await verifyAwsAccount(target.account as string, deployEnv, params.signal)
    const bootstrapArgs = target ? ['cdk', 'bootstrap', `aws://${target.account}/${region}`] : ['cdk', 'bootstrap']
    const bootstrap = await runStreaming(
      'npx', bootstrapArgs, cwd, onLog, BOOTSTRAP_TIMEOUT_MS, deployEnv, params.signal,
    )
    if (bootstrap.code !== 0) throw new Error(`cdk bootstrap failed (exit ${bootstrap.code})`)
    result = await deploy()
  }
  if (result.code !== 0) {
    throw new Error(`cdk deploy failed (exit ${result.code}) — see the log above for the CloudFormation error`)
  }

  const outputs = await readOutputs(outputsFile)
  await fsp.rm(path.dirname(outputsFile), { recursive: true, force: true }).catch(() => {})
  if (!outputs.ElasticIp) throw new Error('cdk deploy succeeded but produced no ElasticIp output')
  log.web.info('cloud-setup: aws stack deployed', { instanceId: outputs.InstanceId })
  // In sslip mode the stack's Domain output is the literal 'sslip-auto'
  // (CloudFormation can't build `<dashed-ip>.sslip.io` from an IP token), so the
  // hostname is derived here from the Elastic IP with the same helper the boot
  // script and the job's await-vm step use — one definition, no drift.
  return {
    ip: outputs.ElasticIp,
    instanceRef: outputs.InstanceId ?? STACK_NAME,
    domain: sslip ? sslipHostname(outputs.ElasticIp) : (outputs.Domain ?? params.domain as string),
  }
}

/** The manual "get the CDK app ready" step, naming the directory this install has. */
function infraStep(): string {
  const source = infraSource()
  if (!source) return 'Get the CDK app: clone the Walnut repository, then `cd infra && bun install --frozen-lockfile`.'
  const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`
  if (!source.copy) return `In the CDK app: \`cd ${q(source.dir)} && bun install --frozen-lockfile\`.`
  const dest = infraWorkDir()
  return `Copy the CDK app somewhere writable: \`mkdir -p ${q(dest)} && cp -R ${q(source.dir)}/. ${q(dest)} && cd ${q(dest)} && bun install --frozen-lockfile\`.`
}

function instructions(params: InstructionsParams): DriverInstructions {
  const region = params.region ? ` (region ${params.region})` : ''
  // Mirror createVM's either/or: sslip mode passes no domain at all, and needs
  // no DNS step because the hostname is derived from the instance's own IP.
  const sslip = params.domainMode === 'sslip'
  const contextFlag = sslip ? '-c sslip=1' : `-c domain=${params.domain}`
  const dnsStep = sslip
    ? 'No DNS record to create — the box serves itself at `<dashed-ip>.sslip.io`, derived from the stack\'s ElasticIp output.'
    : 'Point an A record for the domain at the stack\'s ElasticIp output (DNS-only, no CDN proxy — Caddy terminates TLS itself).'
  return {
    steps: [
      `Make sure the aws CLI is signed in${region}: \`aws sts get-caller-identity\` must succeed.`,
      infraStep(),
      'First time in this account/region only: `npx cdk bootstrap`.',
      `Deploy: \`npx cdk deploy ${STACK_NAME} --require-approval never ${contextFlag}\`.`,
      dnsStep,
      'First boot takes 5-15 minutes; follow it over SSM with `aws ssm start-session --target <InstanceId>` then `tail -f /var/log/walnut-setup.log`.',
    ],
    userData: params.userData,
    consoleUrl: 'https://console.aws.amazon.com/cloudformation/home',
  }
}

/**
 * Destroy the stack. `profile` MUST be the one the job deployed with, and a job
 * that recorded a target passes it: then the destroy runs in exactly that account
 * and region (checked and pinned like a deploy), whatever the defaults say now.
 *
 * The stack name is a constant, so the ONLY thing deciding which account and
 * region this deletes from is the environment handed to the child. Resolving that
 * from the ambient environment would make "destroy the test box" delete whatever
 * [default] happens to point at — an unrecoverable outcome (instance, Elastic IP
 * and disk all go), so the caller has to state the account explicitly.
 */
async function teardown(
  instanceRef: string,
  onLog: (line: string) => void,
  opts?: { profile?: string; region?: string; target?: CloudSetupTarget },
): Promise<void> {
  const target = opts?.target
  if (target && !/^\d{12}$/.test(target.account ?? '')) throw incompleteTargetError('AWS account')
  if (target && !isAwsRegion(target.region)) throw incompleteTargetError('AWS region')
  const region = target?.region ?? opts?.region
  const cwd = await prepareInfra(onLog)
  onLog(`destroying ${STACK_NAME} (instance ${instanceRef})`)
  const env = region
    ? { ...envForProfile(opts?.profile), CDK_DEFAULT_REGION: region, AWS_REGION: region }
    : envForProfile(opts?.profile)
  if (target) await verifyAwsAccount(target.account as string, env)
  const pin = target ? ['-c', `account=${target.account}`, '-c', `region=${region}`] : []
  const res = await runStreaming(
    'npx', ['cdk', 'destroy', STACK_NAME, '--force', ...pin], cwd, onLog, DEPLOY_TIMEOUT_MS, env,
  )
  if (res.code !== 0) throw new Error(`cdk destroy failed (exit ${res.code})`)
}

export const awsDriver: CloudProviderDriver = {
  id: 'aws',
  label: 'AWS (EC2 + CDK)',
  costHint: '~$15-20/mo — t4g.small, 30 GB gp3, Elastic IP',
  detectCreds,
  resolveTarget: resolveAwsTarget,
  createVM,
  instructions,
  teardown,
}
