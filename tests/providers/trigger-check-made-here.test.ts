/**
 * A check report of a trigger made on this host while its Walnut was away is kept until the server
 * holds that trigger (daemon-trigger-store.ts sendCheck, serverSetNames).
 *
 * The incident (2026-11-26, 00:06 to 01:00Z, the Mac away): sessions on clouddev made five triggers
 * on the host (offline-host-core.ts "trigger created here"). When the Mac came back, the configure
 * replay sent each one's kept checks seconds before the drain stored the trigger: the Mac dropped
 * them (no routine yet), answered the next ping, and the daemon counted them read. One trigger kept
 * 5 of its 28 checks, another 3 of 4. A report is now marked on the wire only for a trigger the
 * server's own pushed set names; until then it stays kept and goes again with the next run.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as triggerCheck from '../../src/providers/trigger-check-core.js'
import { createWalnutScope } from '../../src/providers/walnut-scope-core.js'
import { createDaemonTriggerStore, type ArmedTrigger, type TriggerSocket } from '../../src/providers/daemon-trigger-store.js'
import type { HostTriggerJudge } from '../../src/providers/daemon-module-deps.js'
import type { TriggerCheckedEvent } from '../../src/providers/trigger-check-core.js'

const HOME = '/fixture/walnut-home'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-made-here-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function rig() {
  const ws: TriggerSocket = { data: { triggerScope: HOME } }
  const sent: Array<Record<string, unknown>> = []
  const store = createDaemonTriggerStore<TriggerSocket>({
    judge: triggerCheck as unknown as HostTriggerJudge,
    daemonEnv: { WALNUT_TRIGGER_STATE_DIR: path.join(dir, 'state') } as never,
    DAEMON_DIR: dir, HOME_DIR: dir, SERVICE_MODE: false, DAEMON_STATE_DIR: undefined, IS_PROD_DAEMON_DIR: false,
    walnutScope: createWalnutScope({ path, keyOf: (h) => Buffer.from(h).toString('hex').slice(0, 16) }),
    gatewayClientHomes: new WeakMap(), wsClients: new Set([ws]), isServerClient: () => true,
    sendEvent: (_ws, ev, fields) => { sent.push({ ev, ...fields }) },
    logMsg: () => {},
  })
  return { ws, sent, store }
}

const check = (id: string, atMs: number): TriggerCheckedEvent => ({ type: 'trigger.checked', id, atMs, outcome: 'quiet', reason: 'fire-false', durationMs: 5 } as TriggerCheckedEvent)

describe('a check of a trigger made here is kept until the server holds that trigger', () => {
  it('sent while the pushed set does not name it: not marked, not settled by a ping, sent again; once named: read as any', () => {
    const { ws, sent, store } = rig()
    const def = { id: 'mwwstses-a2d5de63', name: 'Made here', everyMs: 120_000, check: { run: 'true', timeoutSeconds: 10 } } as never
    const t0 = 1_795_651_600_000
    const kept = [check('mwwstses-a2d5de63', t0), check('mwwstses-a2d5de63', t0 + 120_000)]
    const entry: ArmedTrigger = {
      home: HOME, def, nextRunAtMs: t0 + 240_000, running: false, fireSentAt: new Map(), armedAtMs: t0,
      state: { ...triggerCheck.emptyHostState(t0), unsentChecks: [...kept], lastCheck: kept[1] } as never,
    }
    // The Mac is back; its set (pushed before the drain) does not name the trigger yet.
    store.triggerScopeOf(HOME).configured = []
    const replayAt = t0 + 200_000
    for (const c of kept) expect(store.sendCheck(entry, { ...c, replay: true }, replayAt, ws as never)).toEqual([ws])
    expect(sent.map((e) => e.atMs)).toEqual([t0, t0 + 120_000])
    // It answers a ping a beat later: nothing it was sent counts as read.
    ws.data!.readThroughAt = replayAt + 2_000
    expect(store.settleChecks(entry)).toBe(false)
    expect(entry.state.unsentChecks?.map((c) => c.atMs)).toEqual([t0, t0 + 120_000])
    // The next run sends each again (none is on the wire).
    expect(store.checksToSendAgain(entry, t0 + 120_000).map((c) => c.atMs)).toEqual([t0])

    // The drain stored it and the next push names it: a send now is read once a ping answers.
    store.triggerScopeOf(HOME).configured = [def]
    const againAt = replayAt + 10_000
    for (const c of kept) store.sendCheck(entry, { ...c, replay: true }, againAt, ws as never)
    expect(store.settleChecks(entry)).toBe(false)
    ws.data!.readThroughAt = againAt + 2_000
    expect(store.settleChecks(entry)).toBe(true)
    expect(entry.state.unsentChecks ?? []).toEqual([])
  })

  it('a trigger the pushed set names is marked and read as before', () => {
    const { ws, store } = rig()
    const def = { id: 'mvzz0000-aaaa', name: 'Pushed', everyMs: 900_000, check: { run: 'true', timeoutSeconds: 10 } } as never
    const t0 = 1_795_651_600_000
    const c = check('mvzz0000-aaaa', t0)
    const entry: ArmedTrigger = {
      home: HOME, def, nextRunAtMs: t0 + 900_000, running: false, fireSentAt: new Map(), armedAtMs: t0,
      state: { ...triggerCheck.emptyHostState(t0), unsentChecks: [c], lastCheck: c } as never,
    }
    store.triggerScopeOf(HOME).configured = [def]
    store.sendCheck(entry, c as never, t0 + 1, ws as never)
    ws.data!.readThroughAt = t0 + 2
    expect(store.settleChecks(entry)).toBe(true)
    expect(entry.state.unsentChecks ?? []).toEqual([])
  })
})
