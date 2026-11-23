/**
 * The host's dialer of its leader's door (door-wire.ts): a module of the host's one Walnut service,
 * started by host-boot.ts, not daemon code. While the switch is on (switch.ts) and this machine
 * holds a door credential for its Walnut (host-credential-file.ts), it dials each door URL of the
 * credential in order (the upgrade carries no secret), and:
 *
 *   1. sends its hello (a fresh nonce), and waits for the door's welcome;
 *   2. checks the welcome: its Walnut is this host's, the proof for this host's key (by its keyId)
 *      is the HMAC of S over both nonces and the standing (constant time), and the standing
 *      (comparePermit) is not below the highest this host has seen (its fact log's, and the
 *      credential's); who holds the write permission (`holder`) is not checked, only the pair; any
 *      mismatch closes the socket and the next try waits its backoff;
 *   3. answers with its own proof (auth) and, once the door says it passed (`linked`), attaches the session channel (HostChannel.attach) on
 *      the same socket, keeps the door list the door tells it (a `doors` frame) under the same
 *      standing rule (updateHostCredentialDoors), and answers the leader's call frames on allowed
 *      prefixes only (door-calls.ts).
 *
 * Doors: anything but a link (an HTTP refusal such as 429 or 503, a timeout, a failed handshake)
 * moves on to the next door of the list, round and round with the backoff (1 s doubling to 60 s,
 * with jitter). Only the door's own close DOOR_CLOSE.unknown means it keeps no credential for this
 * machine: that door is then tried with this key only every DEAD_DOOR_RETRY_MS, and a credential
 * the leader issues again (over its own link) is dialed at once. A door URL must be wss://, or
 * ws:// to loopback (an ssh tunnel).
 */
import { comparePermit, isChannelFrame, type HostChannel, type PermitPair } from './channel.js'
import { DOOR_CLOSE, doorKeyId, doorSecret, doorUrlRefusal, hostDoorProof, isDoorFrame, leaderDoorProof, proofsEqual, type DoorFrame } from './door-wire.js'
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
  /** How long a door that keeps no credential for this machine waits before it is tried again (DEAD_DOOR_RETRY_MS). */
  deadDoorRetryMs?: number
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

type Outcome = 'welcomed' | 'unknown' | 'failed'

/** A door that said it keeps no credential for this machine is tried again with the same key this often. */
export const DEAD_DOOR_RETRY_MS = 10 * 60_000

