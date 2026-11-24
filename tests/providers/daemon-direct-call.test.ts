/**
 * A client in the daemon runtime's own process calls the commands the runtime answers by function
 * (DaemonClient.call, daemon-standalone.ts callCommand) instead of sending them as frames.
 *
 * Behavior (fixtures/daemon-direct-call.ts, a real runtime under bun): for commands of every area
 * the direct call's reply equals the frame's reply on the same runtime; a throwing handler gives
 * one error both ways; a Demo's fenced gate refuses both ways; no command is answered twice; a
 * command not in the table is not called; a closed client refuses a call.
 *
 * Guards (source text): every command in the table is answered only through answerCommand (no
 * case of dispatchCommand names one), and the gates have one copy (passCommandGates), which both
 * handleCommandFrame and callCommand run; the in-process client holds no gate of its own.
 */
import { describe, expect, it, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answerTableCommands } from '../helpers/daemon-runtime-text.js'

const ROOT = path.resolve(__dirname, '../..')
const PROVIDERS = path.join(ROOT, 'src/providers')
const FIXTURE = path.resolve(__dirname, 'fixtures/daemon-direct-call.ts')
const BUN = process.versions.bun ? process.execPath : null
const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })

type Pair = [Record<string, unknown>, Record<string, unknown> | string]

describe.skipIf(!BUN)('direct calls to the daemon runtime in this process', () => {
  let out: Record<string, unknown>
  it('runs the fixture', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-direct-call-'))
    roots.push(root)
    const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const child = execFile(BUN!, [FIXTURE, root], { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 }, (error, so, se) => {
        resolve({ stdout: String(so), stderr: String(se), code: error ? (typeof error.code === 'number' ? error.code : null) : 0 })
      })
      child.stdin?.end()
    })
    expect(code, stderr.slice(-2000)).toBe(0)
    out = JSON.parse(stdout.trim().split('\n').pop()!)
  }, 120_000)

  it('answers each command the same both ways, for every area', () => {
    const cases = out.cases as Record<string, Pair>
    const same = ['fsRead', 'fsReadMissingPath', 'fsReadThrows', 'fsStatMissing', 'fsLs', 'fsReadRange', 'fsWrite',
      'gitStatus', 'gitDiffMissingCwd', 'gitCommitJob', 'changesMissingSid', 'changesUnknownSid', 'rewindMissingSid',
      'readyKeys', 'skillsProbe', 'hooksInvalid', 'triggersAckUnknown', 'triggersRunUnknown', 'secretsList',
      'transferRealpath', 'transferRealpathMissing', 'hubStatus']
    for (const name of same) expect(cases[name]![1], name).toEqual(cases[name]![0])
    // The answers are the commands' own, not a refusal of the path.
    expect(cases.fsRead![1]).toEqual({ ok: true, data: 'hello direct call\n', encoding: 'utf-8' })
    expect(cases.fsReadMissingPath![1]).toEqual({ ok: false, error: 'fs.read: missing path' })
    expect(cases.fsStatMissing![1]).toEqual({ ok: true, exists: false })
    expect(cases.fsWrite![1]).toMatchObject({ ok: true, written: true, size: 3 })
    expect(cases.fsWritten).toEqual(['abc', 'abc'])
    expect(cases.gitStatus![1]).toMatchObject({ ok: true, repos: [expect.objectContaining({ untracked: 1 })] })
    expect(cases.gitCommitJob![1]).toEqual({ ok: true, job: null })
    expect(cases.changesUnknownSid![1]).toEqual({ ok: true, found: false, result: null })
    expect(cases.skillsProbe![1]).toEqual({ ok: true, held: false })
    expect(cases.triggersAckUnknown![1]).toEqual({ ok: true, acked: false })
    expect(cases.transferRealpathMissing![1]).toMatchObject({ ok: false, code: 'not_found' })
    // Two pushes with new hashes: each one changes the rules.
    expect(cases.hooksValid).toEqual([{ ok: true, applied: true, changed: true, hash: 'h1' }, { ok: true, applied: true, changed: true, hash: 'h2' }])
  })

  it('turns a handler that throws into one error reply, the same both ways', () => {
    const [frame, direct] = (out.cases as Record<string, Pair>).fsReadThrows!
    expect(frame).toMatchObject({ ok: false, error: expect.stringMatching(/^internal daemon error handling fs\.read: /) })
    expect(direct).toEqual(frame)
  })

  it('answers no command twice, and calls none it does not answer by function', () => {
    expect(out.extra).toEqual([])
    expect((out.cases as Record<string, Pair>).listNotDirect).toEqual([{ ok: true, sessions: [] }, 'not-direct'])
    expect(out.callAfterClose).toBe('in-process daemon client is closed')
    expect([out.stopA, out.stopD]).toEqual([0, 0])
  })

  it("refuses through the same gate both ways (a fenced Demo's daemon)", () => {
    expect(out.quiesce).toMatchObject({ ok: true, quiet: true })
    const demo = out.demo as Record<string, Pair>
    const refusal = { ok: false, error: 'Demo is stopping; no new work is accepted', errorKind: 'demo_stopping' }
    expect(demo.write).toEqual([refusal, refusal])
    expect(demo.read).toEqual([refusal, refusal])
    // exec.list is a read the fence lets through, both ways.
    expect(demo.execList![1]).toEqual(demo.execList![0])
    expect(demo.execList![0]).toMatchObject({ ok: true })
    expect(out.demoWrote).toBe(false)
  })
})

