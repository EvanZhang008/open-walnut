/**
 * Way b to a witness, the caller's half: its direct door (witness-door.ts) at the witness's `url`,
 * proven with the witness's own `key` (both from leader_switch.witnesses, so a candidate that holds
 * a full standby copy holds them too). No leader link, no host credential: any process of this
 * Walnut that has the config reaches the witness this way.
 *
 * One call is two posts (a challenge for this call's digest, then the call with the proof), and the
 * answer counts only when the witness proved the same key over it: anything else is no answer,
 * which the transport and the permit core are built for (witness-transport.ts).
 *
 * Callback style, so the model check runs it on its simulated network (tests/core/leader/permit/sim.ts).
 */
import { hmacProof, proofSecret, proofsEqual, sha256Hex } from '../../../utils/hmac-proof.js'
import type { RemoteCall, RemoteCallResult } from './witness-transport.js'
import {
  DOOR_NONCE_RE, WITNESS_DOOR_CHALLENGE, WITNESS_DOOR_MAX_CALL, WITNESS_DOOR_REQUEST, WITNESS_NOTE_PATH, WITNESS_REQUEST_PATH, doorCallerProofText, doorWitnessProofText,
  type WitnessEvidence, type WitnessSetup,
} from './witness-wire.js'

export interface DoorPostResult { status: number; json: unknown }
/** One POST of a JSON body to `url`; `done(null)` when nothing came back. Returns how to abandon it. */
export type DoorPost = (url: string, body: unknown, done: (r: DoorPostResult | null) => void) => void | (() => void)

/** The answer of a door whose reply proof does not hold (not the witness, or not its key): no answer the transport may count. */
export const BAD_WITNESS_PROOF = 'bad_witness_proof'

/** A POST over fetch (keep-alive: a renew's two posts ride one TLS connection). */
export function fetchDoorPost(timeoutMs: number): DoorPost {
  return (url, body, done) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    timer.unref?.()
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
      .then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) as unknown }))
      .then((r) => { clearTimeout(timer); done(r) }, () => { clearTimeout(timer); done(null) })
    return () => { clearTimeout(timer); ctl.abort() }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * The RemoteCall of way b. `post`: how a body reaches the door (default fetch). `walnutId`: this
 * Walnut's id when the call does not carry it (the production transport leaves it to the call).
 */
export function directWitnessCall(o: { post?: DoorPost; timeoutMs?: number; walnutId?: () => Promise<string> } = {}): RemoteCall {
  const post = o.post ?? fetchDoorPost(o.timeoutMs ?? 15_000)
  return (place, path, body, done) => {
    // Only permit requests and switch notes ride the direct door; a setup comes over an authenticated link (its key is in it).
    const kind = path === WITNESS_REQUEST_PATH && 'request' in body ? 'request' : path === WITNESS_NOTE_PATH && 'note' in body ? 'note' : null
    if (!kind || !place.url || !place.key) { done(null); return }
    const key = place.key
    const url = place.url
    let gone = false
    let abandon: (() => void) | void = undefined
    const finish = (r: RemoteCallResult | null): void => { if (!gone) { gone = true; done(r) } }
    const go = (walnutId: string): void => {
      if (gone) return
      const call = { ...body, walnutId }
      const text = JSON.stringify(call)
      // The door refuses a longer call unread: say so here, without a round trip.
      if (text.length > WITNESS_DOOR_MAX_CALL) { finish({ status: 413, body: { ok: false, error: 'too_large' } }); return }
      const digest = sha256Hex(text)
      let challenged = false
      // The caller's own nonce, in both proofs: a reply recorded for an earlier call never passes for this one.
      const cnonce = proofSecret()
      abandon = post(`${url}${WITNESS_DOOR_CHALLENGE}`, { v: 1, walnutId, witness: place.id, digest, cnonce }, (ch) => {
        // One request per call: a second answer to the challenge (a network that repeats) is dropped.
        if (gone || challenged) return
        challenged = true
        const nonce = isObj(ch?.json) ? ch.json.nonce : undefined
        if (!ch || ch.status !== 200 || typeof nonce !== 'string' || !DOOR_NONCE_RE.test(nonce)) { finish(ch ? { status: ch.status === 200 ? 502 : ch.status, body: ch.json } : null); return }
        const fields = { walnutId, witness: place.id, nonce, cnonce, digest }
        abandon = post(`${url}${WITNESS_DOOR_REQUEST}`, { v: 1, walnutId, witness: place.id, nonce, cnonce, proof: hmacProof(key, doorCallerProofText(fields)), call: text }, (r) => {
          if (gone) return
          if (!r) { finish(null); return }
          if (r.status !== 200) { finish({ status: r.status, body: r.json }); return }
          const j = isObj(r.json) ? r.json : {}
          const ok = typeof j.reply === 'string' && proofsEqual(hmacProof(key, doorWitnessProofText({ ...fields, replyDigest: sha256Hex(j.reply) })), j.proof)
          if (!ok) { finish({ status: 502, body: { ok: false, error: BAD_WITNESS_PROOF } }); return }
          let reply: unknown
          try { reply = JSON.parse(j.reply as string) } catch { finish({ status: 502, body: { ok: false, error: BAD_WITNESS_PROOF } }); return }
          // The read's round is in the call the witness proved its reply to (the nonce is bound to the call's digest): echoed here as the link's answer echoes it.
          const round = (call as { round?: number }).round
          finish({ status: 200, body: { ok: true, reply, ...(round !== undefined ? { round } : {}) } })
        })
      })
    }
    if (body.walnutId || !o.walnutId) go(body.walnutId)
    else o.walnutId().then(go, () => finish(null))
    return () => { gone = true; abandon?.() }
  }
}

