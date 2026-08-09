/**
 * Cloud-setup end-to-end — a REAL second Walnut as the cloud box.
 *
 * Zero HTTP mocks. A separate node process boots startServer() with
 * WALNUT_CLOUD_MODE=1, its own OPEN_WALNUT_HOME, and WALNUT_SETUP_TOKEN set to
 * the pairing code the job generated (PR1 makes the box adopt a provisioned
 * token). A FakeDriver hands the job that box's `http://127.0.0.1:<port>` origin,
 * and the whole state machine runs against it: the claim is a real POST to the
 * real /api/v1/setup/claim, and verify-sync is a real git push over the box's
 * real /git/data smart-HTTP endpoint.
 *
 * Scheme hook: the job's `domain` accepts a full origin, so a bare hostname
 * still means https in production while a test can point at loopback http. That
 * is the ONLY test affordance — there is no test-only branch in the claim,
 * polling, or wiring code (see steps.ts resolveTarget).
 *
 * Asserted on the box, not on our own bookkeeping: its auth.json gains the
 * device, its setup-token file is deleted after the claim, our git remote holds
 * the issued token, and the pairing code is gone from the job state file.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

// ── The cloud box: a real server process in cloud mode ──────────────────────

interface CloudBox {
  proc: ChildProcess
  port: number
  origin: string
  home: string
  hubDir: string
  setupTokenFile: string
}

/**
 * Boot script for the box. Runs in its own process so WALNUT_CLOUD_MODE (read
 * at import time in constants.ts) actually takes effect, and prints the bound
 * port so the test never has to guess.
 */
const BOX_SCRIPT = `
import { startServer } from ${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))}
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
`

async function startCloudBox(pairingCode: string): Promise<CloudBox> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cloud-box-'))
  const home = path.join(base, 'home')
  const hubDir = path.join(base, 'git')
  await fsp.mkdir(home, { recursive: true })
  await fsp.mkdir(hubDir, { recursive: true })

  // The box reads its provisioned setup token from a file, exactly like a real
  // deployment (user-data writes /etc/walnut/setup-token). PR1 deletes it on claim.
  const setupTokenFile = path.join(base, 'setup-token')
  await fsp.writeFile(setupTokenFile, pairingCode, { mode: 0o600 })

  // Real bare hub repo, so /git/data can serve a real push. `--initial-branch=main`
  // mirrors scripts/cloud/setup.sh — a `master` default would make the hub's HEAD
  // disagree with the branch Walnut pushes.
  execFileSync('git', ['init', '--bare', '--initial-branch=main', path.join(hubDir, 'walnut-data.git')], { stdio: 'ignore' })

  const scriptPath = path.join(base, 'boot-box.mts')
  await fsp.writeFile(scriptPath, BOX_SCRIPT)

  const proc = spawn(TSX, [scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WALNUT_CLOUD_MODE: '1',
      OPEN_WALNUT_HOME: home,
      WALNUT_GIT_HUB_DIR: hubDir,
      WALNUT_SETUP_TOKEN_FILE: setupTokenFile,
      // Keep the box's own subsystems quiet: no vitest home-guard, no daemons.
      VITEST: '',
      VITEST_WORKER_ID: '',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const port = await new Promise<number>((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      reject(new Error(`cloud box did not report a port in 90s.\nstdout:\n${out}\nstderr:\n${err.slice(-4000)}`))
    }, 90_000)
    timer.unref?.()
    proc.stdout?.on('data', (b: Buffer) => {
      out += b.toString()
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    proc.stderr?.on('data', (b: Buffer) => {
      err += b.toString()
      if (process.env.DEBUG_BOX) process.stderr.write('[box] ' + b.toString())
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`cloud box exited early (code ${code}).\nstdout:\n${out}\nstderr:\n${err.slice(-4000)}`))
    })
  })

  return { proc, port, origin: `http://127.0.0.1:${port}`, home, hubDir, setupTokenFile }
}

async function stopCloudBox(box: CloudBox | null): Promise<void> {
  if (!box) return
  box.proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { box.proc.kill('SIGKILL'); resolve() }, 5_000)
    t.unref?.()
    box.proc.on('exit', () => { clearTimeout(t); resolve() })
  })
}

// ── The Mac side: real job engine over a real WALNUT_HOME ───────────────────

let macHome: string

