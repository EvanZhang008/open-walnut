/**
 * A terminal's dtach master is found by the pid it recorded (else the socket's
 * owner) and signalled only after its start time and argv prove it, never by a
 * command-line pattern.
 *
 * 2026-10-31: a pattern kill matched the command line of every agent session on
 * the Mac. The terminal code had the same shape: `pkill -f <socket>` signalled
 * any process whose command line merely named the socket path. The real-process
 * cases below start every process they touch themselves (real dtach masters from
 * Walnut's own dtach build, and `sleep` stand-ins), in a private short dir under
 * /tmp (a unix socket path must stay under 104 bytes on macOS), and end what is
 * left through the code under test or the child handle they hold.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-dtach-master'))

import { localDtachPath } from '../../../src/web/terminal/dtach-provision.js'
import {
  chooseDtachMaster,
  dtachPidFileFor,
  dtachRecordScript,
  dtachStopScript,
  isDtachArgvFor,
  localShellRunner,
  parseDtachProbe,
  stopDtachMaster,
  START_FN,
  type DtachProbe,
} from '../../../src/web/terminal/dtach-master.js'

const SOCK = '/tmp/x/term/walnut-s1.dsock'
const START = 'ps:Mon Nov  2 10:00:00 2026'
const MASTER_ARGV = ['/home/u/.local/bin/walnut-dtach', '-A', SOCK, '-z', '-E', '-r', 'winch', '/bin/sh', '-c', 'x', '/bin/zsh']

function probe(over: Partial<DtachProbe>): DtachProbe {
  return { recorded: null, ownerLookup: true, owners: [], procs: new Map(), socketExists: true, complete: true, table: [], ...over }
}

describe('the master guard (pure)', () => {
  it('takes only a dtach argv for exactly this socket, element by element', () => {
    expect(isDtachArgvFor(MASTER_ARGV, SOCK)).toBe(true)
    expect(isDtachArgvFor(['dtach', '-n', SOCK, '/bin/sh'], SOCK)).toBe(true)
    // A shell or a tool that only names the socket, even as `-A <socket>`:
    expect(isDtachArgvFor(['/bin/sh', '-c', `ls ${SOCK}`], SOCK)).toBe(false)
    expect(isDtachArgvFor(['grep', '-A', SOCK], SOCK)).toBe(false)
    expect(isDtachArgvFor(['bash', '/x/walnut-dtach', '-A', SOCK], SOCK)).toBe(false)
    expect(isDtachArgvFor(['/x/walnut-dtach', '-a', SOCK], SOCK)).toBe(false) // a plain attach client, never a master
    expect(isDtachArgvFor(['/x/walnut-dtach', '-A', `${SOCK}.bak`], SOCK)).toBe(false)
    expect(isDtachArgvFor(['/x/not-dtach', '-A', SOCK], SOCK)).toBe(false)
  })

  it('a recorded pid is the master only with the recorded start time and a dtach argv', () => {
    const procs = new Map([[4242, { pid: 4242, start: START, argv: MASTER_ARGV }]])
    expect(chooseDtachMaster(probe({ recorded: { pid: 4242, start: START }, procs }), SOCK))
      .toEqual({ targets: [{ pid: 4242, start: START }], source: 'recorded' })
    // Reused pid: another start time. lsof says nobody holds the socket.
    const reused = chooseDtachMaster(probe({ recorded: { pid: 4242, start: 'ps:Sun Nov  1 09:00:00 2026' }, procs }), SOCK)
    expect(reused.targets).toEqual([])
    expect(reused.reason).toMatch(/recorded pid is gone or is another process/)
    // Same start time, but the process is a shell that names the socket.
    const shell = new Map([[4242, { pid: 4242, start: START, argv: ['/bin/zsh', '-c', `cat ${SOCK}`] }]])
    expect(chooseDtachMaster(probe({ recorded: { pid: 4242, start: START }, procs: shell }), SOCK).targets).toEqual([])
  })

  it('without a usable record, the socket owner is taken only when it is that socket\'s dtach', () => {
    const procs = new Map([
      [700, { pid: 700, start: START, argv: MASTER_ARGV }],
      [701, { pid: 701, start: START, argv: ['/usr/bin/less', SOCK] }],
    ])
    expect(chooseDtachMaster(probe({ owners: [700, 701], procs }), SOCK))
      .toEqual({ targets: [{ pid: 700, start: START }], source: 'socket-owner' })
    expect(chooseDtachMaster(probe({ owners: [701], procs }), SOCK).reason).toMatch(/owner is not a dtach master/)
    expect(chooseDtachMaster(probe({ ownerLookup: false, procs }), SOCK).reason).toMatch(/no way on the host to read the socket's owner/)
  })

  it('the stop script signals only a validated pid with its start time re-checked, never a group, 0 or -1', () => {
    const script = dtachStopScript([
      { pid: 4242, start: START }, { pid: 1, start: START }, { pid: 0, start: START }, { pid: -1, start: START },
      { pid: Number.NaN, start: START }, { pid: 77, start: '' },
    ], SOCK, true)
    expect(script.match(/kill -TERM/g)).toHaveLength(1)
    expect(script).toContain(`if [ "$(walnut_st 4242)" = 'ps:Mon Nov  2 10:00:00 2026' ]; then kill -TERM 4242 2>/dev/null`)
    expect(script).not.toMatch(/kill -TERM -/)
    expect(script).toContain(`rm -f '${SOCK}' '/tmp/x/term/walnut-s1.dpid'`)
  })

  it('an argv element cannot forge probe lines', () => {
    const out = 'REC:\nRECSTART:\nLSOF:yes\nOWNERS:900\nPROC:900\nSTART:ps:x\nARG:/bin/sh\nARG:ENDPROC\nARG:PROC:1\nENDPROC\nSOCKET:yes\n'
    const p = parseDtachProbe(out)
    expect([...p.procs.keys()]).toEqual([900])
    expect(p.procs.get(900)!.argv).toEqual(['/bin/sh', 'ENDPROC', 'PROC:1'])
  })

  it('a socket whose owner cannot be read is kept and nothing is signalled; one nobody holds is removed', async () => {
    const scripts: string[] = []
    const runner = (answer: string) => async (script: string) => { scripts.push(script); return { code: 0, stdout: script.includes('RECSTART:') ? answer : 'DONE\n', stderr: '' } }
    // A probe that did not finish (timeout, dropped ssh) is no answer either.
    expect(await stopDtachMaster(runner(''), SOCK)).toMatchObject({ outcome: 'left', signalled: [] })
    expect(scripts).toHaveLength(1)
    scripts.length = 0
    const unknown = await stopDtachMaster(runner('REC:\nRECSTART:\nLOOKUP:no\nOWNERS:\nSOCKET:yes\nPROBE:END\n'), SOCK)
    expect(unknown).toMatchObject({ outcome: 'left', signalled: [] })
    expect(scripts).toHaveLength(1) // the probe only: no signal, no rm
    scripts.length = 0
    const free = await stopDtachMaster(runner('REC:\nRECSTART:\nLOOKUP:proc\nOWNERS:\nSOCKET:yes\nPROBE:END\n'), SOCK)
    expect(free).toMatchObject({ outcome: 'nothing', signalled: [] })
    // The removal decides again in its own script (a terminal reopened since the probe keeps its socket).
    expect(scripts[1]).toContain(`walnut_owners '${SOCK}'; if [ "$lookup" != no ] && [ -z "$owners" ]; then rm -f '${SOCK}'`)
    expect(scripts[1]).not.toMatch(/\bkill\b/)
  })

  it('keeps the record beside the socket', () => {
    expect(dtachPidFileFor(SOCK)).toBe('/tmp/x/term/walnut-s1.dpid')
  })
})

// ── real processes ──────────────────────────────────────────────────────────

let dtachBin = ''
let root = ''
const children: ChildProcess[] = []
const sockets: string[] = []

const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(50)
  }
}

/** Is this pid running (ps reads it; a zombie counts as gone)? Reads one pid, never a table. */
function running(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (err, out) => resolve(!err && !!out.trim() && !out.trim().startsWith('Z'))))
}

