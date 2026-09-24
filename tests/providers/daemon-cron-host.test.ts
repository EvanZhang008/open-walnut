import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: execFileMock, default: { ...actual, execFile: execFileMock } }
})

import {
  cliEnvTrue,
  findCronTranscript,
  probeCronProcess,
  processStartedAtMs,
  readCronCliConfig,
  readCronBootId,
  readCronCliVersion,
} from '../../src/providers/daemon-cron-host.js'

const SID = '3f2c1a9b-4d5e-4f60-8a71-b2c3d4e5f607'
const DEFAULTS = { enabled: true, recurringMaxAgeMs: 604800000, oneShotMaxMs: 90000, oneShotFloorMs: 0, oneShotMinuteMod: 30 }
const ALIVE = { bootId: 'boot-1', pid: 4242, startTime: '8877' }
const LSTART = 'Wed Sep 10 12:00:00 2026'

type ExecReply = { error?: unknown; stdout?: string; stderr?: string }

const signal = () => new AbortController().signal

const features = (oneShotMinuteMod: number) => JSON.stringify({
  cachedGrowthBookFeatures: {
    tengu_kairos_cron_config: { recurringFrac: 0.5, recurringCapMs: 60000, oneShotMaxMs: 90000, oneShotFloorMs: 0, oneShotMinuteMod },
  },
})

const statLine = (state: string, startTime: string) =>
  `4242 (claude (fork)) ${state} 1 ${Array.from({ length: 17 }, (_, i) => String(i + 10)).join(' ')} ${startTime} 0 0\n`

let dirs: string[] = []

const tempDir = async (): Promise<string> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-cron-host-'))
  dirs.push(dir)
  return dir
}

const claudeHome = async (): Promise<string> => {
  const home = await tempDir()
  await fsp.mkdir(path.join(home, 'projects'))
  return home
}

const seed = async (home: string, dir: string): Promise<string> => {
  await fsp.mkdir(path.join(home, 'projects', dir))
  const file = path.join(home, 'projects', dir, `${SID}.jsonl`)
  await fsp.writeFile(file, '{}\n')
  return file
}

type ExecCallback = (e: unknown, out: string, err: string) => void

const replyWith = (reply: ExecReply): void => {
  execFileMock.mockImplementation((_p: string, _a: string[], _o: unknown, cb: ExecCallback) => {
    cb(reply.error ?? null, reply.stdout ?? '', reply.stderr ?? '')
  })
}

const spyProcRead = (result: string | NodeJS.ErrnoException): Mock => {
  const spy = vi.spyOn(fsp, 'readFile') as unknown as Mock
  spy.mockImplementation(() => (typeof result === 'string' ? Promise.resolve(result) : Promise.reject(result)))
  return spy
}

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`fake ${code}`), { code })
const failed = (code: unknown) => Object.assign(new Error('Command failed'), { code })

beforeEach(() => { execFileMock.mockReset() })

afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs) await fsp.rm(dir, { recursive: true, force: true })
  dirs = []
})

describe('cliEnvTrue', () => {
  it('accepts only the documented truthy spellings', () => {
    expect(['1', 'true', 'YES', ' on '].map(cliEnvTrue)).toEqual([true, true, true, true])
    expect(['0', 'false', '', 'maybe', undefined].map(cliEnvTrue)).toEqual([false, false, false, false, false])
  })
})

