/**
 * GCP driver — the `gcloud` command lines it builds, and the behaviors that cost
 * the operator real money or real secrets if they regress.
 *
 * `gcloud` is never run: node:child_process.spawn is stubbed and every
 * invocation is RECORDED, so these tests make zero cloud calls. Two GCP-specific
 * contracts get their own cases: `get-value project` exits 0 while printing
 * '(unset)' (so an exit-code-only detect would report a false ready), and
 * gcloud's create verbs are strict POSTs that fail on a re-run, which the driver
 * must treat as success for the resources a retry legitimately re-attempts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'

interface Call { cmd: string; args: string[] }

let calls: Call[] = []
/** Contents of each secret file, captured while the process is still "running". */
let capturedFiles: Record<string, string> = {}
let seenTempPaths: string[] = []

type Reply = { code?: number; stdout?: string; stderr?: string }
type Handler = (call: Call) => Reply
let routes: Array<{ match: (args: string[]) => boolean; handler: Handler }> = []
/** When set, spawn emits an 'error' with this code instead of running. */
let spawnErrorCode: string | null = null

/** Route on an ordered prefix of argv tokens, e.g. ['compute','instances','create']. */
function route(tokens: string[], handler: Handler): void {
  routes.push({ match: (args) => tokens.every((t, i) => args[i] === t), handler })
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      const call: Call = { cmd, args }
      calls.push(call)
      // Capture the secret file's CONTENT and PATH now: the driver deletes the
      // temp dir the moment it returns, so a later read would prove nothing.
      for (const arg of args) {
        const file = arg.replace(/^startup-script=/, '')
        if (file.includes('walnut-gcp-')) {
          seenTempPaths.push(file)
          if (fs.existsSync(file)) capturedFiles[file] = fs.readFileSync(file, 'utf-8')
        }
      }
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

const { gcpDriver, regionFromZone } = await import('../../../src/core/cloud-setup/providers/gcp.js')

const PAIRING_CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const USER_DATA = `#!/usr/bin/env bash\nprintf '%s' '${PAIRING_CODE}' > /etc/walnut/setup-token\n`

const ADDRESS_JSON = JSON.stringify({ address: '203.0.113.77', name: 'walnut-cloud-ip' })
const INSTANCE_JSON = JSON.stringify({
  name: 'walnut-cloud',
  networkInterfaces: [{ accessConfigs: [{ natIP: '203.0.113.77' }] }],
})

/** gcloud's real wording for a duplicate create. */
const ALREADY_EXISTS = "ERROR: (gcloud.compute.addresses.create) Could not fetch resource:\n"
  + ' - The resource \'projects/acme-dev/regions/us-central1/addresses/walnut-cloud-ip\' already exists\n'

function stubFreshCreate(): void {
  route(['config', 'get-value', 'project'], () => ({ code: 0, stdout: 'acme-dev\n' }))
  route(['auth', 'list'], () => ({ code: 0, stdout: JSON.stringify([{ account: 'op@example.com', status: 'ACTIVE' }]) }))
  // Not found — the normal first-run answer for the adopt probe.
  route(['compute', 'instances', 'describe'], () => ({
    code: 1,
    stderr: "ERROR: (gcloud.compute.instances.describe) Could not fetch resource: - The resource 'walnut-cloud' was not found",
  }))
  route(['compute', 'addresses', 'create'], () => ({ code: 0, stdout: 'Created address.' }))
  route(['compute', 'addresses', 'describe'], () => ({ code: 0, stdout: ADDRESS_JSON }))
  route(['compute', 'firewall-rules', 'create'], () => ({ code: 0, stdout: 'Created rule.' }))
  route(['compute', 'instances', 'create'], () => ({ code: 0, stdout: '[]' }))
}

function invocations(...tokens: string[]): Call[] {
  return calls.filter((c) => tokens.every((t, i) => c.args[i] === t))
}

beforeEach(() => {
  calls = []
  routes = []
  capturedFiles = {}
  seenTempPaths = []
  spawnErrorCode = null
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('regionFromZone', () => {
  it('drops the zone suffix, and leaves a bare region alone', () => {
    // Addresses are regional while instances are zonal, so this conversion is on
    // the path of every provision — a wrong region reserves an IP the instance
    // in another region cannot attach.
    expect(regionFromZone('us-central1-a')).toBe('us-central1')
    expect(regionFromZone('europe-west4-b')).toBe('europe-west4')
    expect(regionFromZone('us-central1')).toBe('us-central1')
  })
})

describe('gcpDriver.detectCreds', () => {
  it('tells the operator to install the CLI when gcloud is absent', async () => {
    spawnErrorCode = 'ENOENT'
    const detect = await gcpDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/Install the Google Cloud CLI/)
    expect(detect.detail).toMatch(/manual path/)
  })

  it("treats the literal '(unset)' project as not ready, even though gcloud exits 0", async () => {
    // This is the trap: `gcloud config get-value project` succeeds and prints
    // '(unset)'. An exit-code-only check would paint the provider Ready and the
    // job would then fail at create with a much worse message.
    route(['config', 'get-value', 'project'], () => ({ code: 0, stdout: '(unset)\n' }))
    const detect = await gcpDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/no project set/)
    expect(detect.detail).toMatch(/gcloud config set project/)
    // And it never bothered asking about accounts — no project, no point.
    expect(invocations('auth', 'list')).toHaveLength(0)
  })

  it('treats an empty project the same way', async () => {
    route(['config', 'get-value', 'project'], () => ({ code: 0, stdout: '\n' }))
    const detect = await gcpDriver.detectCreds()
    expect(detect.available).toBe(false)
    expect(detect.detail).toMatch(/no project set/)
  })

  it('reports not ready when a project is set but no account is ACTIVE', async () => {
    route(['config', 'get-value', 'project'], () => ({ code: 0, stdout: 'acme-dev\n' }))
    route(['auth', 'list'], () => ({ code: 0, stdout: '[]' }))
    const detect = await gcpDriver.detectCreds()
    expect(detect).toMatchObject({ available: false, needs: 'cli-login' })
    expect(detect.detail).toMatch(/no active account/)
    expect(detect.detail).toMatch(/gcloud auth login/)
  })

  it('reports the project when both checks pass, and never the account email', async () => {
    // The project id is operator-chosen and all over their own console; the
    // account email is a personal identifier and this string is rendered in the
    // wizard and written to the log.
    stubFreshCreate()
    const detect = await gcpDriver.detectCreds()
    expect(detect).toMatchObject({ available: true, needs: 'nothing' })
    expect(detect.detail).toBe('Google Cloud CLI — project acme-dev')
    expect(detect.detail).not.toContain('op@example.com')
  })

  it('filters the auth list to ACTIVE accounts and asks for JSON', async () => {
    stubFreshCreate()
    await gcpDriver.detectCreds()
    const args = invocations('auth', 'list')[0].args
    expect(args).toContain('--filter=status:ACTIVE')
    expect(args).toContain('--format=json')
  })
})

describe('gcpDriver.createVM — fresh create', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('probes for an existing instance, reserves the address, opens the firewall, then creates', async () => {
    stubFreshCreate()
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain', domain: 'wn.example.com' },
      (l) => logs.push(l),
    )
    // Order matters: the adopt probe precedes anything chargeable, and the
    // address must exist before the instance that attaches it.
    expect(calls.map((c) => c.args.slice(0, 3).join(' '))).toEqual([
      'compute instances describe',
      'compute addresses create',
      'compute addresses describe',
      'compute firewall-rules create',
      'compute instances create',
    ])
    expect(result).toMatchObject({
      ip: '203.0.113.77',
      instanceRef: 'us-central1-a/walnut-cloud',
      domain: 'wn.example.com',
    })
  })

  it('reserves the address in the REGION derived from the zone', async () => {
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip', region: 'europe-west4-b' },
      (l) => logs.push(l),
    )
    // An address reserved in the wrong region cannot be attached at create time.
    expect(invocations('compute', 'addresses', 'create')[0].args.join(' ')).toContain('--region europe-west4')
    expect(invocations('compute', 'instances', 'create')[0].args.join(' ')).toContain('--zone europe-west4-b')
  })

  it('always describes the address rather than parsing the create output', async () => {
    // `create` prints a human table; only `describe --format=json` is stable.
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(invocations('compute', 'addresses', 'describe')[0].args).toContain('--format=json')
  })

  it('opens tcp 80 and 443 scoped to our network tag, not the whole project', async () => {
    // 80 matters as much as 443 (Caddy's HTTP-01 challenge). Tag-scoped so the
    // operator's other instances in this project do not inherit a web rule.
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const argv = invocations('compute', 'firewall-rules', 'create')[0].args.join(' ')
    expect(argv).toContain('walnut-cloud-web')
    expect(argv).toContain('--allow tcp:80,tcp:443')
    expect(argv).toContain('--target-tags walnut-cloud')
    expect(argv).toContain('--source-ranges 0.0.0.0/0')
  })

  it('boots the Ubuntu 24.04 image family at the default machine type, tagged and on the static address', async () => {
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const argv = invocations('compute', 'instances', 'create')[0].args.join(' ')
    expect(argv).toContain('--image-family ubuntu-2404-lts-amd64')
    expect(argv).toContain('--image-project ubuntu-os-cloud')
    expect(argv).toContain('--machine-type e2-small')
    expect(argv).toContain('--tags walnut-cloud')
    expect(argv).toContain('--zone us-central1-a')
    // The reserved ADDRESS, not the name: --address takes the IP literal.
    expect(argv).toContain('--address 203.0.113.77')
  })

  it('honours an explicit zone and machine type', async () => {
    stubFreshCreate()
    await gcpDriver.createVM!(
      {
        userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip',
        region: 'us-west1-b', instanceType: 'e2-medium',
      },
      (l) => logs.push(l),
    )
    const argv = invocations('compute', 'instances', 'create')[0].args.join(' ')
    expect(argv).toContain('--zone us-west1-b')
    expect(argv).toContain('--machine-type e2-medium')
  })

  it('derives the sslip.io hostname from the reserved address', async () => {
    stubFreshCreate()
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    // Must match what the boot script derives on the box, or the claim targets a
    // hostname nothing serves.
    expect(result.domain).toBe('203-0-113-77.sslip.io')
  })

  it('own-domain mode without a domain throws before spawning anything', async () => {
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'own-domain' },
      (l) => logs.push(l),
    )).rejects.toThrow(/requires a domain/)
    expect(calls).toHaveLength(0)
  })
})

