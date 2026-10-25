/**
 * AWS driver — the cdk command line it builds, and the hostname it reports back.
 *
 * `cdk` is never actually run: child_process.spawn is stubbed, so these tests
 * assert the argv and the outputs-file handling with no AWS calls and no CDK
 * install. The argv is worth pinning because the sslip and own-domain paths pass
 * mutually exclusive context flags, and because one of those args carries the
 * pairing code and must stay redacted in the operator-visible log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const spawnCalls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> = []
/** Written to the --outputs-file of the next deploy, as cdk would. */
let stackOutputs: Record<string, string> = {}
/** What the next `cdk deploy` prints and exits with. Reset per test. */
let deployOutput: () => { text: string; code: number } = () => ({ text: 'fake cdk: done', code: 0 })

/** How the next `npm ci` behaves: its exit code and how long it runs. Reset per test. */
let npmCi: { code: number; delayMs: number } = { code: 0, delayMs: 0 }
/** `npm ci` processes running right now, and the most that ever ran at once. */
let npmActive = 0
let npmMaxActive = 0
/** When each `npm ci` exited (its close event), for ordering assertions. */
const npmClosedAt: number[] = []

/** Every `aws` invocation detectCreds made, with the env it would have run under. */
const execFileCalls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
type ExecReply = { stdout?: string; error?: Error & { code?: string | number } }
/** Keyed by the argv joined with spaces; unmatched calls fail like a broken CLI. */
let execFileReplies: Record<string, ExecReply> = {}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')

  /**
   * detectCreds goes through promisify(execFile), so the stub carries the custom
   * promisify symbol — without it promisify resolves with stdout alone and the
   * driver's `{ stdout }` destructure reads undefined.
   */
  const execFile = (cmd: string, args: string[]) => {
    execFileCalls.push({ cmd, args })
    throw new Error('callback-style execFile is not used by this driver')
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: async (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      // The env is the whole mechanism for profile selection, so record it.
      execFileCalls.push({ cmd, args, env: opts?.env })
      const reply = execFileReplies[args.join(' ')]
      if (!reply) {
        const err = new Error(`test: no execFile stub for ${cmd} ${args.join(' ')}`) as Error & { code: number }
        err.code = 254
        throw err
      }
      if (reply.error) throw reply.error
      return { stdout: reply.stdout ?? '', stderr: '' }
    },
  })

  return {
    ...actual,
    execFile,
    spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      // cdk resolves the target ACCOUNT from its own env, so record it.
      spawnCalls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd })
      // `npm ci` starts by removing node_modules and leaves the marker the driver
      // checks for, as the real one does (an interrupted one leaves the marker too).
      const isNpmCi = cmd === 'npm' && args[0] === 'ci' && !!opts?.cwd
      if (isNpmCi) {
        fs.rmSync(path.join(opts!.cwd!, 'node_modules'), { recursive: true, force: true })
        fs.mkdirSync(path.join(opts!.cwd!, 'node_modules', 'aws-cdk-lib'), { recursive: true })
        npmActive++
        npmMaxActive = Math.max(npmMaxActive, npmActive)
      }
      // Real PassThroughs, not bare EventEmitters: the driver calls
      // stream.setEncoding() on both pipes, so a fake without it would fail for
      // a reason that has nothing to do with what these tests assert.
      // No pid: killProcessGroup returns before signalling anything. exitCode and
      // signalCode stay null until close, as on a real running ChildProcess.
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill: () => void
        exitCode: number | null; signalCode: NodeJS.Signals | null
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {}
      child.exitCode = null
      child.signalCode = null
      const outFileIdx = args.indexOf('--outputs-file')
      // Only the deploy consults deployOutput, so a test can make the FIRST deploy
      // report "not bootstrapped" and still let the retry succeed.
      const reply = args.includes('deploy') ? deployOutput()
        : isNpmCi ? { text: 'fake npm: done', code: npmCi.code } : { text: 'fake cdk: done', code: 0 }
      setTimeout(async () => {
        if (outFileIdx !== -1 && reply.code === 0) {
          await fsp.writeFile(
            args[outFileIdx + 1],
            JSON.stringify({ WalnutCloudStack: stackOutputs }),
            'utf-8',
          )
        }
        child.stdout.end(`${reply.text}\n`)
        child.stderr.end()
        if (isNpmCi) { npmActive--; npmClosedAt.push(Date.now()) }
        child.exitCode = reply.code
        child.emit('close', reply.code)
      }, isNpmCi ? npmCi.delayMs : 0)
      return child
    },
  }
})