describe('readCronCliConfig', () => {
  it('prefers .config.json over the legacy .claude.json', async () => {
    const home = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude', '.config.json'), features(7))
    await fsp.writeFile(path.join(home, '.claude.json'), features(11))

    expect((await readCronCliConfig(home, {}, signal())).oneShotMinuteMod).toBe(7)
  })

  it('falls back to the legacy file when .config.json is absent', async () => {
    const home = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude.json'), features(11))

    expect((await readCronCliConfig(home, {}, signal())).oneShotMinuteMod).toBe(11)
  })

  it('reads CLAUDE_CONFIG_DIR instead of the home default', async () => {
    const home = await tempDir()
    const configDir = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude', '.config.json'), features(7))
    await fsp.writeFile(path.join(configDir, '.config.json'), features(13))

    expect((await readCronCliConfig(home, { CLAUDE_CONFIG_DIR: configDir }, signal())).oneShotMinuteMod).toBe(13)
  })

  it('falls back to the shipped defaults when neither file exists', async () => {
    const home = await tempDir()
    expect(await readCronCliConfig(home, {}, signal())).toEqual(DEFAULTS)
  })

  it('refuses a relative CLAUDE_CONFIG_DIR', async () => {
    const home = await tempDir()
    await expect(readCronCliConfig(home, { CLAUDE_CONFIG_DIR: '.claude' }, signal())).rejects.toThrow(/absolute/)
  })

  it('refuses a non-default CLI oauth configuration', async () => {
    const home = await tempDir()
    await expect(readCronCliConfig(home, { CLAUDE_CODE_CUSTOM_OAUTH_URL: '1' }, signal())).rejects.toThrow(/Non-default/)
  })

  it('does not treat corrupt JSON as a missing file', async () => {
    const home = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude', '.config.json'), '{"cachedGrowthBookFeatures"')
    await fsp.writeFile(path.join(home, '.claude.json'), features(11))

    await expect(readCronCliConfig(home, {}, signal())).rejects.toThrow(SyntaxError)
  })

  it('does not treat a non-object payload as a missing file', async () => {
    const home = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude', '.config.json'), '[]')
    await fsp.writeFile(path.join(home, '.claude.json'), features(11))

    await expect(readCronCliConfig(home, {}, signal())).rejects.toThrow(/Invalid CLI configuration/)
  })

  it('does not treat a permission error as a missing file', async () => {
    const home = await tempDir()
    const spy = vi.spyOn(fsp, 'readFile') as unknown as Mock
    spy.mockRejectedValue(errno('EACCES'))

    await expect(readCronCliConfig(home, {}, signal())).rejects.toThrow(/EACCES/)
  })

  it('rejects a cached feature payload that is not an object', async () => {
    const home = await tempDir()
    await fsp.mkdir(path.join(home, '.claude'))
    await fsp.writeFile(path.join(home, '.claude', '.config.json'), '{"cachedGrowthBookFeatures":[]}')

    await expect(readCronCliConfig(home, {}, signal())).rejects.toThrow(/Invalid cached CLI feature/)
  })

  it('honours the real value of CLAUDE_CODE_DISABLE_CRON', async () => {
    const home = await tempDir()
    for (const value of ['1', 'true', 'YES', 'on']) {
      const config = await readCronCliConfig(home, { CLAUDE_CODE_DISABLE_CRON: value }, signal())
      expect(config.enabled, value).toBe(false)
    }
    for (const value of ['0', 'false', '', 'nope', undefined]) {
      const config = await readCronCliConfig(home, { CLAUDE_CODE_DISABLE_CRON: value }, signal())
      expect(config.enabled, String(value)).toBe(true)
    }
  })
})

describe('boot and CLI version probes', () => {
  it('reads only the kernel boot identity on Linux', async () => {
    const spy = spyProcRead('boot-a\n')
    expect(await readCronBootId('linux', signal())).toBe('boot-a')
    expect(spy.mock.calls[0][0]).toBe('/proc/sys/kernel/random/boot_id')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('uses bounded, locale-stable commands on macOS', async () => {
    replyWith({ stdout: 'boot-b\n' })
    expect(await readCronBootId('darwin', signal())).toBe('boot-b')
    expect(execFileMock).toHaveBeenCalledWith('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], expect.objectContaining({ timeout: 5000, env: expect.objectContaining({ LANG: 'C', LC_ALL: 'C' }) }), expect.any(Function))
  })

  it('accepts only the expected CLI version banner', async () => {
    replyWith({ stdout: '2.1.258 (Claude Code)\n' })
    expect(await readCronCliVersion('/opt/cli', signal())).toBe('2.1.258')
    expect(execFileMock.mock.calls[0][1]).toEqual(['--version'])
    replyWith({ stdout: 'another command 2.1.258' })
    await expect(readCronCliVersion('/opt/cli', signal())).rejects.toThrow('Unrecognized')
  })

  it('does not enable cron restoration under interrupted-turn replay', async () => {
    const home = await tempDir()
    expect((await readCronCliConfig(home, { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: 'true' }, signal())).enabled).toBe(false)
    expect((await readCronCliConfig(home, { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: 'false' }, signal())).enabled).toBe(true)
  })
})

describe('findCronTranscript', () => {
  it('refuses anything that is not a canonical session uuid', async () => {
    const home = await claudeHome()
    for (const bad of ['not-a-uuid', `${SID}x`, SID.replace(/-/g, ''), '']) {
      await expect(findCronTranscript(bad, '/repo', home, signal())).rejects.toThrow(/Invalid session id/)
    }
  })

  it('encodes the cwd the way the CLI names its project directory', async () => {
    const home = await claudeHome()
    const file = await seed(home, '-home-walnut-repo')

    expect(await findCronTranscript(SID, '/home/walnut/repo', home, signal())).toBe(file)
  })

  it('encodes non-ASCII path segments one dash per character', async () => {
    const home = await claudeHome()
    const file = await seed(home, '-Users-----')

    expect(await findCronTranscript(SID, '/Users/\u4f8b/\u9879\u76ee', home, signal())).toBe(file) // CJK path segments ("example", "project")
  })

  it('takes the direct hit before scanning, so a duplicate elsewhere is ignored', async () => {
    const home = await claudeHome()
    const file = await seed(home, '-home-walnut-repo')
    await seed(home, 'other')

    expect(await findCronTranscript(SID, '/home/walnut/repo', home, signal())).toBe(file)
  })

  it('scans instead of guessing once the encoded name is too long', async () => {
    const home = await claudeHome()
    const long = 'a'.repeat(205)
    await seed(home, `-${long}`)
    await seed(home, 'other')

    await expect(findCronTranscript(SID, `/${long}`, home, signal())).rejects.toThrow(/Multiple canonical/)
  })

  it('refuses to choose between two matching transcripts', async () => {
    const home = await claudeHome()
    await seed(home, 'alpha')
    await seed(home, 'beta')

    await expect(findCronTranscript(SID, '/nowhere', home, signal())).rejects.toThrow(/Multiple canonical/)
  })

  it('reports a missing transcript as ENOENT', async () => {
    const home = await claudeHome()
    await seed(home, 'alpha')
    await fsp.rm(path.join(home, 'projects', 'alpha', `${SID}.jsonl`))

    const error = await findCronTranscript(SID, '/nowhere', home, signal()).catch((e: unknown) => e)
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT')
    expect((error as Error).message).toMatch(/missing/)
  })

  it('does not report an unreadable candidate as missing', async () => {
    const home = await claudeHome()
    await seed(home, '-home-walnut-repo')
    const spy = vi.spyOn(fsp, 'stat') as unknown as Mock
    spy.mockRejectedValue(errno('EACCES'))

    const error = await findCronTranscript(SID, '/home/walnut/repo', home, signal()).catch((e: unknown) => e)
    expect((error as NodeJS.ErrnoException).code).toBe('EACCES')
  })
})

describe('probeCronProcess', () => {
  it('answers unknown without touching the host when the identity is unusable', async () => {
    const spy = spyProcRead(statLine('S', '8877'))
    const cases: (typeof ALIVE | null)[] = [
      null,
      { ...ALIVE, pid: 1 },
      { ...ALIVE, pid: 0 },
      { ...ALIVE, pid: 4242.5 },
    ]
    for (const expected of cases) {
      expect(await probeCronProcess(expected, 'boot-1', 'linux', signal())).toEqual({ status: 'unknown' })
    }
    expect(await probeCronProcess(ALIVE, '', 'linux', signal())).toEqual({ status: 'unknown' })
    expect(spy).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('calls a process from a previous boot dead without probing it', async () => {
    const spy = spyProcRead(statLine('S', '8877'))
    expect(await probeCronProcess(ALIVE, 'boot-2', 'linux', signal())).toEqual({ status: 'dead' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('answers unknown on a platform it cannot inspect', async () => {
    expect(await probeCronProcess(ALIVE, 'boot-1', 'win32', signal())).toEqual({ status: 'unknown' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('reads the start time out of /proc past a comm containing spaces and parens', async () => {
    const spy = spyProcRead(statLine('S', '8877'))
    expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal())).toEqual({
      status: 'alive',
      identity: { bootId: 'boot-1', pid: 4242, startTime: '8877' },
    })
    expect(spy.mock.calls[0][0]).toBe('/proc/4242/stat')
  })

  it('calls a reaped process dead', async () => {
    for (const state of ['Z', 'X']) {
      spyProcRead(statLine(state, '8877'))
      expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal()), state).toEqual({ status: 'dead' })
      vi.restoreAllMocks()
    }
  })

  it('calls a recycled pid unknown rather than dead', async () => {
    spyProcRead(statLine('S', '9999'))
    expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal())).toEqual({ status: 'unknown' })
  })

  it('answers unknown on a stat line it cannot parse', async () => {
    spyProcRead('4242 (claude) S 1 2 3\n')
    expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal())).toEqual({ status: 'unknown' })
  })

  it('calls a vanished /proc entry dead and an unreadable one unknown', async () => {
    spyProcRead(errno('ENOENT'))
    expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal())).toEqual({ status: 'dead' })
    vi.restoreAllMocks()
    spyProcRead(errno('EACCES'))
    expect(await probeCronProcess(ALIVE, 'boot-1', 'linux', signal())).toEqual({ status: 'unknown' })
  })

  it('asks ps for the start time on darwin', async () => {
    replyWith({ stdout: `${LSTART}\n` })
    const probe = await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())

    expect(execFileMock.mock.calls[0][0]).toBe('/bin/ps')
    expect(execFileMock.mock.calls[0][1]).toEqual(['-p', '4242', '-o', 'lstart='])
    expect(probe).toEqual({ status: 'alive', identity: { bootId: 'boot-1', pid: 4242, startTime: LSTART } })
  })

  it('calls an empty ps listing dead', async () => {
    replyWith({ stdout: '\n' })
    expect(await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())).toEqual({ status: 'dead' })
  })

  it('calls a plain ps exit 1 dead', async () => {
    replyWith({ error: failed(1) })
    expect(await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())).toEqual({ status: 'dead' })
  })

  it('does not call a failed ps dead when it printed a diagnostic', async () => {
    replyWith({ error: failed(1), stderr: 'ps: permission denied\n' })
    expect(await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())).toEqual({ status: 'unknown' })
  })

  it('answers unknown when ps is killed by the timeout', async () => {
    replyWith({ error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) })
    expect(await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())).toEqual({ status: 'unknown' })
  })

  it('calls a recycled pid unknown on darwin too', async () => {
    replyWith({ stdout: 'Thu Sep 11 09:30:00 2026\n' })
    expect(await probeCronProcess({ ...ALIVE, startTime: LSTART }, 'boot-1', 'darwin', signal())).toEqual({ status: 'unknown' })
  })
})

