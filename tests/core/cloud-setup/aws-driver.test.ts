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

const spawnCalls: Array<{ cmd: string; args: string[] }> = []
/** Written to the --outputs-file of the next deploy, as cdk would. */
let stackOutputs: Record<string, string> = {}

/** Every `aws` invocation detectCreds made, and how the stub answered each. */
const execFileCalls: Array<{ cmd: string; args: string[] }> = []
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
    value: async (cmd: string, args: string[]) => {
      execFileCalls.push({ cmd, args })
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
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
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
      setTimeout(async () => {
        if (outFileIdx !== -1) {
          await fsp.writeFile(
            args[outFileIdx + 1],
            JSON.stringify({ WalnutCloudStack: stackOutputs }),
            'utf-8',
          )
        }
        child.stdout.end('fake cdk: done\n')
        child.stderr.end()
        child.emit('close', 0)
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

  it('names AWS_PROFILE when several profiles exist and the DEFAULT one is stale', async () => {
    // The reported failure: a machine with 8 profiles and an expired [default].
    // Every `aws` call inherits Walnut's env, so the probe resolves [default] and
    // fails while the profile the operator actually uses works. The old message
    // sent them to `aws configure`, which would overwrite a working config.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nmarina-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toContain('AWS_PROFILE')
    expect(detect.detail).toContain('4 profiles')
    expect(detect.detail).toMatch(/restart/)
  })

  it('never leaks the operator profile NAMES into the wizard or the log', async () => {
    // Same restraint as the caller ARN: what the operator called their accounts is
    // theirs, and detail is both rendered and written to disk.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).not.toContain('walnut-dev')
    expect(detect.detail).not.toContain('acme-prod')
  })

  it('does NOT suggest AWS_PROFILE when it is already set — that one just failed', async () => {
    // Telling an operator to set a variable they have already set reads as a bug.
    process.env.AWS_PROFILE = 'walnut-dev'
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\nwalnut-dev\nacme-prod\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).toMatch(/AWS_PROFILE currently set/)
    expect(detect.detail).not.toMatch(/set AWS_PROFILE=<name>/)
    expect(detect.detail).not.toContain('walnut-dev')
  })

  it('keeps the plain advice when there is only one profile to blame', async () => {
    execFileReplies[IDENTITY] = { error: invalidToken() }
    execFileReplies[PROFILES] = { stdout: 'default\n' }
    const detect = await awsDriver.detectCreds()
    expect(detect.detail).toMatch(/aws configure/)
    expect(detect.detail).not.toContain('AWS_PROFILE')
  })

  it('still answers when the profile count cannot be determined', async () => {
    // `aws configure list-profiles` is advisory only: a CLI too old to have the
    // subcommand must not turn a clean "not signed in" into a crash.
    execFileReplies[IDENTITY] = { error: invalidToken() }
    const detect = await awsDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/no usable credentials/)
  })
})

describe('awsDriver.createVM', () => {
  const logs: string[] = []

  beforeEach(async () => {
    spawnCalls.length = 0
    logs.length = 0
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