// The driver needs a CDK app: a source checkout's infra/ (WALNUT_INSTALL_DIR) or
// the one an npm package carries (WALNUT_PACKAGE_ROOT), run from a copy under
// WALNUT_HOME. Each test points these at temp dirs.
let installDir: string | null = null
let packageRoot: string | null = null
let walnutHome = os.tmpdir()
vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return {
    ...actual,
    get WALNUT_INSTALL_DIR() { return installDir },
    get WALNUT_PACKAGE_ROOT() { return packageRoot },
    get WALNUT_HOME() { return walnutHome },
  }
})

/** A temp dir holding infra/ with a cdk.json, like a checkout or an npm package root. */
async function fakeRoot(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  await fsp.mkdir(path.join(root, 'infra'), { recursive: true })
  await fsp.writeFile(path.join(root, 'infra', 'cdk.json'), '{}', 'utf-8')
  return root
}

const { awsDriver, resetNpmProbeForTests } = await import('../../../src/core/cloud-setup/providers/aws.js')

const USER_DATA = "#!/usr/bin/env bash\nprintf '%s' 'a1b2c3d4e5f60718293a4b5c6d7e8f90' > /etc/walnut/setup-token\n"

/** Every `-c key=value` the driver passed to cdk, as a map. */
function contextFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue
    const [k, ...rest] = args[i + 1].split('=')
    out[k] = rest.join('=')
  }
  return out
}