// A pid with no /proc entry on any platform, so the string branch is what runs
// (Linux pids stop far below this, and macOS has no /proc at all).
const NO_PROC_PID = 999_999_999

describe('processStartedAtMs', () => {
  it('reads the absolute start out of a ps lstart string', () => {
    expect(processStartedAtMs(NO_PROC_PID, 'Wed Sep 10 12:00:00 2026')).toBe(Date.parse('Wed Sep 10 12:00:00 2026'))
    expect(processStartedAtMs(NO_PROC_PID, '  Wed Sep 10 12:00:00 2026  ')).toBe(Date.parse('Wed Sep 10 12:00:00 2026'))
  })

  it('refuses a value that is not an absolute date', () => {
    // Linux field 22 is a tick count since boot: parsing it as a date would put
    // the process start in a nonsense year and make every line look current.
    expect(processStartedAtMs(NO_PROC_PID, '43793383')).toBeNull()
    expect(processStartedAtMs(NO_PROC_PID, 'not-a-date')).toBeNull()
    expect(processStartedAtMs(NO_PROC_PID, '')).toBeNull()
    expect(processStartedAtMs(NO_PROC_PID, null)).toBeNull()
    // Spelled with a zone: a bare local-time epoch string is a positive number
    // of ms in every zone west of UTC, so it would not exercise the floor.
    expect(processStartedAtMs(NO_PROC_PID, 'Thu Jan 1 1970 00:00:00 GMT')).toBeNull()
    expect(processStartedAtMs(NO_PROC_PID, new Date(Date.now() + 3_600_000).toISOString())).toBeNull()
  })

  it('refuses a pid that cannot be a real child', () => {
    expect(processStartedAtMs(null, 'Wed Sep 10 12:00:00 2026')).toBeNull()
    expect(processStartedAtMs(0, 'Wed Sep 10 12:00:00 2026')).toBeNull()
    expect(processStartedAtMs(1, 'Wed Sep 10 12:00:00 2026')).toBeNull()
  })

  it.skipIf(process.platform !== 'linux')('prefers the live /proc entry over the recorded string', () => {
    const fromProc = processStartedAtMs(process.pid, 'Wed Sep 10 12:00:00 2026')
    expect(fromProc).not.toBeNull()
    expect(fromProc).toBeLessThanOrEqual(Date.now())
    expect(fromProc).toBeGreaterThan(Date.now() - (os.uptime() + 60) * 1000)
    expect(fromProc).not.toBe(Date.parse('Wed Sep 10 12:00:00 2026'))
  })

  it.skipIf(process.platform === 'linux')('has no /proc to read, so the recorded string is all there is', () => {
    expect(processStartedAtMs(process.pid, null)).toBeNull()
    expect(processStartedAtMs(process.pid, 'Wed Sep 10 12:00:00 2026')).toBe(Date.parse('Wed Sep 10 12:00:00 2026'))
  })
})
