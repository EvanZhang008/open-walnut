/**
 * A trigger fire no server claimed wakes a stopped session on its host (daemon-session-resume.ts
 * resumeForTrigger), and a session the PERSON stopped is one of them: the fire is decided after that
 * stop, so it carries the stop the host recorded as its fence, as a message the server sends after
 * a stop does (session-send-core.ts). 2026-11-25 (tests/e2e/copyless-away-restart-e2e.test.ts T1):
 * the host's resume passed no fence, so every try was refused ("a stop request superseded this
 * start") while the leader was away, and the refused try still took the session's 10 minute cooldown.
 * A stop still being applied, or one that lands while the session starts, still wins.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDaemonSessionResume } from '../../src/providers/daemon-session-resume.js'

const SID = '11111111-2222-4333-8444-555555555555'
const HOME = '/w/home'

/** The cron runtime's stop gate as daemon-cron-runtime.ts keeps it: a stop being applied, else the last one recorded. */
function cronOf(o: { recorded?: string; pending?: string }) {
  return {
    get: (sid: string) => (sid === SID && o.recorded ? { stopRequestId: o.recorded } : undefined),
    deliveryAllowed: (sid: string, fence: unknown) => {
      const stoppedAt = sid === SID ? (o.pending ?? o.recorded) : undefined
      return !stoppedAt || stoppedAt === fence
    },
  }
}

function rig(cron: ReturnType<typeof cronOf> | null, opts: { stopDuringStart?: boolean } = {}) {
  const started: Array<Record<string, unknown>> = []
  const sent: string[] = []
  const stopVersions = new Map<string, number>()
  const logs: string[] = []
  const resume = createDaemonSessionResume({
    daemonEnv: {}, STREAMS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'resume-fence-')), sessions: new Map(),
    core: { lineReachedBefore: async () => null, handleSendCommand: async (_sid: string, text: string) => { sent.push(text); return { ok: true } } } as never,
    hostResume: { resumeArgs: (args: string[]) => args },
    cronRuntime: () => cron as never,
    sessionStartGate: { run: (_sid: string, fn: () => Promise<unknown>) => fn() } as never,
    sessionStopVersions: stopVersions,
    isJournalSid: (sid: unknown): sid is string => typeof sid === 'string',
    livedHere: () => true, journaledHome: () => HOME, walnutOfHome: (h: string) => h,
    spawnRecordOf: () => ({ args: ['claude', '--resume', SID], cwd: os.tmpdir(), mode: 'default', home: HOME }),
    fireLineUuid: () => 'fire-uuid',
    startSessionProcess: async (cmd: Record<string, unknown>, _isCurrent?: () => boolean, canStart?: () => boolean) => {
      // A person's stop landing while the CLI starts (cmdStop bumps the session's stop version).
      if (opts.stopDuringStart) stopVersions.set(SID, (stopVersions.get(SID) ?? 0) + 1)
      if (canStart && !canStart()) throw new Error('start: stop request superseded this start')
      started.push(cmd)
      return {}
    },
    cmdStart: (() => undefined) as never, cmdSend: (() => undefined) as never, bridgeHearsSession: () => true,
    logMsg: (_level: string, msg: string) => { logs.push(msg) }, sendError: (() => undefined) as never,
  })
  return { fire: () => resume.resumeForTrigger(HOME, SID, 'The watch fired.', 'qm-fire-1', 'task-1'), started, sent, logs }
}

describe('a trigger fire wakes a session its person stopped, on the host', () => {
  it('a stop recorded before the fire: the session is resumed with the fire', async () => {
    const r = rig(cronOf({ recorded: 'stop-1' }))
    expect(await r.fire()).toEqual({ ok: true })
    expect(r.started).toHaveLength(1)
    expect(r.sent).toEqual(['The watch fired.'])
  })

  it('no stop recorded, or no cron runtime: resumed as before', async () => {
    for (const cron of [cronOf({}), null]) {
      const r = rig(cron)
      expect(await r.fire()).toEqual({ ok: true })
      expect(r.started).toHaveLength(1)
    }
  })

  it('a stop still being applied wins: nothing starts', async () => {
    const r = rig(cronOf({ recorded: 'stop-1', pending: 'stop-2' }))
    const out = await r.fire()
    expect(out.ok).toBe(false)
    expect(r.started).toHaveLength(0)
    expect(r.sent).toHaveLength(0)
  })

  it('a stop that lands while the session starts wins: the fire is not sent', async () => {
    const r = rig(cronOf({ recorded: 'stop-1' }), { stopDuringStart: true })
    const out = await r.fire()
    expect(out.ok).toBe(false)
    expect(r.sent).toHaveLength(0)
  })

  it('no host-originated start in the daemon asks the stop gate with no fence', () => {
    // The class: a start or send this host decides itself after a stop it recorded. One with no fence
    // reads as older than that stop and is refused for good (the bug above).
    const dir = path.resolve(import.meta.dirname, '../../src/providers')
    const hits = fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))
      .flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').map((l, i) => ({ at: `${n}:${i + 1}`, l })))
      .filter((x) => /deliveryAllowed\([^)]*,\s*undefined\s*\)/.test(x.l))
    expect(hits.map((x) => x.at)).toEqual([])
  })
})