/** Where the companion takes a witness's setup: its bridge lane, the paired Mac's machine token only (web/routes/witness-door.ts). */
export const BRIDGE_WITNESS_SETUP_PATH = '/bridge/witness-setup'

/** The companion's bridge lane as this leader is paired with it: its `/bridge` base and the machine token (cloud-ingest.ts cloudSessionEndpoint). */
export type CompanionLane = () => Promise<{ url: string; token: string } | null>

/**
 * Set a witness on the companion up (its direct door has no key to check a setup with): its
 * record, its first list and its key, over the companion's bridge lane with this leader's machine
 * token. Only to the companion this leader is paired with, and only when the witness's `url` is on
 * that companion's own origin: the token is never sent anywhere else.
 */
export async function setUpCompanionWitness(
  place: { id: string; url?: string; key?: string }, list: string[], walnutId: string, evidence: WitnessEvidence[],
  lane: CompanionLane = async () => (await import('../../cloud-ingest.js')).cloudSessionEndpoint(),
  join?: number,
): Promise<{ ok: true; made: boolean } | { ok: false; error: string }> {
  if (!place.url || !place.key) return { ok: false, error: 'no url and key (run walnut leader witnesses init on the leader to mint the key)' }
  const ep = await lane().catch(() => null)
  if (!ep) return { ok: false, error: 'this leader is not paired with a companion' }
  let origin: string
  let doorOrigin: string
  try { origin = new URL(ep.url).origin; doorOrigin = new URL(place.url).origin } catch { return { ok: false, error: 'bad url' } }
  if (origin !== doorOrigin) return { ok: false, error: `its url is not on the paired companion (${origin}): set it up over its own machine's link` }
  try {
    const res = await fetch(`${origin}${BRIDGE_WITNESS_SETUP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify({ v: 1, walnutId, witness: place.id, list, evidence, key: place.key, ...(join !== undefined ? { join } : {}) } satisfies WitnessSetup),
      signal: AbortSignal.timeout(30_000),
    })
    const b = await res.json().catch(() => null) as { ok?: boolean; made?: boolean; error?: string } | null
    if (res.status === 200 && b?.ok === true && typeof b.made === 'boolean') return { ok: true, made: b.made }
    return { ok: false, error: `${res.status} ${typeof b?.error === 'string' ? b.error : 'refused'}` }
  } catch {
    return { ok: false, error: 'no answer' }
  }
}