describe('awsDriver.detectCreds', () => {
  const IDENTITY = 'sts get-caller-identity --output json'
  const PROFILES = 'configure list-profiles'
  /** The real CLI's exit for expired keys. */
  function invalidToken(): Error & { code: number } {
    const err = new Error(
      'An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: '
      + 'The security token included in the request is invalid',
    ) as Error & { code: number }
    err.code = 254
    return err
  }

  let savedProfile: string | undefined
  beforeEach(async () => {
    installDir = await fakeRoot('walnut-aws-detect-')
    resetNpmProbeForTests()
    execFileCalls.length = 0
    execFileReplies = {}
    savedProfile = process.env.AWS_PROFILE
    delete process.env.AWS_PROFILE
  })
  afterEach(async () => {
    if (savedProfile === undefined) delete process.env.AWS_PROFILE
    else process.env.AWS_PROFILE = savedProfile
    await fsp.rm(installDir!, { recursive: true, force: true }).catch(() => {})
    installDir = null
  })

  it('reports the account id and nothing else when the CLI authenticates', async () => {
    // The ARN embeds a user/role name and this string is rendered in the wizard
    // and written to the log, so only the account number may appear.
    execFileReplies[IDENTITY] = {
      stdout: JSON.stringify({
        Account: '123456789012',
        Arn: 'arn:aws:sts::123456789012:assumed-role/Admin/operator',
        UserId: 'AROAEXAMPLE:operator',
      }),
    }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: true, needs: 'nothing' })
    expect(detect.detail).toContain('123456789012')
    expect(detect.detail).not.toContain('Admin')
    expect(detect.detail).not.toContain('operator')
  })

  it('offers to install the CLI when the binary is absent', async () => {
    const enoent = new Error('spawn aws ENOENT') as Error & { code: string }
    enoent.code = 'ENOENT'
    execFileReplies[IDENTITY] = { error: enoent }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/not installed/)
    // No point asking about profiles when there is no CLI to ask.
    expect(execFileCalls.map((c) => c.args.join(' '))).not.toContain(PROFILES)
  })

  it('probes a REQUESTED profile by putting it in the child environment', async () => {
    // The CLI resolves credentials from its own env, so this is the only thing
    // that makes the probe describe the chosen account rather than [default].
    execFileReplies[IDENTITY] = { stdout: JSON.stringify({ Account: '123456789012' }) }
    execFileReplies[PROFILES] = { stdout: 'default\nmarina-dev\n' }
    const detect = await awsDriver.detectCreds('marina-dev')
    const identityCall = execFileCalls.find((c) => c.args.join(' ') === IDENTITY)!
    expect(identityCall.env?.AWS_PROFILE).toBe('marina-dev')
    // AWS_DEFAULT_PROFILE too: the CLI honours it as well, so a stale one left in
    // place could send the deploy to a different account than we just verified.
    expect(identityCall.env?.AWS_DEFAULT_PROFILE).toBe('marina-dev')
    expect(detect).toMatchObject({ available: true, activeProfile: 'marina-dev' })
    expect(detect.detail).toContain('marina-dev')
  })

  it('lists the profile names so the wizard can offer a choice', async () => {
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nmarina-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.profiles).toEqual(['default', 'marina-dev', 'acme-prod'])
    // And it points at the picker rather than telling them to run `aws configure`,
    // which would overwrite a config where another profile works fine.
    expect(detect.detail).toMatch(/pick the one you want/i)
  })

  it('blames the CHOSEN profile when that one fails, not the default', async () => {
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nmarina-dev\n' }
    const detect = await awsDriver.detectCreds('marina-dev')
    expect(detect.available).toBe(false)
    expect(detect.detail).toContain('marina-dev')
    expect(detect.detail).toMatch(/sso login/i)
    // Still offers the list, so the operator can switch without leaving the screen.
    expect(detect.profiles).toEqual(['default', 'marina-dev'])
  })

  it('treats a blank profile as "no choice made" rather than an empty env var', async () => {
    execFileReplies[IDENTITY] = { stdout: JSON.stringify({ Account: '123456789012' }) }
    execFileReplies[PROFILES] = { stdout: 'default\n' }
    await awsDriver.detectCreds('   ')
    const identityCall = execFileCalls.find((c) => c.args.join(' ') === IDENTITY)!
    // AWS_PROFILE='' is NOT the same as unset — the CLI would look for a profile
    // with an empty name and fail instead of falling back to the default.
    expect(identityCall.env?.AWS_PROFILE).toBeUndefined()
  })

  it('points at the picker when the DEFAULT is stale but other profiles exist', async () => {
    // The reported failure: a machine with many profiles and an expired [default].
    // Without a chosen profile the probe resolves [default] and fails while the
    // profile the operator actually uses works fine.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nmarina-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toContain('4 profiles')
    expect(detect.detail).toMatch(/pick the one you want/i)
    expect(detect.profiles).toHaveLength(4)
  })

  it('keeps profile names OUT of detail, which is the field that gets logged', async () => {
    // The names ride the separate `profiles` field for the UI. detail is written to
    // the log, and a profile name is the operator's own label for an account — it
    // can carry a client, employer or project name.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).not.toContain('walnut-dev')
    expect(detect.detail).not.toContain('acme-prod')
    // But the UI still gets them, or there would be nothing to pick from.
    expect(detect.profiles).toContain('walnut-dev')
  })

  it('blames the ambient AWS_PROFILE when one is set and no choice was made', async () => {
    // Telling an operator to set a variable they have already set reads as a bug.
    process.env.AWS_PROFILE = 'walnut-dev'
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).toMatch(/did not authenticate/)
    expect(detect.detail).not.toMatch(/pick the one you want/i)
  })

  it('keeps the plain advice when there is only one profile to blame', async () => {
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).toMatch(/aws configure/)
    expect(detect.detail).not.toMatch(/pick the one you want/i)
  })

  it('still answers when the profile list cannot be determined', async () => {
    // `aws configure list-profiles` is advisory only: a CLI too old to have the
    // subcommand must not turn a clean "not signed in" into a crash.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/no usable credentials/)
    expect(detect.profiles).toBeUndefined()
  })
})

