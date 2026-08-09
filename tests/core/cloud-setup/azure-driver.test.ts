/**
 * Azure driver — the `az` command lines it builds, and the two things that cost
 * the operator real money or real secrets if they regress.
 *
 * `az` is never run: node:child_process.spawn is stubbed and every invocation is
 * RECORDED, so these tests make zero cloud calls. The recording is what lets the
 * resume test assert a negative ("adopting an existing VM issued NO vm create")
 * and the secrets test assert that the boot script reached the CLI through a
 * FILE rather than the argv.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'

interface Call { cmd: string; args: string[] }

let calls: Call[] = []
/** Contents of each file passed via a path arg, captured while it still exists. */
let capturedFiles: Record<string, string> = {}
/** Temp dirs seen on an argv, so a test can assert they were cleaned up. */
let seenTempPaths: string[] = []

type Reply = { code?: number; stdout?: string; stderr?: string }
type Handler = (call: Call) => Reply
let routes: Array<{ match: (args: string[]) => boolean; handler: Handler }> = []
/**
 * When set, spawn emits an 'error' with this code instead of running — the only
 * way to reproduce a missing binary, which no exit-code stub can express.
 */
let spawnErrorCode: string | null = null
/** Exit code the stubbed ssh-keygen reports, so the failure path is reachable. */
let keygenExit = 0

/** Route on an ordered subsequence of argv tokens, e.g. ['vm','create']. */
function route(tokens: string[], handler: Handler): void {
  routes.push({
    match: (args) => tokens.every((t, i) => args[i] === t),
    handler,
  })
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      const call: Call = { cmd, args }
      calls.push(call)
      // Capture the secret file's CONTENT and PATH while the process is still
      // "running": the driver deletes the temp dir the moment it returns, so a
      // later read would always find nothing and the test would prove nothing.
      for (const arg of args) {
        const file = arg.replace(/^startup-script=/, '')
        if (file.includes('walnut-az-')) {
          seenTempPaths.push(file)
          if (fs.existsSync(file)) capturedFiles[file] = fs.readFileSync(file, 'utf-8')
        }
      }
      // Real PassThroughs: the runner calls setEncoding() on both pipes.
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough; stderr: PassThrough; kill: () => void
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => {}
      if (spawnErrorCode) {
        setTimeout(() => {
          const err = new Error(`spawn ${cmd} ${spawnErrorCode}`) as Error & { code: string }
          err.code = spawnErrorCode as string
          child.emit('error', err)
        }, 0)
        return child
      }
      if (cmd === 'ssh-keygen') {
        // Write the key pair the real thing would, so the driver's later
        // reference to `<keyfile>.pub` points at a file that actually exists.
        const keyFile = args[args.indexOf('-f') + 1]
        if (keygenExit === 0) {
          fs.writeFileSync(keyFile, 'PRIVATE-KEY-PLACEHOLDER', { mode: 0o600 })
          fs.writeFileSync(`${keyFile}.pub`, 'ssh-ed25519 AAAA open-walnut-throwaway\n')
          seenTempPaths.push(keyFile, `${keyFile}.pub`)
        }
        setTimeout(() => {
          child.stdout.end('')
          child.stderr.end(keygenExit === 0 ? '' : 'ssh-keygen: no such directory')
          child.emit('close', keygenExit)
        }, 0)
        return child
      }
      const hit = routes.find((r) => r.match(args))
      const reply: Reply = hit ? hit.handler(call) : { code: 0, stdout: '{}' }
      setTimeout(() => {
        child.stdout.end(reply.stdout ?? '')
        child.stderr.end(reply.stderr ?? '')
        child.emit('close', reply.code ?? 0)
      }, 0)
      return child
    },
  }
})

const { azureDriver } = await import('../../../src/core/cloud-setup/providers/azure.js')

const PAIRING_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const USER_DATA = `#!/usr/bin/env bash\nprintf '%s' '${PAIRING_CODE}' > /etc/walnut/setup-token\n`

const IP_JSON = JSON.stringify({ publicIp: { ipAddress: '203.0.113.77' } })
const VM_IPS_JSON = JSON.stringify([
  { virtualMachine: { network: { publicIpAddresses: [{ ipAddress: '203.0.113.77' }] } } },
])