describe('gcpDriver.createVM — ALREADY_EXISTS tolerance', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('treats an already-reserved address as success and reads it anyway', async () => {
    // gcloud's create verbs are strict POSTs: a retried job WILL hit this, and
    // failing here would strand every resumed provision.
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'create',
      handler: () => ({ code: 1, stderr: ALREADY_EXISTS }),
    })
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('203.0.113.77')
    expect(logs.join('\n')).toMatch(/already exists.*reusing it/)
    // It still went on to create the instance.
    expect(invocations('compute', 'instances', 'create')).toHaveLength(1)
  })

  it('treats an already-present firewall rule as success', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'firewall-rules',
      handler: () => ({ code: 1, stderr: "ERROR: ... - The resource 'walnut-cloud-web' already exists" }),
    })
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('203.0.113.77')
    expect(logs.join('\n')).toMatch(/firewall rule walnut-cloud-web already exists/)
  })

  it('matches the ALREADY_EXISTS code as well as the prose', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'create',
      handler: () => ({ code: 1, stderr: 'ERROR: code=ALREADY_EXISTS' }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).resolves.toMatchObject({ ip: '203.0.113.77' })
  })

  it('does NOT swallow a different address failure', async () => {
    // Quota, permission and bad-region errors must still fail the step; only a
    // duplicate is benign.
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'create',
      handler: () => ({ code: 1, stderr: 'ERROR: Quota IN_USE_ADDRESSES exceeded' }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/Quota IN_USE_ADDRESSES exceeded/)
  })

  it('does NOT swallow an instance-create failure — including a name collision', async () => {
    // The adopt probe above owns the "it already exists" case. Tolerating it here
    // too would hide a real bug, and report success for a box nobody configured.
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'instances' && args[2] === 'create',
      handler: () => ({ code: 1, stderr: "ERROR: The resource 'walnut-cloud' already exists" }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/gcloud compute instances create walnut-cloud failed/)
  })
})