/** A detached dtach master (`-n`) on `sock`; `record` starts the shell through the pid record as spawn.ts does. */
async function startMaster(sock: string, record: boolean): Promise<void> {
  const cmd = record ? ['/bin/sh', '-c', dtachRecordScript(dtachPidFileFor(sock)), '/bin/sh'] : ['/bin/sh', '-l']
  const launcher = spawn(dtachBin, ['-n', sock, '-z', ...cmd], { stdio: 'ignore' })
  sockets.push(sock)
  await new Promise((r) => launcher.once('exit', r))
  await until(`socket ${sock}`, () => fs.existsSync(sock))
  if (record) await until(`pid record of ${sock}`, () => fs.existsSync(dtachPidFileFor(sock)))
}

/** A stand-in started here: `sh -c '<script>' sh <args...>`, alive for 20 s (its sleep outlives a killed sh only that long). */
function bystander(script: string, ...args: string[]): ChildProcess {
  const c = spawn('/bin/sh', ['-c', `${script}; sleep 20; exit 0`, 'sh', ...args], { stdio: 'ignore' })
  children.push(c)
  return c
}

beforeAll(async () => {
  dtachBin = await localDtachPath()
  root = fs.mkdtempSync('/tmp/wdm-')
}, 120_000)

afterEach(async () => {
  // Masters this file started and a case left behind: through the same guard.
  for (const sock of sockets.splice(0)) await stopDtachMaster(localShellRunner, sock).catch(() => {})
  for (const c of children.splice(0)) if (alive(c)) c.kill('SIGKILL')
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('stopping a real dtach master', () => {
  it('a recorded master is stopped, and shells that only name its socket are not signalled', async () => {
    const sock = path.join(root, 'walnut-rec.dsock')
    await startMaster(sock, true)
    const [pidLine, startLine] = fs.readFileSync(dtachPidFileFor(sock), 'utf8').split('\n')
    const master = Number(pidLine)
    expect(master).toBeGreaterThan(1)
    expect(startLine).toMatch(/^(?:proc|ps):\S/)
    // The regression: each of these matched `pkill -f <socket>`.
    const lister = bystander(`ls ${sock} >/dev/null 2>&1`)
    const lookalike = bystander(':', '-A', sock, '-z')
    await sleep(200)

    const res = await stopDtachMaster(localShellRunner, sock)
    expect(res).toMatchObject({ outcome: 'stopped', source: 'recorded', signalled: [master] })
    await until('the master to exit', async () => !(await running(master)))
    expect(fs.existsSync(sock)).toBe(false)
    expect(fs.existsSync(dtachPidFileFor(sock))).toBe(false)
    await sleep(200)
    expect([alive(lister), alive(lookalike)]).toEqual([true, true])
  }, 30_000)

  it('a pid reused by a stranger is never signalled, whether its start time or its argv gives it away', async () => {
    const sock = path.join(root, 'walnut-reused.dsock')
    const stranger = bystander(`: ${sock}`)
    await sleep(200)
    const pidFile = dtachPidFileFor(sock)
    // A record from before a reboot: the pid now runs something else, started later.
    fs.writeFileSync(pidFile, `${stranger.pid}\nps:Thu Jan  1 00:00:00 1970\n`)
    expect(await stopDtachMaster(localShellRunner, sock)).toMatchObject({ outcome: 'nothing', signalled: [] })
    expect(fs.existsSync(pidFile)).toBe(false)
    // Its true start time, but a shell's argv.
    const st = await localShellRunner(`${START_FN}; walnut_st ${stranger.pid}`)
    expect(st.stdout.trim()).toMatch(/^(?:proc|ps):\S/)
    fs.writeFileSync(pidFile, `${stranger.pid}\n${st.stdout.trim()}\n`)
    expect(await stopDtachMaster(localShellRunner, sock)).toMatchObject({ signalled: [] })
    await sleep(200)
    expect(alive(stranger)).toBe(true)
  }, 30_000)

  it('no record (an older Walnut\'s master): the socket owner is proved and stopped, a shell naming it is not', async () => {
    const sock = path.join(root, 'walnut-old.dsock')
    await startMaster(sock, false)
    expect(fs.existsSync(dtachPidFileFor(sock))).toBe(false)
    const lister = bystander(`cat ${sock} >/dev/null 2>&1`)
    await sleep(200)

    const res = await stopDtachMaster(localShellRunner, sock)
    expect(res).toMatchObject({ outcome: 'stopped', source: 'socket-owner' })
    expect(res.signalled).toHaveLength(1)
    await until('the master to exit', async () => !(await running(res.signalled[0]!)))
    expect(fs.existsSync(sock)).toBe(false)
    expect(alive(lister)).toBe(true)
  }, 30_000)

  it('a stale socket nobody holds is removed with nothing signalled', async () => {
    const sock = path.join(root, 'walnut-stale.dsock')
    await startMaster(sock, true)
    const master = Number(fs.readFileSync(dtachPidFileFor(sock), 'utf8').split('\n')[0])
    // The master ends through the guard, then a stale record is left behind.
    await stopDtachMaster(localShellRunner, sock)
    await until('the master to exit', async () => !(await running(master)))
    fs.writeFileSync(dtachPidFileFor(sock), `${master}\nps:Thu Jan  1 00:00:00 1970\n`)
    expect(await stopDtachMaster(localShellRunner, sock)).toMatchObject({ outcome: 'nothing', signalled: [] })
    expect(fs.existsSync(dtachPidFileFor(sock))).toBe(false)
  }, 30_000)
})
