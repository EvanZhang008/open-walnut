/**
 * A session whose spawn never recorded its process's start time can still be
 * stopped, once its live process proves it runs that session.
 *
 * 2026-10-28: the Mac was so loaded that the `ps` reading a new CLI's start time
 * at spawn timed out, so the daemon recorded `startTime: null`. Every daemon
 * restart adopted the entry again as it was, and every `stop` of the process was
 * refused with "process identity is unknown; refusing to signal", which the
 * server's idle reaper asked again every 30 s: about 115 refusals an hour, for
 * over a day, and the 20-hour-idle CLI kept running.
 *
 * Fix: before refusing, the stop reads the process's command line; when it is a
 * print-mode CLI resuming or starting this sid with the args the daemon spawned
 * it with (argvNamesSession), the start time
 * read with it becomes the session's identity (persisted), and the usual check
 * compares a second reading against it.
 *
 * Both twins run from their own text: stopSessionProcess and
 * recordMissingStartTime are sliced out of daemon-standalone.ts and the
 * daemon-source.ts template and evaluated with every free identifier injected.
 * process.kill is spied (signal 0 answers "alive", any other signal fails the
 * test), and the process-group kill is a stub that records.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import ts from 'typescript'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { argvNamesSession } from '../../src/providers/daemon-core.js'

const REPO_ROOT = nodePath.resolve(__dirname, '../..')
const SID = '43b00853-0000-4000-8000-00000000abcd'
/** Above any real pid limit: nothing can ever answer to it. */
const PID = 2 ** 22 + 17
const START = 'Tue Oct 27 20:50:35 2026'
const SPAWN_ARGS = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--resume', SID, '--settings', '{"env":{"A":"1"}}']
/** What ps prints for that spawn: the program resolved to a path, the rest as spawned. */
const CLI_ARGV = ['/usr/local/bin/claude', ...SPAWN_ARGS.slice(1)].join(' ')

type Twin = 'standalone' | 'template'
interface Reply { id: number; ok: boolean; error?: string; data?: Record<string, unknown> }

function sliceTopLevelFn(src: string, name: string): string | null {
  const at = src.search(new RegExp('(?:async )?function ' + name + '\\('))
  if (at < 0) return null
  const end = src.indexOf('\n}', at)
  expect(end).toBeGreaterThan(at)
  return src.slice(at, end + 2)
}

interface World {
  session: Record<string, unknown>
  /** What a start-time read of PID answers now. */
  liveStartTime: string | null
  /** What PID's command line reads now. */
  argv: string | null
}