/** Fresh-create stubs: no VM yet, static IP hands back an address. */
function stubFreshCreate(): void {
  route(['account', 'show'], () => ({ code: 0, stdout: JSON.stringify({ name: 'Pay-As-You-Go' }) }))
  route(['group', 'create'], () => ({ code: 0, stdout: '{}' }))
  // Not found — the normal first-run answer for the adopt probe.
  route(['vm', 'show'], () => ({ code: 3, stderr: "ResourceNotFound: The Resource 'walnut-cloud' was not found" }))
  route(['network', 'public-ip', 'create'], () => ({ code: 0, stdout: IP_JSON }))
  route(['vm', 'create'], () => ({ code: 0, stdout: '{}' }))
  route(['vm', 'open-port'], () => ({ code: 0, stdout: '{}' }))
}

/** Every `az` invocation whose argv starts with these tokens. */
function invocations(...tokens: string[]): Call[] {
  return calls.filter((c) => tokens.every((t, i) => c.args[i] === t))
}

beforeEach(() => {
  calls = []
  routes = []
  capturedFiles = {}
  seenTempPaths = []
  spawnErrorCode = null
  keygenExit = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('azureDriver.detectCreds', () => {
  it('tells the operator to install the CLI when az is absent', async () => {
    // A missing binary arrives as spawn's 'error' event with ENOENT — there is
    // no exit code, so this case cannot be stubbed as one.
    spawnErrorCode = 'ENOENT'
    const detect = await azureDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/Install the Azure CLI/)
    expect(detect.detail).toMatch(/manual path/)
  })

  it('reports not-ready rather than crashing when the CLI fails to launch for another reason', async () => {
    spawnErrorCode = 'EACCES'
    const detect = await azureDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/did not respond/)
  })

  it('reports signed-out when az is present but az account show fails', async () => {
    route(['account', 'show'], () => ({
      code: 1,
      stderr: "Please run 'az login' to setup account.",
    }))
    const detect = await azureDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/not signed in/)
    expect(detect.detail).toMatch(/az login/)
  })

  it('reports the subscription name when signed in, and nothing more', async () => {
    // The subscription ID and tenant ID identify the operator's tenant and this
    // string is rendered in the wizard and written to the log — name only.
    route(['account', 'show'], () => ({
      code: 0,
      stdout: JSON.stringify({
        name: 'Pay-As-You-Go',
        id: '00000000-1111-2222-3333-444444444444',
        tenantId: '99999999-8888-7777-6666-555555555555',
        user: { name: 'operator@example.com' },
      }),
    }))
    const detect = await azureDriver.detectCreds()
    expect(detect).toMatchObject({ available: true, needs: 'nothing' })
    expect(detect.detail).toBe('Azure CLI — subscription Pay-As-You-Go')
    expect(detect.detail).not.toContain('00000000')
    expect(detect.detail).not.toContain('operator@example.com')
  })

  it('stays usable when az prints something that is not JSON', async () => {
    route(['account', 'show'], () => ({ code: 0, stdout: 'not json at all' }))
    const detect = await azureDriver.detectCreds()
    expect(detect.available).toBe(true)
    expect(detect.detail).toBe('Azure CLI signed in')
  })

  it('runs az account show with a JSON output flag and nothing else', async () => {
    route(['account', 'show'], () => ({ code: 0, stdout: '{}' }))
    await azureDriver.detectCreds()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ cmd: 'az', args: ['account', 'show', '-o', 'json'] })
  })
})