/** The body of `function <name>(` in `src`, to the next line starting a top-level declaration. */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`)
  expect(start, name).toBeGreaterThan(-1)
  const next = src.slice(start + 1).search(/\n(function |const |let |\/\*\*|\/\/ ──)/)
  return src.slice(start, next < 0 ? undefined : start + 1 + next)
}

describe('the command table has one way in and the gates one copy', () => {
  const standalone = fs.readFileSync(path.join(PROVIDERS, 'daemon-standalone.ts'), 'utf8')
  const names = answerTableCommands()

  it('finds the table of every area', () => {
    for (const name of ['fs.read', 'fs.write', 'git.status', 'changes.compute', 'git.commitJob', 'transcript.rewindProbe',
      'turns.configure', 'skills.sync', 'hooks.configure', 'triggers.ack', 'hub.status', 'workspace.runScript', 'exec.run', 'transfer.pack']) {
      expect(names, name).toContain(name)
    }
    // Every area module that answers by function is in the runtime's table.
    for (const area of ['fsRead', 'fsWrite', 'git', 'sessionChanges', 'transcripts', 'hostServices', 'hooks', 'triggerCommands', 'skills']) {
      expect(standalone).toContain(`${area}.answers]`)
    }
  })

  it('no case of dispatchCommand names a table command: they are answered through answerCommand only', () => {
    const dispatch = bodyOf(standalone, 'dispatchCommand')
    const cases = [...dispatch.matchAll(/case '([^']+)'/g)].map((m) => m[1]!)
    expect(cases.length).toBeGreaterThan(50)
    expect(cases.filter((c) => names.includes(c))).toEqual([])
    // Before the switch: the table's commands go to answerCommand, whose Answer is the reply frame.
    expect(dispatch.indexOf('answerCommand(')).toBeGreaterThan(-1)
    expect(dispatch.indexOf('answerCommand(')).toBeLessThan(dispatch.indexOf('switch (cmd.cmd)'))
    // A table command never answers on the socket itself: no reply helper in a module that has answers.
    for (const f of fs.readdirSync(PROVIDERS).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(PROVIDERS, f), 'utf8')
      if (!/const answers: Answers</.test(src)) continue
      const body = src.slice(src.indexOf('const answers: Answers<'))
      expect(body.slice(0, body.indexOf('\n  }\n')), f).not.toMatch(/sendOk|sendError|\(ws, id/)
    }
  })

  it('the gates are one function both ways in run, and the client holds none', () => {
    const gates = bodyOf(standalone, 'passCommandGates')
    for (const gate of ['adoptCommandHome(', 'BRIDGE_ALLOWED_COMMANDS', 'BRIDGE_SESSION_COMMANDS', 'FOLLOWER_ALLOWED_COMMANDS', 'followerScope(', 'LANE_ALLOWED_COMMANDS', 'demoQuiesce.allows(']) {
      expect(gates, gate).toContain(gate)
    }
    const frame = bodyOf(standalone, 'handleCommandFrame')
    const call = bodyOf(standalone, 'callCommand')
    for (const [name, body] of [['handleCommandFrame', frame], ['callCommand', call]] as const) {
      expect(body, name).toContain('passCommandGates(')
      expect(body, name).toContain('admitCommand(')
      for (const gate of ['ALLOWED_COMMANDS', 'adoptCommandHome(', 'demoQuiesce.allows(', 'daemonCommands.admit(']) expect(body, `${name}: ${gate}`).not.toContain(gate)
    }
    // Each gate's set is read in passCommandGates only.
    for (const set of ['BRIDGE_ALLOWED_COMMANDS.has(', 'FOLLOWER_ALLOWED_COMMANDS.has(', 'LANE_ALLOWED_COMMANDS.has(', 'demoQuiesce.allows(']) {
      expect(standalone.split(set).length - 1, set).toBe(1)
    }
    const client = fs.readFileSync(path.join(PROVIDERS, 'daemon-in-process-client.ts'), 'utf8')
    expect(client).not.toMatch(/ALLOWED_COMMANDS|origin|demo|admit|adoptCommandHome|walnutScope/)
  })
})