describe('awsDriver.createVM', () => {
  const logs: string[] = []

  beforeEach(async () => {
    spawnCalls.length = 0
    logs.length = 0
    deployOutput = () => ({ text: 'fake cdk: done', code: 0 })
    stackOutputs = { InstanceId: 'i-0abc', ElasticIp: '203.0.113.77', Domain: 'wn.example.com' }
    // Minimal fake checkout: infra/cdk.json + a node_modules marker so the
    // driver skips its `npm ci` step.
    installDir = await fakeRoot('walnut-aws-driver-')
    await fsp.mkdir(path.join(installDir, 'infra', 'node_modules', 'aws-cdk-lib'), { recursive: true })
  })

  afterEach(async () => {
    await fsp.rm(installDir!, { recursive: true, force: true }).catch(() => {})
    installDir = null
  })

  it('own-domain mode passes -c domain and no sslip flag', async () => {
    const result = await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain', domain: 'wn.example.com' },
      (l) => logs.push(l),
    )
    const ctx = contextFlags(spawnCalls[0].args)
    expect(ctx.domain).toBe('wn.example.com')
    expect(ctx.sslip).toBeUndefined()
    expect(result).toMatchObject({ ip: '203.0.113.77', instanceRef: 'i-0abc', domain: 'wn.example.com' })
  })

  it('sslip mode passes -c sslip=1 and NO -c domain', async () => {
    // Both flags together would be contradictory: the stack makes domain
    // optional only under sslip, and the boot script derives the real name.
    stackOutputs = { InstanceId: 'i-0abc', ElasticIp: '203.0.113.77', Domain: 'sslip-auto' }
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const ctx = contextFlags(spawnCalls[0].args)
    expect(ctx.sslip).toBe('1')
    expect(ctx.domain).toBeUndefined()
  })

  it("sslip mode derives the hostname from the EIP, ignoring the stack's 'sslip-auto' placeholder", async () => {
    stackOutputs = { InstanceId: 'i-0abc', ElasticIp: '203.0.113.77', Domain: 'sslip-auto' }
    const result = await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.domain).toBe('203-0-113-77.sslip.io')
    expect(result.domain).not.toBe('sslip-auto')
  })

  it('always passes the boot script as base64 userDataB64', async () => {
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const ctx = contextFlags(spawnCalls[0].args)
    expect(Buffer.from(ctx.userDataB64, 'base64').toString('utf-8')).toBe(USER_DATA)
  })

  it('never lets the pairing code reach the operator-visible log', async () => {
    // userDataB64 embeds the pairing code; logTail is streamed over SSE and
    // returned by REST, so an unredacted echo of the argv leaks the secret.
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const joined = logs.join('\n')
    expect(joined).toContain('userDataB64=<redacted>')
    expect(joined).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90')
    const b64 = Buffer.from(USER_DATA, 'utf-8').toString('base64')
    expect(joined).not.toContain(b64)
  })

  it('deploys with the chosen profile in the cdk environment', async () => {
    // This is the money assertion: the stack name is a constant, so the env is the
    // ONLY thing deciding which account gets the resources. A deploy that dropped
    // the profile would create a box in whatever [default] points at.
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', profile: 'marina-dev' },
      (l) => logs.push(l),
    )
    const deploy = spawnCalls.find((c) => c.args.includes('deploy'))!
    expect(deploy.env?.AWS_PROFILE).toBe('marina-dev')
    expect(deploy.env?.AWS_DEFAULT_PROFILE).toBe('marina-dev')
  })

  it('region and profile travel together to the deploy', async () => {
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', profile: 'marina-dev', region: 'eu-west-1' },
      (l) => logs.push(l),
    )
    const deploy = spawnCalls.find((c) => c.args.includes('deploy'))!
    expect(deploy.env?.AWS_PROFILE).toBe('marina-dev')
    expect(deploy.env?.AWS_REGION).toBe('eu-west-1')
    expect(deploy.env?.CDK_DEFAULT_REGION).toBe('eu-west-1')
  })

  it('bootstraps the SAME account and region the deploy targets', async () => {
    // A bootstrap that ran against a different account than the deploy would leave
    // the real failure unfixed and the operator staring at the same error twice.
    let deploys = 0
    const notBootstrapped = 'Error: WalnutCloudStack: SSM parameter /cdk-bootstrap/hnb659fds/version not found'
    stackOutputs = { InstanceId: 'i-0abc', ElasticIp: '203.0.113.77' }
    deployOutput = () => (++deploys === 1 ? { text: notBootstrapped, code: 1 } : { text: 'ok', code: 0 })
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', profile: 'marina-dev', region: 'eu-west-1' },
      (l) => logs.push(l),
    )
    const bootstrap = spawnCalls.find((c) => c.args.includes('bootstrap'))!
    expect(bootstrap.env?.AWS_PROFILE).toBe('marina-dev')
    expect(bootstrap.env?.AWS_REGION).toBe('eu-west-1')
  })

  it('leaves the environment alone when no profile was chosen', async () => {
    await awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const deploy = spawnCalls.find((c) => c.args.includes('deploy'))!
    // Not the empty string: AWS_PROFILE='' makes the CLI look for a profile with an
    // empty name rather than falling back to the default.
    expect(deploy.env?.AWS_PROFILE).toBeUndefined()
  })

  it('own-domain mode without a domain throws before spawning anything', async () => {
    await expect(awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain' },
      (l) => logs.push(l),
    )).rejects.toThrow(/requires a domain/)
    expect(spawnCalls).toHaveLength(0)
  })

  it('throws when the deploy produced no ElasticIp', async () => {
    stackOutputs = { InstanceId: 'i-0abc' }
    await expect(awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/no ElasticIp/)
  })
})

