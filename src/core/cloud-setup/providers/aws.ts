/**
 * AWS driver — deploys infra/ (WalnutCloudStack) with the local CDK app.
 *
 * Requires a working `aws` CLI (any credential source: profile, SSO, env) and
 * a source checkout, since the CDK app ships in the repo rather than as a
 * published artifact. Nothing here writes credentials anywhere: `cdk` inherits
 * the operator's own environment.
 */

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { WALNUT_INSTALL_DIR } from '../../../constants.js'
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

const execFileAsync = promisify(execFile)

const STACK_NAME = 'WalnutCloudStack'
const IDENTITY_TIMEOUT_MS = 8_000
/** `npm ci` in infra/ pulls the whole CDK library — slow but bounded. */
const NPM_CI_TIMEOUT_MS = 10 * 60_000
const DEPLOY_TIMEOUT_MS = 30 * 60_000
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000

/**
 * Locate infra/ inside the operator's source checkout. WALNUT_INSTALL_DIR is
 * the same "am I a fixable source checkout?" resolution the Fix Walnut entry
 * uses; null there means an npm install or a cloud bundle, which has no infra/.
 */
function infraDir(): string {
  if (!WALNUT_INSTALL_DIR) {
    throw new Error(
      'AWS provisioning needs a Walnut source checkout (the CDK app lives in infra/). '
      + 'Use the manual provider, or run Walnut from a git clone.',
    )
  }
  const dir = path.join(WALNUT_INSTALL_DIR, 'infra')
  if (!fs.existsSync(path.join(dir, 'cdk.json'))) {
    throw new Error(`infra/ is missing or incomplete at ${dir} — cannot deploy the CDK stack.`)
  }
  return dir
}

async function detectCreds(): Promise<DetectCredsResult> {
  try {
    const { stdout } = await execFileAsync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
      timeout: IDENTITY_TIMEOUT_MS,
    })
    // Only the account id is surfaced — never the ARN (it embeds a user/role name).
    const account = (JSON.parse(stdout) as { Account?: string }).Account
    return {
      available: true,
      detail: account ? `AWS credentials ready (account ${account})` : 'AWS credentials ready',
      needs: 'nothing',
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
    return {
      available: false,
      detail: 'The aws CLI is installed but has no usable credentials. Run `aws configure` or sign in with SSO, then re-check.',
      needs: 'cli-login',
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

/** Run a command in infra/, streaming both streams to onLog line by line. */
async function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  onLog: (line: string) => void,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; output: string }> {
  onLog(`$ ${cmd} ${redactArgs(args)}`)
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    timer.unref?.()

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
      reject(err instanceof Error && (err as { code?: string }).code === 'ENOENT'
        ? new Error(`${cmd} is not installed or not on PATH`)
        : err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
  const cwd = infraDir()

  // The CDK app is a normal npm project inside the checkout — a fresh clone has
  // no node_modules, and `npx cdk` would then resolve to a download prompt.
  if (!fs.existsSync(path.join(cwd, 'node_modules', 'aws-cdk-lib'))) {
    onLog('infra/node_modules is missing — installing CDK dependencies (this takes a few minutes)')
    const install = await runStreaming('npm', ['ci'], cwd, onLog, NPM_CI_TIMEOUT_MS)
    if (install.code !== 0) throw new Error(`npm ci failed in infra/ (exit ${install.code})`)
  }

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
  if (params.region) deployArgs.push('-c', `region=${params.region}`)

  const deployEnv = params.region
    ? { ...process.env, CDK_DEFAULT_REGION: params.region, AWS_REGION: params.region }
    : process.env

  const deploy = async (): Promise<{ code: number; output: string }> => {
    onLog(`deploying ${STACK_NAME}${params.region ? ` in ${params.region}` : ''} — this usually takes 3-6 minutes`)
    return runStreaming('npx', deployArgs, cwd, onLog, DEPLOY_TIMEOUT_MS, deployEnv)
  }

  let result = await deploy()
  if (result.code !== 0 && needsBootstrap(result.output)) {
    onLog('this account/region has never been CDK-bootstrapped — running cdk bootstrap once')
    const bootstrap = await runStreaming('npx', ['cdk', 'bootstrap'], cwd, onLog, BOOTSTRAP_TIMEOUT_MS)
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
      'From a Walnut source checkout: `cd infra && npm ci`.',
      'First time in this account/region only: `npx cdk bootstrap`.',
      `Deploy: \`npx cdk deploy ${STACK_NAME} --require-approval never ${contextFlag}\`.`,
      dnsStep,
      'First boot takes 5-15 minutes; follow it over SSM with `aws ssm start-session --target <InstanceId>` then `tail -f /var/log/walnut-setup.log`.',
    ],
    userData: params.userData,
    consoleUrl: 'https://console.aws.amazon.com/cloudformation/home',
  }
}

async function teardown(instanceRef: string, onLog: (line: string) => void): Promise<void> {
  const cwd = infraDir()
  onLog(`destroying ${STACK_NAME} (instance ${instanceRef})`)
  const res = await runStreaming('npx', ['cdk', 'destroy', STACK_NAME, '--force'], cwd, onLog, DEPLOY_TIMEOUT_MS)
  if (res.code !== 0) throw new Error(`cdk destroy failed (exit ${res.code})`)
}

export const awsDriver: CloudProviderDriver = {
  id: 'aws',
  label: 'AWS (EC2 + CDK)',
  costHint: '~$15-20/mo — t4g.small, 30 GB gp3, Elastic IP',
  detectCreds,
  createVM,
  instructions,
  teardown,
}