describe('azureDriver.createVM — fresh create', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('ensures the group, probes for an existing VM, reserves a static IP, creates, then opens ports', async () => {
    stubFreshCreate()
    const result = await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain', domain: 'wn.example.com' },
      (l) => logs.push(l),
    )
    // Order matters: the adopt probe must precede anything chargeable, and the
    // static IP must exist before the VM that attaches it.
    expect(calls.filter((c) => c.cmd === 'az').map((c) => c.args.slice(0, 3).join(' '))).toEqual([
      'group create -n',
      'vm show -g',
      'network public-ip create',
      'vm create -g',
      'vm open-port -g',
    ])
    expect(result).toMatchObject({
      ip: '203.0.113.77',
      instanceRef: 'walnut-cloud/walnut-cloud',
      domain: 'wn.example.com',
    })
  })

  it('reserves a STATIC Standard IP, not a dynamic one', async () => {
    // A dynamic Azure IP is released on deallocation; the operator's A record
    // and the sslip hostname would both go stale after a stop/start.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const args = invocations('network', 'public-ip', 'create')[0].args
    expect(args).toContain('walnut-cloud-ip')
    expect(args.join(' ')).toContain('--allocation-method Static')
    expect(args.join(' ')).toContain('--sku Standard')
  })

  it('boots Ubuntu 24.04 at the default size and attaches the static IP and NSG', async () => {
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const argv = invocations('vm', 'create')[0].args.join(' ')
    expect(argv).toContain('--image Ubuntu2404')
    expect(argv).toContain('--size Standard_B2ats_v2')
    expect(argv).toContain('-l eastus')
    expect(argv).toContain('--public-ip-address walnut-cloud-ip')
    expect(argv).toContain('--nsg walnut-cloud-nsg')
  })

  it('opens inbound tcp 80 and 443', async () => {
    // 80 matters as much as 443: Caddy's HTTP-01 challenge lands there.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const args = invocations('vm', 'open-port')[0].args
    expect(args.join(' ')).toContain('--port 80,443')
  })

  it('honours an explicit region and instanceType across every call that takes one', async () => {
    stubFreshCreate()
    await azureDriver.createVM!(
      {
        userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip',
        region: 'westeurope', instanceType: 'Standard_B2as_v2',
      },
      (l) => logs.push(l),
    )
    expect(invocations('group', 'create')[0].args.join(' ')).toContain('-l westeurope')
    expect(invocations('network', 'public-ip', 'create')[0].args.join(' ')).toContain('-l westeurope')
    const create = invocations('vm', 'create')[0].args.join(' ')
    expect(create).toContain('-l westeurope')
    expect(create).toContain('--size Standard_B2as_v2')
  })

  it('derives the sslip.io hostname from the static IP', async () => {
    stubFreshCreate()
    const result = await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    // Must match what the boot script derives on the box, or the claim targets a
    // hostname nothing serves.
    expect(result.domain).toBe('203-0-113-77.sslip.io')
  })

  it('accepts a bare public-ip payload as well as the {publicIp} envelope', async () => {
    stubFreshCreate()
    routes = routes.filter((r) => !r.match(['network', 'public-ip', 'create']))
    route(['network', 'public-ip', 'create'], () => ({ code: 0, stdout: JSON.stringify({ ipAddress: '198.51.100.9' }) }))
    const result = await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('198.51.100.9')
  })

  it('own-domain mode without a domain throws before spawning anything', async () => {
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain' },
      (l) => logs.push(l),
    )).rejects.toThrow(/requires a domain/)
    expect(calls).toHaveLength(0)
  })
})