describe('awsDriver.instructions', () => {
  it('sslip mode documents -c sslip=1 and no DNS record', () => {
    const { steps } = awsDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    })
    const joined = steps.join('\n')
    expect(joined).toContain('-c sslip=1')
    expect(joined).not.toContain('-c domain=')
    expect(joined).toMatch(/No DNS record/i)
    // A missing domain must never surface as the string "undefined".
    expect(joined).not.toContain('undefined')
  })

  it('own-domain mode documents -c domain and the A record', () => {
    const { steps } = awsDriver.instructions({
      userData: USER_DATA, domain: 'wn.example.com', domainMode: 'own-domain',
    })
    const joined = steps.join('\n')
    expect(joined).toContain('-c domain=wn.example.com')
    expect(joined).toContain('A record')
  })
})

/**
 * An npm install has no source checkout: the CDK app comes from the package
 * (package.json files[]) and runs from a copy under WALNUT_HOME/cache, because the
 * package dir can be root-owned and is replaced by every upgrade.
 */
describe('awsDriver with the CDK app an npm package carries', () => {
  const logs: string[] = []
  let workDir: string

  beforeEach(async () => {
    spawnCalls.length = 0
    execFileCalls.length = 0
    execFileReplies = {}
    logs.length = 0
    deployOutput = () => ({ text: 'fake cdk: done', code: 0 })
    stackOutputs = { InstanceId: 'i-0abc', ElasticIp: '203.0.113.77' }
    npmCi = { code: 0, delayMs: 0 }
    npmActive = 0
    npmMaxActive = 0
    npmClosedAt.length = 0
    installDir = null
    packageRoot = await fakeRoot('walnut-aws-pkg-')
    await fsp.mkdir(path.join(packageRoot, 'infra', 'lib'), { recursive: true })
    await fsp.writeFile(path.join(packageRoot, 'infra', 'lib', 'stack.ts'), 'export {}\n', 'utf-8')
    await fsp.writeFile(path.join(packageRoot, 'infra', 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf-8')
    walnutHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-aws-home-'))
    workDir = path.join(walnutHome, 'cache', 'cloud-infra')
  })

  afterEach(async () => {
    await fsp.rm(packageRoot!, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(walnutHome, { recursive: true, force: true }).catch(() => {})
    packageRoot = null
    walnutHome = os.tmpdir()
  })

  const deploy = () => awsDriver.createVM!(
    { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
    (l) => logs.push(l),
  )

  it('installs and deploys from the copy, never writing into the package', async () => {
    await deploy()
    const install = spawnCalls.find((c) => c.cmd === 'npm')!
    // Dev dependencies carry the cdk CLI and ts-node: a NODE_ENV=production
    // environment must not drop them.
    expect(install.args).toEqual(['ci', '--include=dev'])
    expect(install.cwd).toBe(workDir)
    expect(spawnCalls.find((c) => c.args.includes('deploy'))!.cwd).toBe(workDir)
    expect(fs.existsSync(path.join(workDir, 'lib', 'stack.ts'))).toBe(true)
    expect(fs.existsSync(path.join(packageRoot!, 'infra', 'node_modules'))).toBe(false)
  })

  it('reuses the install while the shipped lockfile is the same, reinstalls when it changes', async () => {
    await deploy()
    spawnCalls.length = 0
    await deploy()
    expect(spawnCalls.some((c) => c.cmd === 'npm')).toBe(false)

    // An upgrade ships a new lockfile (a newer CDK): the copy must follow it.
    await fsp.writeFile(path.join(packageRoot!, 'infra', 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n', 'utf-8')
    spawnCalls.length = 0
    await deploy()
    expect(spawnCalls.filter((c) => c.cmd === 'npm')).toHaveLength(1)
  })

  it('a refresh drops files the package no longer ships and keeps the build state', async () => {
    await deploy()
    await fsp.writeFile(path.join(workDir, 'cdk.context.json'), '{"account":"cached"}', 'utf-8')
    await fsp.rm(path.join(packageRoot!, 'infra', 'lib', 'stack.ts'))
    await fsp.writeFile(path.join(packageRoot!, 'infra', 'lib', 'renamed.ts'), 'export {}\n', 'utf-8')
    await deploy()
    expect(fs.existsSync(path.join(workDir, 'lib', 'stack.ts'))).toBe(false)
    expect(fs.existsSync(path.join(workDir, 'lib', 'renamed.ts'))).toBe(true)
    expect(fs.readFileSync(path.join(workDir, 'cdk.context.json'), 'utf-8')).toContain('cached')
    expect(fs.existsSync(path.join(workDir, 'node_modules', 'aws-cdk-lib'))).toBe(true)
  })

  it('a half install (the marker but no stamp, as an interrupted npm ci leaves) is redone', async () => {
    await fsp.mkdir(path.join(workDir, 'node_modules', 'aws-cdk-lib'), { recursive: true })
    await deploy()
    expect(spawnCalls.filter((c) => c.cmd === 'npm')).toHaveLength(1)
  })

  it('keeps the lock stamp inside node_modules, where npm ci removes it first', async () => {
    await deploy()
    expect(fs.existsSync(path.join(workDir, 'node_modules', '.walnut-installed-lock'))).toBe(true)
    expect(fs.existsSync(path.join(workDir, '.walnut-installed-lock'))).toBe(false)
  })

  it('an interrupted reinstall never leaves a stamp that matches the older lock', async () => {
    const lock = path.join(packageRoot!, 'infra', 'package-lock.json')
    const v1 = fs.readFileSync(lock, 'utf-8')
    await deploy()                                        // installed and stamped for v1
    await fsp.writeFile(lock, '{"lockfileVersion":3,"v":2}\n', 'utf-8')
    npmCi = { code: 1, delayMs: 0 }                       // the upgrade's npm ci fails half way
    await expect(deploy()).rejects.toThrow(/npm ci failed/)
    await fsp.writeFile(lock, v1, 'utf-8')                // back to the v1 package
    npmCi = { code: 0, delayMs: 0 }
    spawnCalls.length = 0
    await deploy()
    expect(spawnCalls.filter((c) => c.cmd === 'npm')).toHaveLength(1)
  })

  it('a cancelled install settles only after npm has exited', async () => {
    npmCi = { code: 0, delayMs: 80 }
    const ac = new AbortController()
    const run = awsDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', signal: ac.signal },
      (l) => logs.push(l),
    )
    while (!spawnCalls.some((c) => c.cmd === 'npm')) await new Promise((r) => setTimeout(r, 5))
    ac.abort()
    let settledAt = 0
    await run.catch(() => { settledAt = Date.now() })
    expect(npmClosedAt).toHaveLength(1)
    expect(settledAt).toBeGreaterThanOrEqual(npmClosedAt[0])
    expect(spawnCalls.some((c) => c.args.includes('deploy'))).toBe(false)
  })

  it('a job restarted while another prepares never runs npm ci beside it', async () => {
    npmCi = { code: 0, delayMs: 40 }
    await Promise.all([deploy(), deploy()])
    expect(npmMaxActive).toBe(1)
    // The second waited, found the first one's install, and did not reinstall.
    expect(spawnCalls.filter((c) => c.cmd === 'npm')).toHaveLength(1)
  })

  it('tears down from the same copy', async () => {
    await awsDriver.teardown!('i-0abc', (l) => logs.push(l), { profile: 'marina-dev' })
    const destroy = spawnCalls.find((c) => c.args.includes('destroy'))!
    expect(destroy.cwd).toBe(workDir)
    expect(destroy.env?.AWS_PROFILE).toBe('marina-dev')
  })

  it('the manual steps name the package copy, not a checkout', () => {
    const { steps } = awsDriver.instructions({ userData: USER_DATA, domain: '', domainMode: 'sslip' })
    const joined = steps.join('\n')
    // Quoted (a home dir may hold a space) and with the dev dependencies cdk needs.
    expect(joined).toContain(`'${path.join(packageRoot!, 'infra')}'/.`)
    expect(joined).toContain(`'${workDir}'`)
    expect(joined).toContain('npm ci --include=dev')
    expect(joined).not.toMatch(/source checkout/)
  })
})

describe('awsDriver.detectCreds says what blocks a deploy before the wizard asks anything', () => {
  beforeEach(() => {
    resetNpmProbeForTests()
    execFileCalls.length = 0
    execFileReplies = { 'sts get-caller-identity --output json': { stdout: '{"Account":"111122223333"}' } }
  })
  afterEach(() => { installDir = null; packageRoot = null })

  it('no CDK app at all: not ready, and no aws call is made', async () => {
    installDir = null
    packageRoot = null
    const res = await awsDriver.detectCreds()
    expect(res.available).toBe(false)
    expect(res.detail).toMatch(/no CDK app/)
    expect(execFileCalls).toHaveLength(0)
  })

  it('no npm on this machine: not ready, saying Node.js and npm are needed', async () => {
    packageRoot = await fakeRoot('walnut-aws-nonpm-')
    const enoent = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    execFileReplies['--version'] = { error: enoent }
    const res = await awsDriver.detectCreds()
    expect(res.available).toBe(false)
    expect(res.detail).toMatch(/needs Node\.js and npm/)
    expect(execFileCalls.some((c) => c.cmd === 'aws')).toBe(false)
    await fsp.rm(packageRoot, { recursive: true, force: true })
  })

  it('a package with its CDK app and npm present is ready like a checkout', async () => {
    packageRoot = await fakeRoot('walnut-aws-ready-')
    execFileReplies['--version'] = { stdout: '10.9.0\n' }
    const res = await awsDriver.detectCreds()
    expect(res.available).toBe(true)
    expect(res.detail).toContain('111122223333')
    await fsp.rm(packageRoot, { recursive: true, force: true })
  })

  it('asks npm once: a later check spends its few seconds on the credentials only', async () => {
    packageRoot = await fakeRoot('walnut-aws-npm-once-')
    execFileReplies['--version'] = { stdout: '10.9.0\n' }
    await awsDriver.detectCreds()
    await awsDriver.detectCreds()
    expect(execFileCalls.filter((c) => c.cmd === 'npm')).toHaveLength(1)
    await fsp.rm(packageRoot, { recursive: true, force: true })
  })

  it('a missing npm is asked again, so installing Node.js shows up on the next check', async () => {
    packageRoot = await fakeRoot('walnut-aws-npm-later-')
    execFileReplies['--version'] = { error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) }
    expect((await awsDriver.detectCreds()).detail).toMatch(/needs Node\.js and npm/)
    execFileReplies['--version'] = { stdout: '10.9.0\n' }
    expect((await awsDriver.detectCreds()).available).toBe(true)
    await fsp.rm(packageRoot, { recursive: true, force: true })
  })
})