function buildTwin(kind: Twin, world: World) {
  const replies: Reply[] = []
  const signals: string[] = []
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
  let persisted = 0
  let groupAlive = true
  const sessions = new Map<string, Record<string, unknown>>([[SID, world.session]])
  const injected: Record<string, unknown> = {
    sessions,
    SERVICE_MODE: false,
    daemonBootId: 'boot-1',
    cronRuntime: null,
    logMsg: (level: string, msg: string, data?: Record<string, unknown>) => { logs.push({ level, msg, data }) },
    sendOk: (_ws: unknown, id: number, data: Record<string, unknown>) => { replies.push({ id, ok: true, data }) },
    sendError: (_ws: unknown, id: number, error: string) => { replies.push({ id, ok: false, error }) },
    readStartTime: (pid: number) => (pid === PID ? world.liveStartTime : null),
    commandLineOf: (pid: number) => (pid === PID ? world.argv : ''),
    persistRegistry: () => { persisted++ },
    reapSession: (sid: string) => { const s = sessions.get(sid); if (s) s.state = 'dead' },
    isProcessGroupAlive: () => groupAlive,
    killProcessGroup: (_pid: number, sig: string) => { signals.push(sig); groupAlive = false },
    cancelTurnRetry: () => {},
    clearTurnRetryStreak: () => {},
    wsId: () => 7,
  }
  const src = kind === 'standalone'
    ? nodeFs.readFileSync(nodePath.join(REPO_ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    : getDaemonSource()
  const parts = [sliceTopLevelFn(src, 'stopSessionProcess')!]
  const backfill = sliceTopLevelFn(src, 'recordMissingStartTime')
  if (backfill) parts.push(backfill)
  else parts.push('function recordMissingStartTime() { return false }')
  if (kind === 'template') {
    // The template carries the helper as injected text (__ARGV_NAMES_SESSION__).
    const at = src.indexOf('const argvNamesSession = (')
    if (at >= 0) parts.unshift(src.slice(at, src.indexOf('\nfunction recordMissingStartTime', at)))
    else injected.argvNamesSession = argvNamesSession
  } else {
    injected.argvNamesSession = argvNamesSession
  }
  const js = ts.transpileModule(parts.join('\n') + '\nreturn { stopSessionProcess };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const names = Object.keys(injected)
  const built = new Function(...names, js)(...names.map((n) => injected[n]))
  const stop = () => Promise.resolve(built.stopSessionProcess({}, 1, SID))
  return { stop, replies, signals, logs, persisted: () => persisted }
}

describe.each<[Twin]>([['standalone'], ['template']])('%s twin: stop of a process with no recorded start time', (kind) => {
  let world: World
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    world = {
      session: { pid: PID, state: 'running', exitCode: null, startTime: null, args: SPAWN_ARGS },
      liveStartTime: START,
      argv: CLI_ARGV,
    }
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) return true
      throw new Error(`the harness must never send a real signal (${String(sig)} to ${pid})`)
    }) as typeof process.kill)
  })

  afterEach(() => {
    for (const call of killSpy.mock.calls) expect(call[1]).toBe(0)
    vi.restoreAllMocks()
  })

  it('stops it when its command line resumes this session, and records the start time', async () => {
    const twin = buildTwin(kind, world)
    await twin.stop()
    expect(twin.replies).toEqual([{ id: 1, ok: true, data: { stopped: true } }])
    expect(twin.signals).toEqual(['SIGINT'])
    expect(world.session.startTime).toBe(START)
    expect(twin.persisted()).toBeGreaterThanOrEqual(1)
  })

  it.each([
    ['another program', 'node /usr/lib/server.js --port 8080'],
    ['a CLI of another session', CLI_ARGV.replace(SID, '99999999-0000-4000-8000-000000000000')],
    ['a fork of this session', `${CLI_ARGV} --fork-session`],
    ['a person\'s interactive CLI of this session (no -p)', `claude -r ${SID}`],
    ['a print-mode CLI of this session spawned with other args', `claude -p --resume ${SID} --settings {"env":{"B":"2"}}`],
    ['a command line that could not be read', null],
  ])('still refuses when the pid now runs %s, and logs the sid', async (_label, argv) => {
    world.argv = argv
    const twin = buildTwin(kind, world)
    await twin.stop()
    expect(twin.replies).toEqual([{ id: 1, ok: false, error: 'stop: process identity is unknown; refusing to signal' }])
    expect(twin.signals).toEqual([])
    expect(world.session.startTime).toBeNull()
    expect(twin.logs.some((l) => l.msg.startsWith('cmdStop: process identity is unknown') && l.data?.sid === SID && l.data?.pid === PID)).toBe(true)
  })

  it('a record without spawn args still needs print mode and a resume of this sid', async () => {
    delete world.session.args
    world.argv = `claude -p --resume ${SID}`
    const ok = buildTwin(kind, world)
    await ok.stop()
    expect(ok.signals).toEqual(['SIGINT'])

    world.session = { pid: PID, state: 'running', exitCode: null, startTime: null }
    world.argv = `claude --resume ${SID}`
    const interactive = buildTwin(kind, world)
    await interactive.stop()
    expect(interactive.replies[0]!.ok).toBe(false)
    expect(interactive.signals).toEqual([])
  })

  it('refuses when the start time changes between the two readings', async () => {
    const twin = buildTwin(kind, world)
    let reads = 0
    world.liveStartTime = START
    Object.defineProperty(world, 'liveStartTime', { get: () => (reads++ === 0 ? START : 'Wed Oct 28 01:00:00 2026') })
    await twin.stop()
    expect(twin.replies[0]!.ok).toBe(false)
    expect(twin.signals).toEqual([])
  })

  it('a recorded start time is compared as before: a match stops, a mismatch refuses', async () => {
    world.session.startTime = START
    const ok = buildTwin(kind, world)
    await ok.stop()
    expect(ok.signals).toEqual(['SIGINT'])

    world.session = { pid: PID, state: 'running', exitCode: null, startTime: 'Mon Oct 26 09:00:00 2026' }
    const recycled = buildTwin(kind, world)
    await recycled.stop()
    expect(recycled.replies[0]!.error).toBe('stop: process identity is unknown; refusing to signal')
    expect(recycled.signals).toEqual([])
    expect(world.session.startTime, 'a recorded start time is never overwritten').toBe('Mon Oct 26 09:00:00 2026')
  })
})

describe('argvNamesSession', () => {
  it.each([
    [CLI_ARGV, true],
    [`claude -p --session-id ${SID}`, true],
    [`/opt/bin/claude-2.1 -p -r ${SID}`, true],
    [`claude -r ${SID}`, false],
    [`claude --resume ${SID}`, false],
    [`node /x/cli.js -p --resume=${SID}`, true],
    [`claude -p --resume ${SID} --fork-session`, false],
    [`grep ${SID} /tmp/streams`, false],
    [`claude -p --resume ${SID}0`, false],
    ['', false],
  ])('%s -> %s', (argv, expected) => {
    expect(argvNamesSession(argv, SID)).toBe(expected)
  })

  it('with the spawn args, the live argv must end in exactly them (any program in front)', () => {
    expect(argvNamesSession(CLI_ARGV, SID, SPAWN_ARGS)).toBe(true)
    expect(argvNamesSession(`node /opt/claude/cli.js ${SPAWN_ARGS.slice(1).join(' ')}`, SID, SPAWN_ARGS)).toBe(true)
    expect(argvNamesSession(CLI_ARGV.replace('"A":"1"', '"A":"2"'), SID, SPAWN_ARGS)).toBe(false)
    expect(argvNamesSession(`${CLI_ARGV} --extra`, SID, SPAWN_ARGS)).toBe(false)
    expect(argvNamesSession(`claude -p --resume ${SID}`, SID, SPAWN_ARGS)).toBe(false)
  })
})
