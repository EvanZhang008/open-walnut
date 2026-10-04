/**
 * The Mac side of the cloud box credential (core/hosts/cloud-box-probe.ts and
 * integrations/cloud-bridge-config.ts): the status probe's deadline, "another
 * Mac is connected" as a standing answer that a Retry still re-asks, and the
 * recovery from a machine token the companion stopped accepting.
 *
 * Real modules over an isolated data dir whose `cloud` git remote points at a
 * small fake companion on loopback; the only thing injected is the tunnel
 * connect itself (openCloudTunnel's callback), which the real DaemonConnection
 * supplies in production.
 */
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cloud-box-probe'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { seedPrimaryPairing } from '../../helpers/cloud-box-replica.js'
import {
  CLOUD_BOX_HOST_ALIAS, CLOUD_BOX_OTHER_MAC_SENTENCE, cloudBoxHostDef, cloudBoxRefusal, getCloudBoxState,
  resetCloudBoxStateForTest, setCloudBoxState, TUNNEL_PROBE_HEADER,
} from '../../../src/core/hosts/cloud-box-host.js'
import {
  CREDENTIAL_AWAITS_RETRY, describeTunnelRefusal, openCloudTunnel, probeCapability, refreshCloudBoxHost, refusalBeforeDial, resolveCloudTunnelEndpoint,
  type CloudTunnelEndpoint,
} from '../../../src/core/hosts/cloud-box-probe.js'
import {
  allowNextRemint, getBridgeConfigForHost, getPrimaryMachineToken, machineTokenAwaitsRetry, resetMachineTokenStateForTest, revalidateBridgeToken,
} from '../../../src/integrations/cloud-bridge-config.js'
import { MACHINE_PROOF_HEADER } from '../../../src/core/machine-credentials.js'
import { classifyHostConnectError } from '../../../src/core/sessions/host-connect-hint.js'
import { hostStatusFrame } from '../../../src/core/hosts/host-connect-action.js'
import { hostActionsFor, hostProblemOf } from '../../../src/core/hosts/host-problem.js'

const CACHE = () => path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json')
const REJECTED = describeTunnelRefusal(401, 'unauthorized', 'a machine credential is required')

/** The companion, reduced to what the Mac asks of it. */
const fake = {
  status: { daemonTunnel: { enabled: true } } as unknown,
  mint: 'ok' as 'ok' | 'exists' | 'other_mac',
  del: 'ok' as 'ok' | 'other_mac',
  valid: new Set<string>(),
  mints: 0, deletes: 0, probes: 0, adopts: 0,
  proofs: [] as Array<string | undefined>,
}
let server: http.Server
let domain = ''

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const proof = req.headers[MACHINE_PROOF_HEADER]
    if (req.method === 'GET' && req.url === '/api/v1/status') return json(res, 200, fake.status)
    if (req.method === 'POST' && req.url === '/api/devices') {
      fake.mints++
      fake.proofs.push(typeof proof === 'string' ? proof : undefined)
      if (fake.mint === 'other_mac') return json(res, 409, { error: CLOUD_BOX_OTHER_MAC_SENTENCE, code: 'other_mac_connected' })
      if (fake.mint === 'exists') return json(res, 400, { error: 'Device "bridge-local" already exists' })
      const token = `minted-${fake.mints}`
      fake.valid.add(token)
      return json(res, 201, { name: 'bridge-local', token, createdAt: new Date().toISOString() })
    }
    if (req.method === 'DELETE' && req.url === '/api/devices/bridge-local') {
      fake.deletes++
      if (fake.del === 'other_mac') return json(res, 409, { error: CLOUD_BOX_OTHER_MAC_SENTENCE, code: 'other_mac_connected' })
      fake.mint = 'ok'
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url?.endsWith('/adopt')) { fake.adopts++; return json(res, 200, { ok: true, outcome: 'owned' }) }
    json(res, 404, { error: 'not found' })
  })
  server.on('upgrade', (req, socket) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    const ok = fake.valid.has(token)
    if (req.headers[TUNNEL_PROBE_HEADER]) fake.probes++
    socket.write(ok && req.headers[TUNNEL_PROBE_HEADER]
      ? 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'
      : 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  domain = `127.0.0.1:${(server.address() as net.AddressInfo).port}`
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, 'version: 1\nuser:\n  name: Tester\n')
  await seedPrimaryPairing(WALNUT_HOME, domain, { mac: 'mac-device-token', primaryMachine: 'unused' })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function setCache(tokens: Record<string, string>): Promise<void> {
  await fs.writeFile(CACHE(), JSON.stringify(tokens), { mode: 0o600 })
}
async function cache(): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(CACHE(), 'utf-8')) as Record<string, string>
}

