/**
 * Moving a session's judging to its host weakens no proof on the permission path (plan section 8):
 *
 *   - the leader can only answer or settle a prompt, never make one: HOST_CALL_ALLOWLIST names no
 *     member that takes CLI output or creates a pending request, and the call route checks every
 *     answer against the session's own prompts before it calls the session (an ACP one too);
 *   - the kernel's word on a local caller is read where it was: the daemon's gateway reads the
 *     socket's peer for an approval, the host's call entry still refuses one, and no module of the
 *     session channel reads or carries a caller proof;
 *   - `/host-api/*` is served only on the leader door, which only streams from the leader's own
 *     link reach; the public app of a host replica answers 404 there, however the path is spelled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { HOST_CALL_ALLOWLIST } from '../../../src/core/session-channel/host-calls.js'
import { createHostSessionRoutes, type HostSessionRoutes } from '../../../src/core/session-channel/host-routes.js'
import { StartBundles } from '../../../src/core/session-channel/host-port.js'
import { checkPermissionAnswer, PERMISSION_NOT_PENDING } from '../../../src/core/session-channel/host-permission.js'
import { createLeaderDoor, isLeaderDoorPath, replicaPublicRefusal, type LeaderDoor } from '../../../src/replica/leader-door.js'
import { CALLER_PROOF_OPS } from '../../../src/providers/gateway-core.js'

const ROOT = path.resolve(__dirname, '../../..')
const src = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the leader answers prompts, it never makes one', () => {
  it('the members the leader may call that touch a prompt only answer or settle one', () => {
    const touching = Object.entries(HOST_CALL_ALLOWLIST).flatMap(([target, members]) =>
      (members as readonly string[]).filter((m) => /PermissionRequest/.test(m)).map((m) => `${target}.${m}`))
    expect(touching.sort()).toEqual(['acp.resolvePermissionRequest', 'session.forceSettlePermissionRequests', 'session.resolvePermissionRequest'])
    // Nothing that takes the CLI's output or makes a prompt (handleStreamLine, _awaitUserDecision ...).
    for (const members of Object.values(HOST_CALL_ALLOWLIST)) {
      for (const m of members) expect(m, m).not.toMatch(/^_|^(handle|on|ingest)[A-Z]|Stream|Await|Decision|ControlRequest/)
    }
  })

  it('the call route checks an answer before anything reaches the session', () => {
    const routes = src('src/core/session-channel/host-routes.ts')
    const call = routes.slice(routes.indexOf('async function call('), routes.indexOf('async function serve('))
    const check = call.indexOf('checkPermissionAnswer(')
    expect(check).toBeGreaterThan(call.indexOf("error: 'no_live_session'"))
    for (const after of ["body.member === 'bashCallMatchingOp'", "body.member === 'prepareOutbound'", 'const fn = target[body.member]']) {
      expect(call.indexOf(after), after).toBeGreaterThan(check)
    }
  })

  it('a member that is not an answer passes; an answer is checked against the session\'s own list', () => {
    const holder = { getPendingPermissionRequests: () => [{ requestId: 'r1' }] }
    expect(checkPermissionAnswer('s', 'getUsage', [], {})).toEqual({ ok: true })
    expect(checkPermissionAnswer('s', 'resolvePermissionRequest', ['r1', true], holder)).toEqual({ ok: true })
    expect(checkPermissionAnswer('s', 'resolvePermissionRequest', ['r2', true], holder)).toEqual({ ok: false, status: 200, error: PERMISSION_NOT_PENDING })
    // A session that cannot list its prompts, or one whose list throws, holds none.
    expect(checkPermissionAnswer('s', 'resolvePermissionRequest', ['r1', true], {})).toMatchObject({ ok: false, error: PERMISSION_NOT_PENDING })
    expect(checkPermissionAnswer('s', 'resolvePermissionRequest', ['r1', true], { getPendingPermissionRequests: () => { throw new Error('gone') } })).toMatchObject({ ok: false, error: PERMISSION_NOT_PENDING })
    expect(checkPermissionAnswer('s', 'resolvePermissionRequest', [42, true], holder)).toEqual({ ok: false, status: 400, error: 'requestId is required' })
  })
})

describe('an ACP session\'s prompt through the call route', () => {
  let dir = ''
  let routes: HostSessionRoutes
  let door: LeaderDoor
  let server: net.Server
  afterEach(async () => {
    routes.close()
    await door.close()
    await new Promise<void>((r) => server.close(() => r()))
    await fsp.rm(dir, { recursive: true, force: true })
  })

  it('answers the request it holds, refuses another without asking its worker', async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-permission-acp-'))
    const resolve = vi.fn(async () => true)
    const acp = { getPendingPermissionRequests: () => [{ requestId: 'acp-1' }], resolvePermissionRequest: resolve }
    routes = createHostSessionRoutes({
      enabled: async () => true,
      runner: async () => ({ startSession: async () => { throw new Error('none') }, findSessionByClaudeId: () => undefined, findAcpSession: (sid: string) => (sid === 'sid-acp' ? acp : undefined) }),
      bundles: new StartBundles(), channel: () => null, emit: () => {}, enqueue: async () => {}, spillDir: path.join(dir, 'p'),
    })
    door = createLeaderDoor({ devices: {} as never, sessions: () => routes })
    server = net.createServer((sock) => door.accept(sock))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as net.AddressInfo).port
    const post = async (requestId: string) => {
      const r = await fetch(`http://127.0.0.1:${port}/host-api/sessions/call`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ sid: 'sid-acp', target: 'acp', member: 'resolvePermissionRequest', args: [requestId, false] }) })
      return r.json()
    }
    expect(await post('acp-other')).toEqual({ ok: false, error: PERMISSION_NOT_PENDING })
    expect(resolve).not.toHaveBeenCalled()
    expect(await post('acp-1')).toEqual({ ok: true, value: true })
    expect(resolve).toHaveBeenCalledWith('acp-1', false)
  })
})

describe('the kernel\'s word on a local caller stays where it is read', () => {
  it('the daemon reads the gateway socket\'s peer for an approval, and the host\'s call entry still sends one there', () => {
    expect([...CALLER_PROOF_OPS].sort()).toEqual(['approval_consume', 'approval_request'])
    // The peer of the socket the line came on, read while the caller still holds it.
    expect(src('src/providers/daemon-standalone.ts')).toMatch(/gatewayCallerProof\(socketPeerPid\([\w?.]*fd\), callerSid, /)
    const entry = src('src/replica/host-call-entry.ts')
    expect(entry).toMatch(/if \(wantsCallerProof\(parsed\.request\.op, parsed\.request\.args\)\) \{\s*return unavailable\(res, 503, 'caller_proof_on_socket'/)
  })

  it('no module of the session channel reads a socket\'s peer or carries a caller proof', () => {
    const dirRel = 'src/core/session-channel'
    const files = [...fs.readdirSync(path.join(ROOT, dirRel)).filter((f) => f.endsWith('.ts')).map((f) => `${dirRel}/${f}`), 'src/providers/remote-judged-session.ts', 'src/providers/host-judged-runner.ts']
    for (const f of files) {
      // The code, not its comments (a module may say where the proof is read).
      const text = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(text, f).not.toMatch(/socket-peer-pid|socketPeerPid|callerProof|gatewayCallerProof|CALLER_PROOF/)
    }
  })
})

describe('/host-api lives on the leader door only', () => {
  it('the public app of a host replica answers 404 for it, however the path is spelled', () => {
    for (const p of ['/host-api/sessions/call', '/HOST-API/sessions/call', '//host-api//sessions/call', '/host-api%2Fsessions%2Fcall', '/host-api', '/host-api/session-channel']) {
      expect(isLeaderDoorPath(p), p).toBe(true)
      let status = 0
      const next = vi.fn()
      replicaPublicRefusal({ path: p } as never, { writeHead: (s: number) => { status = s }, end: () => {} } as never, next)
      expect(next, p).not.toHaveBeenCalled()
      expect(status, p).toBe(404)
    }
  })

  it('the routes are mounted only on the leader door, which only the leader\'s streams reach', () => {
    const server = src('src/web/server.ts')
    // The host's session routes go to the door and nowhere else.
    expect(server.match(/hostSessionsRoutes\?\.\(\)/g)).toHaveLength(1)
    const door = server.slice(server.indexOf('hostReplicaDoor = createLeaderDoor({'))
    expect(door.slice(0, door.indexOf('})'))).toContain('sessions: () => hostSessionsRoutes?.() ?? null')
    // The public app refuses the door's paths before any parser or route.
    const refusal = server.indexOf('app.use(replicaPublicRefusal)')
    expect(refusal).toBeGreaterThan(0)
    expect(server.indexOf('app.use(cors(')).toBeGreaterThan(refusal)
    // The door is fed only by the streams the daemon accepted from the leader (`primary`).
    expect(server.match(/hostReplicaDoor\?\.accept\(/g)).toHaveLength(1)
    expect(server).toContain('acceptFromLeader: (stream) => hostReplicaDoor?.accept(stream)')
    expect(src('src/replica/front.ts')).toContain("accept: (info) => (info.from === 'primary' ? (stream: Duplex) => opts.acceptFromLeader(stream) : null)")
  })
})
