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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
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
