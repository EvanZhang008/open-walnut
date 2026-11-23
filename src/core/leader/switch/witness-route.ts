/**
 * A witness of the write permission, served by a machine's Walnut service
 * (docs/reference/leader-switch.md, "Witnesses on other machines"). The service of a host
 * answers `POST /host-api/witness/request` and `/host-api/witness/setup` on its leader door
 * (replica/leader-door.ts), the door only the host daemon's relayed streams reach. The record
 * is on this machine's disk, outside every data home (machine-id.ts witnessRoot, the home
 * manifest's `state.leader-witness`), and is served by the same code as a local witness
 * (local-witnesses.ts serveLocalWitness): one witness record file, one lock, one PermitWitness.
 * The same record is served by the machine's direct door when it has one (witness-door.ts) and
 * opened by a caller on this machine itself (witness-transport.ts, way a): every way reaches the
 * one file under its lock. Beside it is the witness's own key (`witness-key`, from the setup).
 *
 * A machine serves a witness for a Walnut only when ALL hold, and answers 404 (the answer of a
 * path it does not have, so nothing tells a caller from today's service) otherwise:
 *   - the experiment `switchable_leader` is on (the door checks it before it loads this file);
 *   - an operator set the witness up (`setup`, from `walnut leader witnesses init`): a witness
 *     that lost its disk never starts over by itself (permit/store.ts), so a request alone
 *     never makes a record.
 * and it answers only a caller that belongs to this Walnut (authorizeWitnessCaller).
 *
 * One witness id per Walnut per machine: two ids on one machine would be one witness counted twice.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../permit/types.js'
import { withFileLock } from '../../../utils/file-lock.js'
import { prepareLocalJoiningWitness, serveLocalWitness, setUpLocalWitnesses, WITNESS_KEY_FILE, witnessDirEmpty } from './local-witnesses.js'
import {
  NO_WITNESS_HERE_CODE, WITNESS_REQUEST_PATH, WITNESS_SETUP_PATH, parseWitnessCall, parseWitnessSetup, setupAllowed, type WitnessAnswer, type WitnessSetup,
} from './witness-wire.js'
import { PROOF_SECRET_RE, proofsEqual } from '../../../utils/hmac-proof.js'

/** The largest body read: a list change carries every op entry. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * What the door knows about who is calling. Today the only caller that can reach the route is
 * the host daemon's relayed stream from the leader of the Walnut the service follows
 * (`leader-door`); the Walnut id in the body is checked against the one this service follows.
 *
 * TODO (C5a, host-dialed door): a `host-door` caller is authorized by the SOCKET it arrives on, a socket that
 * passed 5a's handshake (hello v2, welcome, auth: both sides prove the verify key S by challenge-response; the
 * credential record is {machineId, walnutId, hostKey, verifyKey S}). The door then passes the record's own
 * machine and Walnut ids as `verifiedWalnutId`, and the body's claim is not looked at. There is no per-request
 * token and none is to be made: a token on each call would be a replayable credential. Only the body of
 * authorizeWitnessCaller changes when that lands.
 */
export type WitnessCaller =
  | { via: 'leader-door'; claimedWalnutId: string }
  | { via: 'host-door'; machineId: string; verifiedWalnutId: string }

export type CallerCheck = { ok: true } | { ok: false; status: 403 | 503; error: string }

/**
 * THE check that a caller belongs to this Walnut: every witness request and setup passes it.
 * `own`: the Walnut this machine's service follows (null: it does not know, so it answers no one).
 */
export function authorizeWitnessCaller(caller: WitnessCaller, own: string | null): CallerCheck {
  if (!own) return { ok: false, status: 503, error: 'no_walnut_id' }
  const walnutId = caller.via === 'host-door' ? caller.verifiedWalnutId : caller.claimedWalnutId
  if (walnutId !== own) return { ok: false, status: 403, error: 'not_this_walnut' }
  return { ok: true }
}

export interface WitnessRouteDeps {
  /** The Walnut this service follows (WALNUT_WALNUT_ID on a host's service). */
  walnutId(): string | null
  /** Where this machine keeps witness records (machine-id.ts witnessRoot). */
  root: string
  params?: PermitParams
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

export interface WitnessResponse { status: number; body: WitnessAnswer }

const NOT_FOUND: WitnessResponse = { status: 404, body: { ok: false, error: 'not_found' } }
/** The witness looked at its own directory and holds nothing (no record, no key): what a setup's evidence calls `absent`. */
const NO_WITNESS_HERE: WitnessResponse = { status: 404, body: { ok: false, error: NO_WITNESS_HERE_CODE } }

export function witnessDir(root: string, walnutId: string, witness: string): string {
  return path.join(root, walnutId, witness)
}

/** The witness's own key beside its record (0600 in its 0700 dir): what its direct door checks (witness-door.ts). */
const KEY_FILE = WITNESS_KEY_FILE

/** The key kept for a witness here, or null: none set up (a witness set up before keys existed has none). */
export function readWitnessKey(dir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(dir, KEY_FILE), 'utf8').trim()
    return PROOF_SECRET_RE.test(text) ? text : null
  } catch { return null }
}