describe('gcpDriver.createVM — the boot script never touches the argv', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('passes the script via --metadata-from-file whose contents match, and keeps it off the command line', async () => {
    // The script embeds the pairing code: on the argv it would be visible to any
    // local process for the life of the CLI, and it would land in the echoed
    // command line this driver streams to the operator log.
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const args = invocations('compute', 'instances', 'create')[0].args
    const idx = args.indexOf('--metadata-from-file')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toMatch(/^startup-script=/)
    const file = args[idx + 1].replace(/^startup-script=/, '')
    expect(capturedFiles[file]).toBe(USER_DATA)
    for (const arg of args) {
      expect(arg).not.toContain(PAIRING_CODE)
      expect(arg).not.toContain('setup-token')
    }
  })

  it('writes that file 0600 so another local user cannot read the pairing code', async () => {
    let mode = -1
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'instances' && args[2] === 'create',
      handler: (call) => {
        const arg = call.args[call.args.indexOf('--metadata-from-file') + 1]
        mode = fs.statSync(arg.replace(/^startup-script=/, '')).mode & 0o777
        return { code: 0, stdout: '[]' }
      },
    })
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(mode).toBe(0o600)
  })

  it('keeps the pairing code out of every operator-visible log line', async () => {
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    const joined = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(joined).not.toContain(PAIRING_CODE)
    expect(joined).not.toContain(Buffer.from(USER_DATA, 'utf-8').toString('base64'))
  })

  it('deletes the temp dir after a SUCCESSFUL provision', async () => {
    stubFreshCreate()
    await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(seenTempPaths.length).toBeGreaterThan(0)
    for (const file of seenTempPaths) expect(fs.existsSync(file)).toBe(false)
  })

  it('deletes the temp dir when the create FAILS too', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'instances' && args[2] === 'create',
      handler: () => ({ code: 1, stderr: 'ERROR: ZONE_RESOURCE_POOL_EXHAUSTED' }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/ZONE_RESOURCE_POOL_EXHAUSTED/)
    expect(seenTempPaths.length).toBeGreaterThan(0)
    for (const file of seenTempPaths) expect(fs.existsSync(file)).toBe(false)
  })
})

