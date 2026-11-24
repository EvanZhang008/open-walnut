/**
 * The record of whose ACP worker a runtime id is (src/providers/daemon-spawn-journal.ts
 * recordAcpRuntime / acpRuntimeOwner), written when the daemon starts the worker
 * (daemon-acp-sessions.ts cmdAcpStart). The follower check reads it so a Codex session's
 * journal (<runtimeId>.acp.jsonl) stays its Walnut's after the session left the Mac's copy of
 * the 200 newest; the same check on a real daemon is tests/providers/follower-owner-scope-twins.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDaemonSpawnJournal } from '../../src/providers/daemon-spawn-journal.js'
import { createDaemonAcpSessions } from '../../src/providers/daemon-acp-sessions.js'
import { createWalnutScope } from '../../src/providers/walnut-scope-core.js'

const HOME_A = '/fixture/marina-home'
const HOME_B = '/fixture/acme-home'
/** A server this daemon runs for marina's leader: its data dir names marina's Walnut. */
const DATA_A = '/fixture/marina-host/data'

let base = ''
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acprt-'))) })
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }) })

function journal() {
  return createDaemonSpawnJournal({
    daemonEnv: { WALNUT_SPAWN_JOURNAL: path.join(base, 'local', 'spawn-journal.jsonl') },
    HOME_DIR: path.join(base, 'home'), STREAMS_DIR: path.join(base, 'streams'), ISOLATED_FOR: () => '',
    walnutScope: createWalnutScope({ path, keyOf: (home) => home }),
    hostServers: { walnutOf: (home) => (home === DATA_A ? HOME_A : undefined), dataDirs: () => [DATA_A] },
  })
}
const recordFile = () => path.join(base, 'local', 'acp-runtimes.jsonl')

describe('the record of whose ACP worker a runtime id is', () => {
  it('names the Walnut that started it, across a daemon restart, and only the first start counts', async () => {
    const j = journal()
    const writes = [j.recordAcpRuntime('acp-rt-a', HOME_A), j.recordAcpRuntime('acp-rt-host', DATA_A), j.recordAcpRuntime('acp-rt-a', HOME_B)]
    // Known at once, while the line is still on its way to disk.
    expect(j.acpRuntimeOwner('acp-rt-a')).toBe(HOME_A)
    await Promise.all(writes)
    expect(j.acpRuntimeOwner('acp-rt-a')).toBe(HOME_A)
    // A start from a server's own data dir is its leader's Walnut's.
    expect(j.acpRuntimeOwner('acp-rt-host')).toBe(HOME_A)
    expect(j.acpRuntimeOwner('acp-rt-x')).toBeUndefined()
    // A restarted daemon reads the same from disk.
    const again = journal()
    expect(again.acpRuntimeOwner('acp-rt-a')).toBe(HOME_A)
    expect(again.acpRuntimeOwner('acp-rt-host')).toBe(HOME_A)
    // The worker is no CLI session: the spawn journal does not name it.
    expect(again.journaledIds().has('acp-rt-a')).toBe(false)
  })

  it('sees what another daemon on the host appended, skips a torn tail, and refuses bad ids and homes', async () => {
    const j = journal()
    await j.recordAcpRuntime('acp-rt-a', HOME_A)
    expect(j.acpRuntimeOwner('acp-rt-b')).toBeUndefined()
    fs.appendFileSync(recordFile(), JSON.stringify({ v: 1, runtimeId: 'acp-rt-b', at: 'x', home: HOME_B }) + '\n{"v":1,"runtimeId":"acp-rt-torn"')
    expect(j.acpRuntimeOwner('acp-rt-b')).toBe(HOME_B)
    expect(j.acpRuntimeOwner('acp-rt-torn')).toBeUndefined()
    // The next line starts after the torn one, never glued onto it.
    await j.recordAcpRuntime('acp-rt-c', HOME_A)
    expect(journal().acpRuntimeOwner('acp-rt-c')).toBe(HOME_A)
    for (const [rt, home] of [['../x', HOME_A], ['acp-rt-d', 'relative/home'], ['acp-rt-e', undefined], ['', HOME_A]] as const) await j.recordAcpRuntime(rt, home)
    expect(fs.readFileSync(recordFile(), 'utf8')).not.toMatch(/acp-rt-d|acp-rt-e|\.\.\/x/)
  })

  it('a started worker is recorded with the owner its start named, with a task or without; a failed start records nothing', async () => {
    const j = journal()
    let ok = true
    const writes: Promise<void>[] = []
    const replies: Array<{ ok: boolean }> = []
    const acpSessions = createDaemonAcpSessions<object>({
      daemonEnv: {}, DAEMON_DIR: base, TASK_DIR_ROOT: path.join(base, 'tasks'), GATEWAY_SOCK_PATH: path.join(base, 'gw.sock'),
      SECRETS_ROOT: () => path.join(base, 'secrets'), secretsSessionEnv: () => ({}), sessions: new Map(),
      acp: { acpStart: async () => (ok ? { ok: true, result: {} } : { ok: false, error: 'no adapter' }) } as never,
      usageBudget: {} as never, budgetGate: () => 'budget_checking' as never,
      sessionStartGate: { run: (_sid: string, fn: () => Promise<unknown>) => fn() } as never,
      demoQuiesce: { fenced: false }, hostCallTokens: { envFor: () => ({}) } as never,
      recordAcpRuntime: (rt, home) => { const w = j.recordAcpRuntime(rt, home); writes.push(w); return w }, isJournalSid: j.isJournalSid,
      walnutThroughGateway: () => false, sessionPathWithShim: (p) => p, sessionWalnutApiUrl: () => undefined,
      pwSilenceFile: async () => null, pwSilenceAcpOptions: () => ({}),
      sendOk: () => { replies.push({ ok: true }) }, sendError: () => { replies.push({ ok: false }) }, sendFrame: () => { replies.push({ ok: false }) },
      logMsg: () => {},
    })
    // A start as an older server sends it: the owner only as the task's `home`.
    await acpSessions.cmdAcpStart({}, 1, { sid: 'acp-rt-started', cwd: base, taskId: 'task-1', home: HOME_B })
    // A start with no task names its owner in its own field, and no `home` (no task dir, no call token).
    await acpSessions.cmdAcpStart({}, 2, { sid: 'acp-rt-no-task', cwd: base, ownerHome: HOME_A })
    // Both fields: the owner field decides.
    await acpSessions.cmdAcpStart({}, 3, { sid: 'acp-rt-both', cwd: base, taskId: 'task-1', home: HOME_B, ownerHome: HOME_A })
    ok = false
    await acpSessions.cmdAcpStart({}, 4, { sid: 'acp-rt-failed', cwd: base, taskId: 'task-1', ownerHome: HOME_B })
    expect(replies).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false }])
    await Promise.all(writes)
    expect(journal().acpRuntimeOwner('acp-rt-started')).toBe(HOME_B)
    expect(journal().acpRuntimeOwner('acp-rt-no-task')).toBe(HOME_A)
    expect(journal().acpRuntimeOwner('acp-rt-both')).toBe(HOME_A)
    expect(journal().acpRuntimeOwner('acp-rt-failed')).toBeUndefined()
  })
})