/**
 * Set a witness of this machine up, once (THE setup, whichever way it came: the leader door's route,
 * the companion's setup route, `walnut leader witnesses init` on this machine itself): its record with
 * the first list, and its key when one is given; or, with `join`, as a joining witness (it takes nothing until
 * the leader's list change names it).
 *   - Only from nothing (a first setup, not a join): the setup carries what the caller saw at every OTHER witness, and is refused
 *     (409) unless none held a record (witness-wire.ts setupAllowed; a witness that lost its disk never
 *     starts over beside records that still exist).
 *   - One witness id per Walnut per machine (409 another_witness_here), checked and made under one
 *     lock, so two setups at once make one.
 *   - A record that is there is kept; a key that is there is never replaced (409 key_differs: a new
 *     key is a new witness's, set up anew by an operator).
 */
export async function setUpMachineWitness(root: string, setup: WitnessSetup, log?: WitnessRouteDeps['log']): Promise<WitnessResponse> {
  const allowed = setupAllowed(setup)
  if (!allowed.ok) return { status: 409, body: { ok: false, error: allowed.error } }
  const walnutDir = path.join(root, setup.walnutId)
  fs.mkdirSync(walnutDir, { recursive: true, mode: 0o700 })
  try {
    return await withFileLock(path.join(walnutDir, '.setup'), async (): Promise<WitnessResponse> => {
      let others: string[] = []
      try { others = fs.readdirSync(walnutDir).filter((n) => n !== setup.witness && !n.startsWith('.')) } catch { /* none yet */ }
      if (others.length) return { status: 409, body: { ok: false, error: 'another_witness_here' } }
      const dir = witnessDir(root, setup.walnutId, setup.witness)
      const held = readWitnessKey(dir)
      if (setup.key && held && !proofsEqual(held, setup.key)) return { status: 409, body: { ok: false, error: 'key_differs' } }
      const made = setup.join !== undefined
        ? prepareLocalJoiningWitness({ id: setup.witness, dir }, setup.join).made
        : setUpLocalWitnesses([{ id: setup.witness, dir }], setup.list).made.length > 0
      if (setup.key && !held) writeKeyFile(dir, setup.key)
      log?.('info', 'witness route: set up', { witness: setup.witness, made, joining: setup.join !== undefined, keyed: !!(setup.key || held) })
      return { status: 200, body: { ok: true, made } }
    }, { timeoutMs: 5_000 })
  } catch (err) {
    log?.('warn', 'witness route: a setup could not be done', { witness: setup.witness, error: err instanceof Error ? err.message : String(err) })
    return { status: 503, body: { ok: false, error: 'busy' } }
  }
}

function writeKeyFile(dir: string, key: string): void {
  const file = path.join(dir, KEY_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const fd = fs.openSync(tmp, 'w', 0o600)
  try { fs.writeSync(fd, `${key}\n`); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(tmp, file)
}

/** Serve one call of the witness route. `path`: the request path; `body`: its parsed JSON. */
export async function serveWitnessCall(pathname: string, body: unknown, caller: (claimed: string) => WitnessCaller, deps: WitnessRouteDeps): Promise<WitnessResponse> {
  if (pathname === WITNESS_REQUEST_PATH) {
    const call = parseWitnessCall(body)
    if (!call) return { status: 400, body: { ok: false, error: 'bad_request' } }
    const auth = authorizeWitnessCaller(caller(call.walnutId), deps.walnutId())
    if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } }
    // No record here: NO_WITNESS_HERE only when the directory holds nothing of a witness (no record, no key), the
    // one answer a setup's evidence may count as `absent`; a key with no record is a 404 like a path this service
    // does not have, which counts as not reached.
    const place = { id: call.witness, dir: witnessDir(deps.root, call.walnutId, call.witness) }
    try {
      const reply = await serveLocalWitness(place, call.request, deps.params ?? DEFAULT_PERMIT_PARAMS)
      if (!reply) return witnessDirEmpty(place.dir) ? NO_WITNESS_HERE : NOT_FOUND
      return { status: 200, body: { ok: true, reply, ...(call.round !== undefined ? { round: call.round } : {}) } }
    } catch (err) {
      deps.log?.('warn', 'witness route: a request could not be served', { witness: call.witness, error: err instanceof Error ? err.message : String(err) })
      return { status: 503, body: { ok: false, error: 'busy' } }
    }
  }
  if (pathname === WITNESS_SETUP_PATH) {
    const setup = parseWitnessSetup(body)
    if (!setup) return { status: 400, body: { ok: false, error: 'bad_request' } }
    const auth = authorizeWitnessCaller(caller(setup.walnutId), deps.walnutId())
    if (!auth.ok) return { status: auth.status, body: { ok: false, error: auth.error } }
    return setUpMachineWitness(deps.root, setup, deps.log)
  }
  return NOT_FOUND
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null) } catch { reject(Object.assign(new Error('the body is not JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/** The HTTP shell of the route, for the leader door: POST only, JSON in and out. */
export async function handleWitnessHttp(req: IncomingMessage, res: ServerResponse, deps: WitnessRouteDeps): Promise<void> {
  const send = (r: WitnessResponse): void => {
    const text = JSON.stringify(r.body)
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  const pathname = new URL(req.url ?? '/', 'http://leader-door').pathname
  if (req.method !== 'POST') return send(NOT_FOUND)
  let body: unknown
  try { body = await readJson(req) } catch (err) {
    const status = (err as { status?: number }).status ?? 400
    return send({ status, body: { ok: false, error: status === 413 ? 'too_large' : 'bad_request' } })
  }
  send(await serveWitnessCall(pathname, body, (claimedWalnutId) => ({ via: 'leader-door', claimedWalnutId }), deps))
}
