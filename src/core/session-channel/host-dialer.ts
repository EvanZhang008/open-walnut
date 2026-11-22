/**
 * The host's dialer of its leader's door (door-wire.ts): a module of the host's one Walnut service,
 * started by host-boot.ts, not daemon code. While the switch is on (switch.ts) and this machine
 * holds a door credential for its Walnut (host-credential-file.ts), it dials each door URL of the
 * credential in order, its token as `Authorization: Bearer` (never in the URL), and:
 *
 *   1. sends its hello (a fresh nonce), and waits for the door's welcome;
 *   2. checks the welcome: its Walnut is this host's, its proof is the HMAC of the verify key over
 *      this hello (constant time), and its standing (comparePermit) is not below the highest this
 *      host has seen (its fact log's, and the one the credential was issued with); who holds the
 *      write permission (`holder`) is not checked, only the pair; any mismatch closes the socket
 *      and the next try waits its backoff;
 *   3. only then attaches the session channel (HostChannel.attach) on the same socket, keeps the
 *      welcome's door list (and any later `doors` frame) under the same standing rule
 *      (updateHostCredentialDoors), and answers the leader's call frames on allowed prefixes only
 *      (door-calls.ts).
 *
 * Doors: any answer but 101 (a refusal, a 409, a 5xx, a timeout) moves on to the next door of the
 * list, round and round with the backoff (1 s doubling to 60 s, with jitter). Only a 401 means the
 * door does not know this token: that door is not dialed again with it; a credential the leader
 * issues again (over its own link) is dialed at once. A door URL must be wss://, or ws:// to a
 * loopback or private-network address.
 */
import crypto from 'node:crypto'
import { comparePermit, isChannelFrame, type HostChannel, type PermitPair } from './channel.js'
import { doorProofMatches, doorSecret, doorUrlRefusal, isDoorFrame, type DoorFrame } from './door-wire.js'
import { readHostCredential, updateHostCredentialDoors, type HostCredential } from './host-credential-file.js'
import { answerDoorCall } from './door-calls.js'
import type { HostSessionRoutes } from './host-routes.js'

export interface HostDialerOptions {
  walnutId: string
  /** This machine's stable id (machine-id.ts readMachineId). */
  machineId(): Promise<string>
  enabled(): Promise<boolean>
  channel(): HostChannel | null
  routes(): HostSessionRoutes | null
  /** The highest leader standing this host has seen (its fact log's permitPair). */
  seenPermit(): PermitPair
  /** The credential now (default: the file). */
  readCredential?(walnutId: string): Promise<HostCredential | null>
  /** Keep the leader's door list under the standing rule (default: the file's updateHostCredentialDoors). */
  keepDoors?(walnutId: string, doors: unknown, pair: PermitPair, seen: PermitPair): Promise<unknown>
  /** Delay before try `attempt` (default 1 s doubling to 60 s, jitter). */
  backoffMs?(attempt: number): number
  /** How long the door may take to welcome a hello. */
  welcomeTimeoutMs?: number
  /** How often the dialer looks again while it has nothing to dial (no credential, the switch off). */
  idleRecheckMs?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface HostDialer {
  /** A new credential was written (host-credential-file.ts onIssued): dial with it now. */
  poke(): void
  /** Is a door linked and welcomed now? */
  linked(): boolean
  stop(): void
}

export function dialerBackoff(attempt: number): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6))
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

type Outcome = 'welcomed' | 'unknown_token' | 'failed'