describe('azureDriver.createVM — the boot script never touches the argv', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('passes the script as a --custom-data FILE whose contents match, and keeps it off the command line', async () => {
    // The script embeds the pairing code. On the argv it would be visible to any
    // local process for the life of the CLI, and it would land in the echoed
    // command line this driver streams to the operator log.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const args = invocations('vm', 'create')[0].args
    const idx = args.indexOf('--custom-data')
    expect(idx).toBeGreaterThan(-1)
    const file = args[idx + 1]
    expect(capturedFiles[file]).toBe(USER_DATA)
    // Nothing on the argv contains the script or the code.
    for (const arg of args) {
      expect(arg).not.toContain(PAIRING_CODE)
      expect(arg).not.toContain('setup-token')
    }
  })

  it('writes that file 0600 so another local user cannot read the pairing code', async () => {
    let mode = -1
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'vm' && args[1] === 'create',
      handler: (call) => {
        const file = call.args[call.args.indexOf('--custom-data') + 1]
        mode = fs.statSync(file).mode & 0o777
        return { code: 0, stdout: '{}' }
      },
    })
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(mode).toBe(0o600)
  })

  it('keeps the pairing code out of every operator-visible log line', async () => {
    // logTail is streamed over SSE and returned by REST.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(PAIRING_CODE)
    expect(joined).not.toContain(Buffer.from(USER_DATA, 'utf-8').toString('base64'))
  })

  it('never touches the operator ~/.ssh — it generates a throwaway key in the temp dir', async () => {
    // az requires an admin credential for a Linux VM, and its own
    // --generate-ssh-keys writes into ~/.ssh. Nobody logs into this box, so the
    // driver makes a throwaway key inside the temp dir and passes only its
    // public half.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const keygen = calls.find((c) => c.cmd === 'ssh-keygen')
    expect(keygen, 'a throwaway key must be generated').toBeDefined()
    const keyFile = keygen!.args[keygen!.args.indexOf('-f') + 1]
    expect(keyFile).toContain('walnut-az-')
    expect(keyFile).not.toContain('.ssh/')
    // No passphrase, and an explicit type so it does not depend on ssh-keygen's default.
    expect(keygen!.args).toContain('-N')
    expect(keygen!.args.join(' ')).toContain('-t ed25519')

    const args = invocations('vm', 'create')[0].args
    // The PUBLIC half only, and never az's own ~/.ssh-writing generator.
    expect(args[args.indexOf('--ssh-key-values') + 1]).toBe(`${keyFile}.pub`)
    expect(args).not.toContain('--generate-ssh-keys')
    // --ssh-dest-key-path is a path ON THE VM (authorized_keys), not a local
    // destination — using it as one would silently leave the key in ~/.ssh.
    expect(args).not.toContain('--ssh-dest-key-path')
  })

  it('fails with an explanation when the throwaway key cannot be generated', async () => {
    stubFreshCreate()
    keygenExit = 1
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/Could not generate a throwaway SSH key/)
    // And it never got as far as creating anything chargeable.
    expect(invocations('vm', 'create')).toHaveLength(0)
  })

  it('starts the NSG closed rather than letting az seed an inbound SSH rule', async () => {
    // A brand-new NSG from `az vm create` defaults to allowing SSH. Nothing here
    // uses SSH, so the only inbound rules should be the 80/443 added afterwards.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(invocations('vm', 'create')[0].args.join(' ')).toContain('--nsg-rule NONE')
  })

  it('deletes the temp dir after a SUCCESSFUL provision', async () => {
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(seenTempPaths.length).toBeGreaterThan(0)
    for (const file of seenTempPaths) expect(fs.existsSync(file)).toBe(false)
  })

  it('deletes the temp dir when the create FAILS too', async () => {
    // The finally clause is the whole point: a job that fails at create must not
    // leave a world-readable-directory-adjacent copy of the pairing code behind.
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'vm' && args[1] === 'create',
      handler: () => ({ code: 1, stderr: 'SkuNotAvailable: The requested size is not available' }),
    })
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/SkuNotAvailable/)
    expect(seenTempPaths.length).toBeGreaterThan(0)
    for (const file of seenTempPaths) expect(fs.existsSync(file)).toBe(false)
  })
})

describe('azureDriver.createVM — resume safety', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('adopts an existing VM by name and creates NOTHING', async () => {
    // A job that died after vm create must converge on the box it already made.
    // A second create here would leave the operator paying for two machines,
    // only one of which Walnut tracks.
    route(['group', 'create'], () => ({ code: 0, stdout: '{}' }))
    route(['vm', 'show'], () => ({ code: 0, stdout: JSON.stringify({ name: 'walnut-cloud' }) }))
    route(['vm', 'list-ip-addresses'], () => ({ code: 0, stdout: VM_IPS_JSON }))
    const result = await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(invocations('vm', 'create')).toHaveLength(0)
    expect(invocations('network', 'public-ip', 'create')).toHaveLength(0)
    expect(result).toMatchObject({
      ip: '203.0.113.77',
      instanceRef: 'walnut-cloud/walnut-cloud',
      domain: '203-0-113-77.sslip.io',
    })
    expect(logs.join('\n')).toMatch(/adopting it instead of creating one/)
  })

  it('fails clearly when the adopted VM has no public IP', async () => {
    route(['group', 'create'], () => ({ code: 0, stdout: '{}' }))
    route(['vm', 'show'], () => ({ code: 0, stdout: '{}' }))
    route(['vm', 'list-ip-addresses'], () => ({
      code: 0,
      stdout: JSON.stringify([{ virtualMachine: { network: { publicIpAddresses: [] } } }]),
    }))
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/no public IP address/)
  })

  it('re-running the static IP create is harmless — az PUT semantics, no adopt branch needed', async () => {
    // Asserted as a contract note: the driver issues create unconditionally and
    // expects the same address back, which is what makes a retry converge.
    stubFreshCreate()
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    calls = []
    await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(invocations('network', 'public-ip', 'create')).toHaveLength(1)
  })
})