beforeEach(async () => {
  resetCloudBoxStateForTest()
  resetMachineTokenStateForTest()
  Object.assign(fake, { status: { daemonTunnel: { enabled: true } }, mint: 'ok', del: 'ok', mints: 0, deletes: 0, probes: 0, adopts: 0, proofs: [] })
  fake.valid = new Set()
  await setCache({})
})

afterEach(() => resetCloudBoxStateForTest())

/** A tunnel connect that refuses dead tokens the way the replica does (401). */
function connectRecorder(): { connect: (e: CloudTunnelEndpoint) => Promise<void>; tokens: string[] } {
  const tokens: string[] = []
  return {
    tokens,
    connect: async (e) => {
      tokens.push(e.token)
      if (!fake.valid.has(e.token)) throw new Error(REJECTED)
    },
  }
}

describe('the status probe', () => {
  it('a companion that accepts TCP but never answers costs at most the probe deadline', async () => {
    const held: net.Socket[] = []
    const silent = net.createServer((s) => { held.push(s) })
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    try {
      const port = (silent.address() as net.AddressInfo).port
      const t0 = Date.now()
      expect(await probeCapability({ domain: `127.0.0.1:${port}`, token: 't', secure: false })).toBeNull()
      const took = Date.now() - t0
      expect(took).toBeGreaterThanOrEqual(4_500)
      expect(took).toBeLessThan(8_000)
    } finally {
      for (const s of held) s.destroy()
      await new Promise<void>((resolve) => silent.close(() => resolve()))
    }
  }, 12_000)

  it('"another Mac is connected" survives a status that says ready; a status that says off replaces it', async () => {
    setCloudBoxState({ domain, secure: false, capability: 'other_mac', checkedAt: 1 })
    await refreshCloudBoxHost()
    expect(getCloudBoxState()?.capability).toBe('other_mac')
    expect(cloudBoxRefusal()).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    // The dial still asks the companion: only a mint can tell that Mac let go.
    expect(refusalBeforeDial()).toBeNull()

    fake.status = { daemonTunnel: { enabled: false, reason: 'not_enabled' } }
    await refreshCloudBoxHost()
    expect(getCloudBoxState()?.capability).toBe('exec_off')
    expect(refusalBeforeDial()).toMatch(/session hosting turned off/)
  })
})

