/**
 * One witness of a switchable leader on the companion or a dev box's service (capability `witness-door`,
 * off by default on both: src/core/capabilities/witness-door.ts). Routes outside /api, mounted only while
 * the server has the capability (the setup route on the companion only: a dev box's witness is set up
 * over the leader's own link to it), so without it each path answers exactly what a path the server never had does:
 *
 *   POST /leader-witness/challenge, /leader-witness/request
 *       the witness's direct door (core/leader/switch/witness-door.ts): a caller proves the witness's
 *       own key by challenge-response, nothing else lets it in;
 *   POST /bridge/witness-setup
 *       its setup, once: record, first list and key, from the paired Mac's own machine token only
 *       (bridge-ingest.ts authenticate, the gate of every write the Mac makes to this box). The door
 *       cannot take a setup itself: before it, there is no key to check one with.
 *
 * The record and the key are this box's (machine-id.ts witnessRoot, beside its machine id), never
 * in its data dir: a copy of a data dir never carries a witness.
 */
import express, { Router, type Request, type Response } from 'express'
import { authenticate, parseErrors } from './bridge-ingest.js'
import { log } from '../../logging/index.js'

export { WITNESS_DOOR_PATH } from '../../core/leader/switch/witness-wire.js'
export { BRIDGE_WITNESS_SETUP_PATH } from '../../core/leader/switch/witness-direct.js'

/** A request carries one permit record (a list change: every op entry), its call text inside JSON. */
const BODY_LIMIT = '6mb'

async function machineRoot(): Promise<string> {
  return (await import('../../core/leader/switch/machine-id.js')).witnessRoot()
}

/** The direct door, one per server (its nonces live here). `root`: where the records are (default this machine's; a test gives its own). */
export function createWitnessDoorRouter(o: { root?: string } = {}): Router {
  const router = Router()
  let door: Promise<import('../../core/leader/switch/witness-door.js').WitnessDoor> | null = null
  const theDoor = () => (door ??= (async () => {
    const { machineWitnessDoor } = await import('../../core/leader/switch/witness-door.js')
    // A refusal is logged by its fixed code only: never a key, a proof, a nonce or a body.
    return machineWitnessDoor({ root: o.root ?? await machineRoot(), onRefuse: (code) => log.web.info('witness door: refused', { code }), log: (level, msg, data) => log.web[level](msg, data) })
  })())
  const send = (res: Response, r: { status: number; body: unknown }) => { res.status(r.status).set('cache-control', 'no-store').json(r.body) }
  router.post('/challenge', express.json({ limit: '64kb' }), (req: Request, res: Response, next) => {
    void theDoor().then((d) => send(res, d.challenge(req.body, req.ip ?? req.socket.remoteAddress ?? 'unknown'))).catch(next)
  })
  router.post('/request', express.json({ limit: BODY_LIMIT }), (req: Request, res: Response, next) => {
    void (async () => {
      const [{ doorRequest }, d] = await Promise.all([import('../../core/leader/switch/witness-door.js'), theDoor()])
      send(res, await doorRequest(d, req.body))
    })().catch(next)
  })
  router.use(parseErrors)
  return router
}

/** The witness's setup over the paired Mac's machine token (the same gate as /bridge/ingest). */
export function createBridgeWitnessSetupRouter(): Router {
  const router = Router()
  router.post('/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: '64kb' }),
    (req: Request, res: Response, next) => {
      void (async () => {
        const [{ parseWitnessSetup }, { setUpMachineWitness }] = await Promise.all([
          import('../../core/leader/switch/witness-wire.js'), import('../../core/leader/switch/witness-route.js'),
        ])
        const setup = parseWitnessSetup(req.body)
        // Only a keyed setup: a companion witness is reached by its direct door alone, which needs the key.
        if (!setup || !setup.key) { res.status(400).json({ ok: false, error: 'bad_request' }); return }
        const r = await setUpMachineWitness(await machineRoot(), setup, (level, msg, data) => log.web[level](msg, data))
        res.status(r.status).set('cache-control', 'no-store').json(r.body)
      })().catch(next)
    },
  )
  router.use(parseErrors)
  return router
}