export function startHostDialer(o: HostDialerOptions): HostDialer {
  const say = o.log ?? (() => {})
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let current: { close(): void } | null = null
  let up = false
  /** Doors that answered 401 to a token: never dialed again with that token. */
  const unknownTo = new Map<string, Set<string>>()

  const wake = (ms: number): void => {
    if (stopped || timer) return
    timer = setTimeout(() => { timer = null; void turn() }, ms)
    timer.unref?.()
  }

  async function turn(): Promise<void> {
    if (stopped || running || current) return
    running = true
    try {
      const cred = await (o.readCredential ?? readHostCredential)(o.walnutId).catch(() => null)
      const on = cred ? await o.enabled().catch(() => false) : false
      const tokenKey = cred ? crypto.createHash('sha256').update(cred.token).digest('hex') : ''
      const doors = cred && on ? cred.doors.filter((u) => doorUrlRefusal(u) === null && !unknownTo.get(u)?.has(tokenKey)) : []
      if (!cred || !on || doors.length === 0) { wake(o.idleRecheckMs ?? 60_000); return }
      for (const url of doors) {
        if (stopped) return
        const outcome = await dialOnce(url, cred)
        if (outcome === 'welcomed') return
        if (outcome === 'unknown_token') {
          if (!unknownTo.has(url)) unknownTo.set(url, new Set())
          unknownTo.get(url)!.add(tokenKey)
          say('warn', 'host door: the leader\'s door does not know this host\'s credential; waiting for the leader to issue one', { door: url })
        }
      }
      wake((o.backoffMs ?? dialerBackoff)(attempt++))
    } finally {
      running = false
    }
  }

  /** One dial of `url`: resolves once the link is welcomed (it then runs until it closes), or failed. */
  async function dialOnce(url: string, cred: HostCredential): Promise<Outcome> {
    const { WebSocket } = await import('#ws')
    const machineId = await o.machineId()
    const nonce = doorSecret()
    return new Promise<Outcome>((resolve) => {
      let settled = false
      const done = (v: Outcome): void => { if (!settled) { settled = true; resolve(v) } }
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${cred.token}` }, handshakeTimeout: 20_000, maxPayload: 64 * 1024 * 1024 })
      const close = (why: string): void => { try { ws.close(1000, why.slice(0, 100)) } catch { ws.terminate() } }
      current = { close: () => close('stopping') }
      let welcomed = false
      let welcomePair: PermitPair | null = null
      let linkedAt = 0
      let handlers: ReturnType<HostChannel['attach']> | null = null
      const welcomeTimer = setTimeout(() => { if (!welcomed) { say('warn', 'host door: no welcome in time', { door: url }); close('no_welcome') } }, o.welcomeTimeoutMs ?? 15_000)
      welcomeTimer.unref?.()
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        say('warn', 'host door: the door refused the dial', { door: url, status })
        try { ws.terminate() } catch { /* gone */ }
        done(status === 401 ? 'unknown_token' : 'failed')
      })
      ws.on('error', (err) => { say('warn', 'host door: the dial failed', { door: url, error: err.message }) })
      ws.on('open', () => {
        const hello: DoorFrame = { ch: 'door', op: 'hello', v: 1, walnutId: o.walnutId, machineId, nonce }
        ws.send(JSON.stringify(hello))
      })
      ws.on('message', (raw) => {
        let frame: unknown
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (!welcomed) {
          if (!isDoorFrame(frame) || frame.op !== 'welcome') { close('expected_welcome'); return }
          const why = welcomeRefusal(frame, cred, machineId, nonce)
          if (why) { say('warn', 'host door: the door did not prove it is this host\'s leader; closed', { door: url, why }); close(why); return }
          const channel = o.channel()
          if (!channel) { close('no_channel'); return }
          welcomed = true
          welcomePair = { permitNumber: frame.permitNumber, epoch: frame.epoch }
          if (frame.doors !== undefined) keepDoors(frame.doors, welcomePair)
          linkedAt = Date.now()
          clearTimeout(welcomeTimer)
          up = true
          say('info', 'host door: linked to the leader\'s door', { door: url, holder: frame.holder })
          handlers = channel.attach({
            send: (f) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)) },
            close: (why) => close(why ?? 'closed'),
          })
          done('welcomed')
          return
        }
        if (isChannelFrame(frame)) { handlers?.onFrame(frame); return }
        if (isDoorFrame(frame) && frame.op === 'call') void answerCall(ws, frame)
        if (isDoorFrame(frame) && frame.op === 'doors' && welcomePair) keepDoors(frame.doors, welcomePair)
      })
      ws.on('close', () => {
        clearTimeout(welcomeTimer)
        handlers?.onClose()
        current = null
        if (welcomed) {
          up = false
          // A link that held a while starts the backoff over.
          if (Date.now() - linkedAt >= 60_000) attempt = 0
          say('info', 'host door: the link to the leader\'s door closed', { door: url })
          wake((o.backoffMs ?? dialerBackoff)(attempt++))
        }
        done('failed')
      })
    })
  }

  function welcomeRefusal(f: Extract<DoorFrame, { op: 'welcome' }>, cred: HostCredential, machineId: string, nonce: string): string | null {
    if (f.walnutId !== o.walnutId) return 'walnut_mismatch'
    const pair = { permitNumber: f.permitNumber, epoch: f.epoch }
    if (!Number.isSafeInteger(pair.permitNumber) || !Number.isSafeInteger(pair.epoch)) return 'bad_permit'
    if (!doorProofMatches(cred.verifyKey, { nonce, walnutId: o.walnutId, machineId, ...pair }, f.proof)) return 'bad_proof'
    const floor = comparePermit(o.seenPermit(), cred.permit) >= 0 ? o.seenPermit() : cred.permit
    if (comparePermit(pair, floor) < 0) return 'stale_permit'
    return null
  }

  /** The leader's door list, kept under the standing rule; a failure only says so (the next welcome tells it again). */
  function keepDoors(doors: unknown, pair: PermitPair): void {
    void (o.keepDoors ?? updateHostCredentialDoors)(o.walnutId, doors, pair, o.seenPermit()).then((out) => {
      if (out === 'updated') say('info', 'host door: the leader\'s door list changed; kept for the next dial', { doors: Array.isArray(doors) ? doors.length : 0 })
    }, (err: unknown) => say('warn', 'host door: keeping the leader\'s door list failed', { error: err instanceof Error ? err.message : String(err) }))
  }

  async function answerCall(ws: import('#ws').WebSocket, f: Extract<DoorFrame, { op: 'call' }>): Promise<void> {
    const r = await answerDoorCall(String(f.method), String(f.path), f.body, o.routes()).catch((err: unknown) => ({ status: 500, body: { ok: false, error: err instanceof Error ? err.message : String(err) } }))
    const reply: DoorFrame = { ch: 'door', op: 'reply', id: String(f.id), status: r.status, body: r.body }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply))
  }

  void turn()
  return {
    poke() {
      // A new token: every door is worth a try with it, at once.
      if (stopped || current) return
      if (timer) { clearTimeout(timer); timer = null }
      attempt = 0
      void turn()
    },
    linked: () => up,
    stop() {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      current?.close()
      current = null
    },
  }
}
