/**
 * The companion's capability `witness-door` (src/core/capabilities/witness-door.ts) on the real
 * companion (the repo's companion test cluster, a WALNUT_CLOUD_MODE replica in its own process):
 *   - off (a companion that sets nothing): neither path exists; each answers byte for byte what a
 *     path the server never had answers;
 *   - on with no witness set up: the door refuses every caller;
 *   - its setup takes only the paired Mac's machine token, once, and never replaces a key; the
 *     leader's companion setup sends it only to that companion's own origin;
 *   - then a caller with the key is answered, and one without is not.
 */
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { directWitnessCall, setUpCompanionWitness } from '../../src/core/leader/switch/witness-direct.js'
import { WITNESS_REQUEST_PATH, type WitnessEvidence } from '../../src/core/leader/switch/witness-wire.js'
import { proofSecret, sha256Hex } from '../../src/utils/hmac-proof.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-witness-door-'))
const boxes: CloudBoxReplica[] = []
afterAll(async () => {
  for (const b of boxes) await b.stop().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true })
}, 120_000)

const WALNUT = 'walnut-companion-door'
const LIST = ['w-b', 'w-c', 'w-k']
const post = async (port: number, p: string, body: unknown, token?: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  return { status: r.status, text: await r.text() }
}
const challenge = { v: 1, walnutId: WALNUT, witness: 'w-k', digest: sha256Hex('x') }

describe('the companion\'s witness door', () => {
  it('off: neither path exists, each answers what a path the server never had answers', async () => {
    const box = await startCloudBoxReplica(path.join(root, 'off'))
    boxes.push(box)
    const never = await post(box.port, '/leader-witness-never-had/challenge', challenge)
    expect(await post(box.port, '/leader-witness/challenge', challenge)).toEqual({ ...never, text: never.text.replace('/leader-witness-never-had/challenge', '/leader-witness/challenge') })
    const neverBridge = await post(box.port, '/bridge/never-had', challenge, box.tokens.primaryMachine)
    expect(await post(box.port, '/bridge/witness-setup', challenge, box.tokens.primaryMachine)).toEqual({ ...neverBridge, text: neverBridge.text.replace('/bridge/never-had', '/bridge/witness-setup') })
    expect(never.status).toBe(404)
    // Nothing of a witness was made on the box.
    expect(fs.existsSync(path.join(box.box.home, '.local', 'state', 'open-walnut', 'leader-witness'))).toBe(false)
    await box.stop()
  }, 300_000)

  it('on: refuses every caller until set up, takes its setup from the paired Mac only, and then answers only the key', async () => {
    const box = await startCloudBoxReplica(path.join(root, 'on'), undefined, { env: { WALNUT_CAPABILITIES: 'witness-door' } })
    boxes.push(box)
    // No key configured: no nonce for anyone.
    const none = await post(box.port, '/leader-witness/challenge', challenge)
    expect(none.status).toBe(404)
    expect(JSON.parse(none.text)).toEqual({ ok: false, error: 'not_a_witness' })
    const key = proofSecret()
    const evidence: WitnessEvidence[] = [{ witness: 'w-b', seen: 'absent' }, { witness: 'w-c', seen: 'blank' }]
    const setup = { v: 1, walnutId: WALNUT, witness: 'w-k', list: LIST, evidence, key }
    // Only the paired Mac's own machine token sets it up.
    expect((await post(box.port, '/bridge/witness-setup', setup)).status).toBe(401)
    expect((await post(box.port, '/bridge/witness-setup', setup, box.tokens.phone)).status).toBe(403)
    expect((await post(box.port, '/bridge/witness-setup', setup, box.tokens.otherMachine)).status).toBe(403)
    expect((await post(box.port, '/bridge/witness-setup', { ...setup, key: undefined }, box.tokens.primaryMachine)).status).toBe(400)
    // Only from nothing: a setup whose caller saw a record at another witness is refused, and makes nothing.
    expect(JSON.parse((await post(box.port, '/bridge/witness-setup', { ...setup, evidence: [{ witness: 'w-b', seen: 'record' }, { witness: 'w-c', seen: 'absent' }] }, box.tokens.primaryMachine)).text)).toEqual({ ok: false, error: 'witnesses_hold_records' })
    expect(JSON.parse((await post(box.port, '/bridge/witness-setup', { ...setup, evidence: [{ witness: 'w-b', seen: 'unreached' }, { witness: 'w-c', seen: 'absent' }] }, box.tokens.primaryMachine)).text)).toEqual({ ok: false, error: 'witnesses_unreached' })
    const made = await post(box.port, '/bridge/witness-setup', setup, box.tokens.primaryMachine)
    expect(made.status).toBe(200)
    expect(JSON.parse(made.text)).toEqual({ ok: true, made: true })
    // A key is never replaced; the same setup again is kept.
    expect(JSON.parse((await post(box.port, '/bridge/witness-setup', { ...setup, key: proofSecret() }, box.tokens.primaryMachine)).text)).toEqual({ ok: false, error: 'key_differs' })
    // The leader's own companion setup: to the paired companion's origin, never anywhere else.
    const url = `http://127.0.0.1:${box.port}/leader-witness`
    const lane = async () => ({ url: `http://127.0.0.1:${box.port}/bridge`, token: box.tokens.primaryMachine })
    expect(await setUpCompanionWitness({ id: 'w-k', url, key }, LIST, WALNUT, evidence, lane)).toEqual({ ok: true, made: false })
    expect(await setUpCompanionWitness({ id: 'w-k', url: 'https://elsewhere.example/leader-witness', key }, LIST, WALNUT, evidence, lane)).toMatchObject({ ok: false })
    // The record and key are the box's machine state, beside its machine id, never in its data dir.
    const dir = path.join(box.box.home, '.local', 'state', 'open-walnut', 'leader-witness', WALNUT, 'w-k')
    expect(fs.readFileSync(path.join(dir, 'witness-key'), 'utf8').trim()).toBe(key)
    expect(fs.statSync(path.join(dir, 'witness-key')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(box.box.data).some((f) => f.includes('witness'))).toBe(false)
    // A caller with the key is answered; one with another key is not.
    const ask = (k: string) => new Promise<{ status: number } | null>((resolve) => {
      directWitnessCall()({ id: 'w-k', url, key: k }, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w-k', request: { type: 'read' } }, resolve)
    })
    expect((await ask(key))?.status).toBe(200)
    expect((await ask(proofSecret()))?.status).toBe(403)
    // No answer and no line of the box's log holds the key.
    expect(box.log()).not.toContain(key)
  }, 300_000)
})