/**
 * The Mac's modules are imported fresh per test with OPEN_WALNUT_HOME pointing
 * at a temp dir — no constants mock, because git-sync must operate on a real
 * repo on disk for verify-sync to mean anything.
 */
async function loadMacModules() {
  const [job, providers, gitSync] = await Promise.all([
    import('../../src/core/cloud-setup/job.js'),
    import('../../src/core/cloud-setup/providers/index.js'),
    import('../../src/integrations/git-sync.js'),
  ])
  const steps = await import('../../src/core/cloud-setup/steps.js')
  steps.CLOUD_SETUP_TIMINGS.serverIntervalMs = 200
  steps.CLOUD_SETUP_TIMINGS.serverBudgetMs = 60_000
  return { job, providers, gitSync }
}

const ORIGINAL_HOME = process.env.OPEN_WALNUT_HOME

beforeAll(() => {
  if (!fs.existsSync(TSX)) throw new Error(`tsx is missing at ${TSX} — run npm install`)
})

let box: CloudBox | null = null
let restoreDriver: (() => void) | null = null

beforeEach(async () => {
  macHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cloud-setup-mac-'))
  process.env.OPEN_WALNUT_HOME = macHome
  // Force a fresh module graph so constants.ts re-reads OPEN_WALNUT_HOME.
  const { resetModules } = await import('vitest').then((m) => ({ resetModules: m.vi.resetModules }))
  resetModules()
})

afterEach(async () => {
  restoreDriver?.()
  restoreDriver = null
  await stopCloudBox(box)
  box = null
  if (ORIGINAL_HOME === undefined) delete process.env.OPEN_WALNUT_HOME
  else process.env.OPEN_WALNUT_HOME = ORIGINAL_HOME
  await fsp.rm(macHome, { recursive: true, force: true }).catch(() => {})
})

afterAll(async () => {
  await stopCloudBox(box)
})