export function startHostDialer(o: HostDialerOptions): HostDialer {
  const say = o.log ?? (() => {})
  let stopped = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let current: { close(): void } | null = null
  let up = false
  /** Doors that said they keep no credential for this machine: the key they said it to, and when to try again. */
  const deadUntil = new Map<string, { keyId: string; at: number }>()
  const now = (): number => Date.now()

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
      const keyId = cred ? doorKeyId(cred.verifyKey) : ''
      const dead = (u: string): boolean => { const x = deadUntil.get(u); return !!x && x.keyId === keyId && x.at > now() }
      const valid = cred && on ? cred.doors.filter((u) => doorUrlRefusal(u) === null) : []
      const doors = valid.filter((u) => !dead(u))
      if (!cred || !on || doors.length === 0) {
        // Every door said it keeps no credential for this key: look again when the first may.
        const next = valid.length > 0 ? Math.min(...valid.map((u) => deadUntil.get(u)!.at)) - now() : Infinity
        wake(Math.max(1_000, Math.min(o.idleRecheckMs ?? 60_000, next)))
        return
      }
      for (const url of doors) {
        if (stopped) return
        const outcome = await dialOnce(url, cred)
        if (outcome === 'welcomed') return
        if (outcome === 'unknown') {
          deadUntil.set(url, { keyId, at: now() + (o.deadDoorRetryMs ?? DEAD_DOOR_RETRY_MS) })
          say('warn', 'host door: the leader\'s door keeps no credential for this machine; tried again in a while, or at once when the leader issues one', { door: url })
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
      // No secret on the upgrade: both sides prove themselves in frames (door-wire.ts).
      const ws = new WebSocket(url, { handshakeTimeout: 20_000, maxPayload: 64 * 1024 * 1024 })
      const close = (why: string): void => { try { ws.close(1000, why.slice(0, 100)) } catch { ws.terminate() } }
      current = { close: () => close('stopping') }
      let welcomed = false
      let linked = false
      let holder = ''
      let welcomePair: PermitPair | null = null
      let linkedAt = 0
      let handlers: ReturnType<HostChannel['attach']> | null = null
      const welcomeTimer = setTimeout(() => { if (!linked) { say('warn', 'host door: no welcome in time', { door: url }); close('no_welcome') } }, o.welcomeTimeoutMs ?? 15_000)
      welcomeTimer.unref?.()
      ws.on('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0
        say('warn', 'host door: the door refused the dial', { door: url, status })
        try { ws.terminate() } catch { /* gone */ }
        // A rate limit (429), a door that cannot check now (503), anything else: the next door, with the backoff.
        done('failed')
      })
      ws.on('error', (err) => { say('warn', 'host door: the dial failed', { door: url, error: err.message }) })
      ws.on('open', () => {
        const hello: DoorFrame = { ch: 'door', op: 'hello', v: 2, walnutId: o.walnutId, machineId, nonce }
        ws.send(JSON.stringify(hello))
      })
      ws.on('message', (raw) => {
        let frame: unknown
        try { frame = JSON.parse(String(raw)) } catch { return }
        if (!welcomed) {
          if (!isDoorFrame(frame) || frame.op !== 'welcome') { close('expected_welcome'); return }
          const why = welcomeRefusal(frame, cred, machineId, nonce)
          if (why) { say('warn', 'host door: the door did not prove it is this host\'s leader; closed', { door: url, why }); close(why); return }
          if (!o.channel()) { close('no_channel'); return }
          welcomed = true
          welcomePair = { permitNumber: frame.permitNumber, epoch: frame.epoch }
          const auth: DoorFrame = { ch: 'door', op: 'auth', keyId: doorKeyId(cred.verifyKey), proof: hostDoorProof(cred.verifyKey, { nonceH: nonce, nonceD: frame.nonce, walnutId: o.walnutId, machineId }) }
          ws.send(JSON.stringify(auth))
          holder = frame.holder
          return
        }
        if (!linked) {
          // Nothing but the auth goes before the door said it passed (its pre-auth cap counts raw bytes).
          if (!isDoorFrame(frame) || frame.op !== 'linked') { close('expected_linked'); return }
          const channel = o.channel()
          if (!channel) { close('no_channel'); return }
          linked = true
          linkedAt = Date.now()
          clearTimeout(welcomeTimer)
          up = true
          say('info', 'host door: linked to the leader\'s door', { door: url, holder })
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
      ws.on('close', (code) => {
        clearTimeout(welcomeTimer)
        handlers?.onClose()
        current = null
        if (linked) {
          up = false
          // A link that held a while starts the backoff over.
          if (Date.now() - linkedAt >= 60_000) attempt = 0
          say('info', 'host door: the link to the leader\'s door closed', { door: url })
          wake((o.backoffMs ?? dialerBackoff)(attempt++))
        }
        done(!welcomed && code === DOOR_CLOSE.unknown ? 'unknown' : 'failed')
      })
    })
  }

  function welcomeRefusal(f: Extract<DoorFrame, { op: 'welcome' }>, cred: HostCredential, machineId: string, nonce: string): string | null {
    if (f.walnutId !== o.walnutId) return 'walnut_mismatch'
    const pair = { permitNumber: f.permitNumber, epoch: f.epoch }
    if (!Number.isSafeInteger(pair.permitNumber) || !Number.isSafeInteger(pair.epoch)) return 'bad_permit'
    if (typeof f.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(f.nonce) || !Array.isArray(f.proofs)) return 'bad_welcome'
    // The proof for this host's own key (the door sends one per key it still takes).
    const mine = f.proofs.find((p) => p && p.keyId === doorKeyId(cred.verifyKey))
    const expected = leaderDoorProof(cred.verifyKey, { nonceH: nonce, nonceD: f.nonce, walnutId: o.walnutId, machineId, ...pair })
    if (!mine || !proofsEqual(expected, mine.proof)) return 'bad_proof'
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