describe('gcpDriver.createVM — resume safety', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it('adopts an existing instance by name and creates NOTHING', async () => {
    // A job that died after instances create must converge on the box it already
    // made, or the operator pays for two machines and Walnut tracks one.
    route(['compute', 'instances', 'describe'], () => ({ code: 0, stdout: INSTANCE_JSON }))
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(invocations('compute', 'instances', 'create')).toHaveLength(0)
    expect(invocations('compute', 'addresses', 'create')).toHaveLength(0)
    expect(invocations('compute', 'firewall-rules', 'create')).toHaveLength(0)
    expect(result).toMatchObject({
      ip: '203.0.113.77',
      instanceRef: 'us-central1-a/walnut-cloud',
      domain: '203-0-113-77.sslip.io',
    })
    expect(logs.join('\n')).toMatch(/adopting it instead of creating one/)
  })

  it('reads the natIP out of the nested accessConfigs shape', async () => {
    route(['compute', 'instances', 'describe'], () => ({
      code: 0,
      stdout: JSON.stringify({
        networkInterfaces: [
          // An internal-only NIC first, so a naive [0][0] read would miss.
          { accessConfigs: [] },
          { accessConfigs: [{ natIP: null }, { natIP: '198.51.100.9' }] },
        ],
      }),
    }))
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('198.51.100.9')
  })

  it('fails clearly when the adopted instance has no external IP', async () => {
    route(['compute', 'instances', 'describe'], () => ({
      code: 0,
      stdout: JSON.stringify({ networkInterfaces: [{ accessConfigs: [] }] }),
    }))
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/no external IP address/)
  })
})