describe('azureDriver.createVM — error surfacing', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it("puts az's stderr in the thrown message, not just an exit code", async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'group' && args[1] === 'create',
      handler: () => ({
        code: 1,
        stderr: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Resources/subscriptions/resourcegroups/write'",
      }),
    })
    const message = await azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    ).then(() => 'resolved, but should have thrown', (e: Error) => e.message)
    expect(message).toMatch(/az group create failed \(exit 1\)/)
    expect(message).toMatch(/AuthorizationFailed/)
    expect(message).toMatch(/does not have authorization/)
  })

  it('falls back to stdout when the CLI put its complaint there', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'vm' && args[1] === 'open-port',
      handler: () => ({ code: 2, stdout: 'nsg walnut-cloud-nsg not found' }),
    })
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/nsg walnut-cloud-nsg not found/)
  })

  it('explains a static IP that came back without an address', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'network',
      handler: () => ({ code: 0, stdout: JSON.stringify({ publicIp: {} }) }),
    })
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/reported no address/)
  })

  it('says so when az emits something unparseable where JSON was required', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[0] === 'network',
      handler: () => ({ code: 0, stdout: 'WARNING: extension update available' }),
    })
    await expect(azureDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/not JSON/)
  })
})

describe('azureDriver registration + metadata', () => {
  it('is registered under the azure id, so the wizard and POST /start can reach it', async () => {
    const { getDriver, listDrivers } = await import('../../../src/core/cloud-setup/providers/index.js')
    expect(getDriver('azure')).toBe(azureDriver)
    expect(listDrivers().map((d) => d.id)).toContain('azure')
  })

  it('advertises itself as one-click provisionable', () => {
    // canProvision in GET /providers is derived from createVM being present.
    expect(azureDriver.createVM).toBeTypeOf('function')
  })

  it('declares the ubuntu user-data flavor, so the boot script reaches for apt', () => {
    expect(azureDriver.userDataFlavor).toBe('ubuntu')
  })

  it('exposes no teardown — the honest unit of deletion is the resource group', () => {
    expect(azureDriver.teardown).toBeUndefined()
  })

  it('names a price and the size it refers to', () => {
    expect(azureDriver.costHint).toMatch(/B2ats_v2/)
    expect(azureDriver.costHint).toMatch(/\$/)
  })
})

describe('azureDriver.instructions', () => {
  it('covers login, the group, the static IP, ports, the image and the custom-data file', () => {
    const { steps, consoleUrl } = azureDriver.instructions({
      userData: USER_DATA, domain: 'wn.example.com', domainMode: 'own-domain',
    })
    const joined = steps.join('\n')
    expect(joined).toMatch(/az login/)
    expect(joined).toContain('az group create -n walnut-cloud')
    expect(joined).toContain('--allocation-method Static')
    expect(joined).toContain('az vm open-port')
    expect(joined).toContain('80,443')
    expect(joined).toMatch(/Ubuntu 24\.04/)
    expect(joined).toContain('--custom-data')
    expect(joined).toContain('A record for wn.example.com')
    expect(consoleUrl).toContain('portal.azure.com')
  })

  it('tells the operator to use a FILE for the script, since it carries the pairing code', () => {
    const joined = azureDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/file rather than pasting it on a command line/)
    expect(joined).toMatch(/pairing code/)
  })

  it('sslip mode says there is no DNS record, and never prints "undefined"', () => {
    const joined = azureDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/No DNS record/i)
    expect(joined).not.toContain('undefined')
  })

  it('echoes an overridden region/size into the manual steps', () => {
    const joined = azureDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
      region: 'westeurope', instanceType: 'Standard_B2as_v2',
    }).steps.join('\n')
    expect(joined).toContain('westeurope')
    expect(joined).toContain('Standard_B2as_v2')
  })

  it('hands back the boot script verbatim for the copy box', () => {
    expect(azureDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).userData).toBe(USER_DATA)
  })
})