async function waitFor<T>(fn: () => Promise<T | null | undefined>, label: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('cloud setup against a real cloud-mode Walnut', () => {
  it('provisions, claims, wires git sync, and pushes for real', async () => {
    const mac = await loadMacModules()

    // The pairing code must exist before the box boots (a real VM gets it baked
    // into user-data), so mint the job first with a stalled driver, read the
    // code, boot the box with it, then let provisioning complete.
    let releaseProvision: ((origin: string) => void) | null = null
    let createVMCalls = 0
    const fakeDriver = {
      id: 'aws' as const,
      label: 'Fake Cloud Box Driver',
      costHint: 'free',
      detectCreds: async () => ({ available: true, detail: 'ok', needs: 'nothing' as const }),
      createVM: async (_params: unknown, onLog: (line: string) => void) => {
        createVMCalls++
        onLog('fake driver: waiting for the test box to come up')
        const origin = await new Promise<string>((resolve) => { releaseProvision = resolve })
        const url = new URL(origin)
        return { ip: url.hostname, instanceRef: 'i-test-box', domain: origin }
      },
      instructions: ({ userData }: { userData: string }) => ({ steps: ['fake'], userData }),
    }
    restoreDriver = mac.providers._setCloudProviderDriverForTesting('aws', fakeDriver)

    // Placeholder domain: the driver overwrites it with the box's real origin.
    await mac.job.startCloudSetupJob({
      provider: 'aws',
      domainMode: 'own-domain',
      domain: 'http://127.0.0.1:1',
    })
    const pairingCode = await waitFor(
      async () => (await mac.job.getCloudSetupJob())?.pairingCode,
      'the job to generate a pairing code',
    )
    expect(pairingCode).toMatch(/^[0-9a-f]{32}$/)

    // Boot the real box with that code, then unblock provisioning.
    box = await startCloudBox(pairingCode)
    await waitFor(async () => (releaseProvision ? true : null), 'the driver to reach createVM')
    releaseProvision!(box.origin)

    const done = await waitFor(async () => {
      const s = await mac.job.getCloudSetupJob()
      return s && (s.status === 'done' || s.status === 'failed') ? s : null
    }, 'the job to reach a terminal state')

    expect(done.status, `job failed: ${done.error ?? ''}\nlog:\n${done.logTail.join('\n')}`).toBe('done')
    expect(createVMCalls).toBe(1)

    // ── 1. The box really claimed: its auth.json has our device ──
    const auth = JSON.parse(await fsp.readFile(path.join(box.home, 'auth.json'), 'utf-8')) as {
      devices: Array<{ name: string; tokenHash: string }>
    }
    expect(auth.devices).toHaveLength(1)
    expect(auth.devices[0].name).toMatch(/^mac-/)
    // Only a hash is stored — never the plaintext token.
    expect(auth.devices[0].tokenHash).toMatch(/^[0-9a-f]{64}$/)

    // The spent provisioned token file is gone (PR1 unlinks it on claim).
    expect(fs.existsSync(box.setupTokenFile)).toBe(false)

    // The box now reports itself claimed on the public status endpoint.
    const status = await (await fetch(`${box.origin}/api/v1/setup/status`)).json() as { claimed: boolean }
    expect(status.claimed).toBe(true)

    // ── 2. initSync wrote a credentialed remote pointing at the box ──
    const creds = mac.gitSync.getCloudRemoteCredentials()
    expect(creds).not.toBeNull()
    expect(creds!.domain).toBe(`127.0.0.1:${box.port}`)
    expect(creds!.secure).toBe(false) // http on loopback in this test
    // The token in the remote is the one the box issued — prove it by hash.
    const crypto = await import('node:crypto')
    const hash = crypto.createHash('sha256').update(creds!.token, 'utf-8').digest('hex')
    expect(hash).toBe(auth.devices[0].tokenHash)

    // ── 3. verify-sync really pushed over the box's git smart-HTTP ──
    expect(done.steps['verify-sync'].status).toBe('done')
    // The Mac's commit is really in the box's bare hub repo — proof the push
    // traversed real auth + real git-http, not just that our code called sync().
    const hubRepo = path.join(box.hubDir, 'walnut-data.git')
    const hubHead = execFileSync('git', ['-C', hubRepo, 'log', '--oneline', '-1', 'main'], {
      encoding: 'utf-8',
    }).trim()
    expect(hubHead.length).toBeGreaterThan(0)
    const localHead = execFileSync('git', ['-C', macHome, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim()
    const hubMain = execFileSync('git', ['-C', hubRepo, 'rev-parse', 'main'], { encoding: 'utf-8' }).trim()
    expect(hubMain).toBe(localHead)

    // ── 4. The pairing code is gone from state and from disk ──
    expect(done.pairingCode).toBeUndefined()
    const stateRaw = await fsp.readFile(path.join(macHome, 'cloud-setup-job.json'), 'utf-8')
    expect(stateRaw).not.toContain(pairingCode)
    // Nor is the device token anywhere in the job record or its log.
    expect(stateRaw).not.toContain(creds!.token)
    expect(done.logTail.join('\n')).not.toContain(pairingCode)
    expect(done.logTail.join('\n')).not.toContain(creds!.token)

    // ── 5. Redaction holds on the way out ──
    expect(JSON.stringify(mac.job.redactCloudSetupJob(done))).not.toContain(pairingCode)
  }, 180_000)

  it('a second job against an already-claimed box fails with a clear message', async () => {
    const mac = await loadMacModules()

    // Boot a box that is already claimed by someone else: give it a token, claim
    // it with a device we then "forget".
    box = await startCloudBox('0'.repeat(32))
    const claim = await fetch(`${box.origin}/api/v1/setup/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupToken: '0'.repeat(32), deviceName: 'someone-elses-phone' }),
    })
    expect(claim.status).toBe(200)

    const origin = box.origin
    const fakeDriver = {
      id: 'aws' as const,
      label: 'Fake Claimed Box Driver',
      costHint: 'free',
      detectCreds: async () => ({ available: true, detail: 'ok', needs: 'nothing' as const }),
      createVM: async () => ({ ip: '127.0.0.1', instanceRef: 'i-test-box', domain: origin }),
      instructions: ({ userData }: { userData: string }) => ({ steps: ['fake'], userData }),
    }
    restoreDriver = mac.providers._setCloudProviderDriverForTesting('aws', fakeDriver)

    await mac.job.startCloudSetupJob({ provider: 'aws', domainMode: 'own-domain', domain: origin })
    const failed = await waitFor(async () => {
      const s = await mac.job.getCloudSetupJob()
      return s && (s.status === 'failed' || s.status === 'done') ? s : null
    }, 'a terminal state')

    expect(failed.status).toBe('failed')
    expect(failed.currentStep).toBe('await-server')
    expect(failed.error).toMatch(/already claimed by another device/)
    // No remote was wired to a box we do not own.
    expect(mac.gitSync.getCloudRemoteCredentials()).toBeNull()
  }, 180_000)
})