describe('gcpDriver.createVM — error surfacing', () => {
  const logs: string[] = []
  beforeEach(() => { logs.length = 0 })

  it("puts gcloud's stderr in the thrown message, not just an exit code", async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'instances' && args[2] === 'create',
      handler: () => ({
        code: 1,
        stderr: 'ERROR: (gcloud.compute.instances.create) Could not fetch resource: - Required \'compute.instances.create\' permission',
      }),
    })
    const message = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    ).then(() => 'resolved, but should have thrown', (e: Error) => e.message)
    expect(message).toMatch(/gcloud compute instances create walnut-cloud failed \(exit 1\)/)
    expect(message).toMatch(/compute\.instances\.create' permission/)
  })

  it('explains an address that came back without a value', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'describe',
      handler: () => ({ code: 0, stdout: JSON.stringify({ name: 'walnut-cloud-ip' }) }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/reported no address/)
  })

  it('says so when gcloud emits something unparseable where JSON was required', async () => {
    // gcloud writes progress notes to stderr, so stdout is parsed alone — a
    // warning on stderr must not break the parse, but junk on stdout must say why.
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'describe',
      handler: () => ({ code: 0, stdout: 'Updates are available for some Google Cloud CLI components.' }),
    })
    await expect(gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )).rejects.toThrow(/not JSON/)
  })

  it('parses stdout even when gcloud writes warnings to stderr at the same time', async () => {
    stubFreshCreate()
    routes.unshift({
      match: (args) => args[1] === 'addresses' && args[2] === 'describe',
      handler: () => ({
        code: 0,
        stdout: ADDRESS_JSON,
        stderr: 'WARNING: Some requests generated warnings.\n',
      }),
    })
    const result = await gcpDriver.createVM!(
      { userData: USER_DATA, name: 'walnut-cloud', domainMode: 'sslip' },
      (l) => logs.push(l),
    )
    expect(result.ip).toBe('203.0.113.77')
  })
})

describe('gcpDriver registration + metadata', () => {
  it('is registered under the gcp id, so the wizard and POST /start can reach it', async () => {
    const { getDriver, listDrivers } = await import('../../../src/core/cloud-setup/providers/index.js')
    expect(getDriver('gcp')).toBe(gcpDriver)
    expect(listDrivers().map((d) => d.id)).toContain('gcp')
  })

  it('advertises itself as one-click provisionable', () => {
    expect(gcpDriver.createVM).toBeTypeOf('function')
  })

  it('declares the ubuntu user-data flavor, so the boot script reaches for apt', () => {
    expect(gcpDriver.userDataFlavor).toBe('ubuntu')
  })

  it('exposes no teardown — deleting the instance alone strands the reserved address', () => {
    expect(gcpDriver.teardown).toBeUndefined()
  })

  it('names a price and the machine type it refers to', () => {
    expect(gcpDriver.costHint).toMatch(/e2-small/)
    expect(gcpDriver.costHint).toMatch(/\$/)
  })
})

describe('gcpDriver.instructions', () => {
  it('covers login, the address, the firewall, the image and the metadata file', () => {
    const { steps, consoleUrl } = gcpDriver.instructions({
      userData: USER_DATA, domain: 'wn.example.com', domainMode: 'own-domain',
    })
    const joined = steps.join('\n')
    expect(joined).toMatch(/gcloud auth login/)
    expect(joined).toMatch(/gcloud config set project/)
    expect(joined).toContain('gcloud compute addresses create walnut-cloud-ip')
    expect(joined).toContain('--allow tcp:80,tcp:443')
    expect(joined).toContain('--image-family ubuntu-2404-lts-amd64')
    expect(joined).toContain('--metadata-from-file startup-script=')
    expect(joined).toContain('A record for wn.example.com')
    expect(consoleUrl).toContain('console.cloud.google.com')
  })

  it('tells the operator to use a FILE for the script, since it carries the pairing code', () => {
    const joined = gcpDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/file rather than pasting it on a command line/)
    expect(joined).toMatch(/pairing code/)
  })

  it('explains why the address must be reserved rather than ephemeral', () => {
    const joined = gcpDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/ephemeral address is released/)
  })

  it('sslip mode says there is no DNS record, and never prints "undefined"', () => {
    const joined = gcpDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).steps.join('\n')
    expect(joined).toMatch(/No DNS record/i)
    expect(joined).not.toContain('undefined')
  })

  it('echoes an overridden zone into the steps, as both the zone and its region', () => {
    const joined = gcpDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
      region: 'europe-west4-b', instanceType: 'e2-medium',
    }).steps.join('\n')
    expect(joined).toContain('--zone europe-west4-b')
    expect(joined).toContain('--region europe-west4')
    expect(joined).toContain('e2-medium')
  })

  it('hands back the boot script verbatim for the copy box', () => {
    expect(gcpDriver.instructions({
      userData: USER_DATA, domain: '', domainMode: 'sslip',
    }).userData).toBe(USER_DATA)
  })
})
