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
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const spawnCalls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = []
/** Written to the --outputs-file of the next deploy, as cdk would. */
let stackOutputs: Record<string, string> = {}
/** What the next `cdk deploy` prints and exits with. Reset per test. */
let deployOutput: () => { text: string; code: number } = () => ({ text: 'fake cdk: done', code: 0 })

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
    spawn: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      // cdk resolves the target ACCOUNT from its own env, so record it.
      spawnCalls.push({ cmd, args, env: opts?.env })
      // Real PassThroughs, not bare EventEmitters: the driver calls
      // stream.setEncoding() on both pipes, so a fake without it would fail for
      // a reason that has nothing to do with what these tests assert.
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {}
      const outFileIdx = args.indexOf('--outputs-file')
      // Only the deploy consults deployOutput, so a test can make the FIRST deploy
      // report "not bootstrapped" and still let the retry succeed.
      const reply = args.includes('deploy') ? deployOutput() : { text: 'fake cdk: done', code: 0 }
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
        child.emit('close', reply.code)
      }, 0)
      return child
    },
  }
})

// The driver refuses to run outside a source checkout with a real infra/cdk.json,
// so point WALNUT_INSTALL_DIR at a temp checkout containing one.
let installDir: string
vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, get WALNUT_INSTALL_DIR() { return installDir } }
})

const { awsDriver } = await import('../../../src/core/cloud-setup/providers/aws.js')

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
  beforeEach(() => {
    execFileCalls.length = 0
    execFileReplies = {}
    savedProfile = process.env.AWS_PROFILE
    delete process.env.AWS_PROFILE
  })
  afterEach(() => {
    if (savedProfile === undefined) delete process.env.AWS_PROFILE
    else process.env.AWS_PROFILE = savedProfile
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
    installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-aws-driver-'))
    // Minimal fake checkout: infra/cdk.json + a node_modules marker so the
    // driver skips its `npm ci` step.
    await fsp.mkdir(path.join(installDir, 'infra', 'node_modules', 'aws-cdk-lib'), { recursive: true })
    await fsp.writeFile(path.join(installDir, 'infra', 'cdk.json'), '{}', 'utf-8')
  })

  afterEach(async () => {
    await fsp.rm(installDir, { recursive: true, force: true }).catch(() => {})
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