describe('a machine token the companion stopped accepting', () => {
  it('401: drops it, mints a new one once, and dials again with it', async () => {
    await setCache({ 'bridge-local': 'dead-token' })
    const rec = connectRecorder()
    await openCloudTunnel(rec.connect)
    expect(rec.tokens).toEqual(['dead-token', 'minted-1'])
    expect(fake.mints).toBe(1)
    expect((await cache())['bridge-local']).toBe('minted-1')
  })

  it('401 and the re-mint is refused because another Mac holds the companion: that sentence, as a standing answer', async () => {
    await setCache({ 'bridge-local': 'dead-token', 'bridge-devbox': 'devbox-token' })
    setCloudBoxState({ domain, secure: false, capability: 'ready', checkedAt: 1 })
    fake.mint = 'exists'
    fake.del = 'other_mac'
    const rec = connectRecorder()
    const err = await openCloudTunnel(rec.connect).then(() => null, (e: Error) => e)
    expect(err?.message).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    expect(rec.tokens).toEqual(['dead-token'])
    expect(fake.deletes).toBe(1)
    // No proof: bridge-local's own token is the only one that counts, and it was
    // the dead one (dropped); another host's token proves nothing.
    expect(fake.proofs).toEqual([undefined])
    expect(getCloudBoxState()?.capability).toBe('other_mac')
    expect(classifyHostConnectError(err!.message, domain).kind).toBe('cloud_other_mac')

    // The host card: that sentence, how to hand the companion over, and a Retry that re-asks.
    const frame = hostStatusFrame(CLOUD_BOX_HOST_ALIAS, cloudBoxHostDef(getCloudBoxState()!))
    const problem = hostProblemOf(frame)
    expect(problem).toMatchObject({ type: 'connect', kind: 'cloud_other_mac', headline: 'Another Mac is connected to this cloud companion' })
    expect(frame.error).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    expect(problem && 'hint' in problem ? problem.hint : '').toMatch(/disconnect that Mac on the companion: `walnut device list` names it, `walnut device revoke <name>` removes it/)
    expect(hostActionsFor(problem, { surface: 'banner' })).toEqual(['retry'])
  })

  it('no token yet and the companion serves another Mac: refused before any dial', async () => {
    fake.mint = 'other_mac'
    const err = await resolveCloudTunnelEndpoint().then(() => null, (e: Error) => e)
    expect(err?.message).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    expect(getCloudBoxState()).toBeNull() // not paired in state here; the refusal still names it
  })

  it('a refusal that is not a dead credential is never answered with a re-mint', async () => {
    await setCache({ 'bridge-local': 'live-token' })
    const connect = vi.fn(async () => { throw new Error('Cloud companion tunnel failed: HTTP 503 (starting the session daemon took longer than 20s)') })
    await expect(openCloudTunnel(connect)).rejects.toThrow(/HTTP 503/)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(fake.mints).toBe(0)
  })

  it('a companion that keeps refusing new tokens is not asked again within the window; the dead one is dropped all the same', async () => {
    await setCache({ 'bridge-local': 'dead-token' })
    const first = connectRecorder()
    await openCloudTunnel(first.connect)
    fake.valid.clear() // the new token dies too
    const again = connectRecorder()
    await expect(openCloudTunnel(again.connect)).rejects.toThrow(CREDENTIAL_AWAITS_RETRY)
    expect(again.tokens).toEqual(['minted-1'])
    expect(fake.mints).toBe(1)
    // Dropped, never dialled again, and the card says a Retry gets a new one.
    expect((await cache())['bridge-local']).toBeUndefined()
    expect(machineTokenAwaitsRetry('__local__')).toBe(true)
    expect(classifyHostConnectError(CREDENTIAL_AWAITS_RETRY, domain).kind).toBe('cloud_tunnel')
    const redial = connectRecorder()
    await expect(openCloudTunnel(redial.connect)).rejects.toThrow(CREDENTIAL_AWAITS_RETRY)
    expect(redial.tokens).toEqual([])
    expect(fake.mints).toBe(1)
    // A person's Retry (connectHostNow calls this for the Cloud row) mints at once.
    allowNextRemint('__local__')
    expect(machineTokenAwaitsRetry('__local__')).toBe(false)
    const retried = connectRecorder()
    await openCloudTunnel(retried.connect)
    expect(retried.tokens).toEqual(['minted-2'])
    expect(fake.mints).toBe(2)
    expect((await cache())['bridge-local']).toBe('minted-2')
  })

  it('the only proof offered is bridge-local\'s own token, for any host\'s mint', async () => {
    await setCache({ 'bridge-local': 'local-token' })
    expect(await getBridgeConfigForHost('devbox')).toMatchObject({ enabled: true, token: 'minted-1', hostAlias: 'devbox' })
    expect(fake.proofs).toEqual(['local-token'])
    // Holding only another host's token: no proof at all.
    await setCache({ 'bridge-devbox': 'devbox-token' })
    expect(await getPrimaryMachineToken({ domain, token: 'mac-device-token', secure: false })).toBe('minted-2')
    expect(fake.proofs).toEqual(['local-token', undefined])
  })
})

describe('the bridge token (the daemon dials /bridge with it)', () => {
  it('a token the companion refuses is re-minted, and a new push is asked for', async () => {
    await setCache({ 'bridge-local': 'dead-token' })
    expect(await revalidateBridgeToken('__local__')).toBe(true)
    expect(fake.probes).toBe(1)
    expect((await cache())['bridge-local']).toBe('minted-1')
  })

  it('a token the companion accepts is left alone (the network is the problem)', async () => {
    fake.valid.add('live-token')
    await setCache({ 'bridge-local': 'live-token' })
    expect(await revalidateBridgeToken('__local__')).toBe(false)
    expect(fake.mints).toBe(0)
    expect((await cache())['bridge-local']).toBe('live-token')
  })

  it('asks the companion at most once per window per host', async () => {
    fake.valid.add('live-token')
    await setCache({ 'bridge-local': 'live-token' })
    await revalidateBridgeToken('__local__')
    await revalidateBridgeToken('__local__')
    expect(fake.probes).toBe(1)
  })
})
