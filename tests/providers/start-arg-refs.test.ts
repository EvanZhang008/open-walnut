/**
 * start-arg-refs.ts (the server side) with the daemon's own copies (createCliArgvFiles
 * resolveRefs/rememberRefs), wired as a daemon's cmdStart wires them.
 *
 * 2026-11-13: after a wake, 14 resumed sessions on one host each sent about 140 KB of start
 * arguments (hook scripts, the session prompt) again, 3.3 MB on one link in 16 minutes, and the
 * relay on the SSH path ended it. Pinned: a start sent once makes the next one (and one sent
 * after a lost answer) name its long arguments by hash; a copy the host lacks is answered
 * ARG_REFS_MISSING and only that argument goes again in full; an argument that reads as a ref
 * goes as it is; a tampered copy is no copy; the two mirrored values match.
 * MACHINE SAFETY: every file lives in a temp dir this file makes and removes.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createCliArgvFiles } from '../../src/providers/cli-argv-files-core.js'
import { sendStartWithRefs, argRefHash, ARG_REF_TOKEN, ARG_REF_MIN_CHARS, START_ARG_REFS_CAPABILITY, _resetStartArgRefsForTesting } from '../../src/providers/start-arg-refs.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const dirs: string[] = []
beforeEach(() => _resetStartArgRefsForTesting())
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** A daemon's start as cmdStart runs it: refs back from copies, copies kept, then the start. */
function daemon(now = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arg-refs-'))
  dirs.push(root)
  const af = createCliArgvFiles({ fs: fs as never, path, crypto, dir: path.join(root, 'argv'), now })
  const started: string[][] = []
  const frames: number[] = []
  const send = async (p: Record<string, unknown>) => {
    frames.push(JSON.stringify(p).length)
    let args = (p.args as unknown[]).map(String)
    if (p.argRefs === true) {
      const r = af.resolveRefs(args)
      if (r.missing.length) return { ok: false, code: 'ARG_REFS_MISSING', missingRefs: r.missing, error: 'missing' }
      af.rememberRefs(r.args)
      args = r.args
    }
    started.push(af.inlineArgs(args))
    return { ok: true, pid: 1 }
  }
  const copy = (value: string) => path.join(root, 'argv', 'refs', argRefHash(value) + '.arg')
  return { root, af, started, frames, send, copy }
}

const HOOK = 'x'.repeat(30_000)
const SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: HOOK }, { command: 'short' }] }] } })
const PROMPT = 'p'.repeat(20_000)
const argsFor = (sid: string) => ['claude', '--settings', SETTINGS, '--append-system-prompt', PROMPT, '--resume', sid]

describe('start arg refs', () => {
  it('a start sent once makes the next name its long arguments by hash; each host on its own', async () => {
    const d = daemon()
    await sendStartWithRefs('h', { sid: 'a', args: argsFor('a') }, d.send)
    await sendStartWithRefs('h', { sid: 'b', args: argsFor('b') }, d.send)
    expect(d.frames[0]).toBeGreaterThan(50_000)
    expect(d.frames[1]).toBeLessThan(1_000)
    // What the daemon starts is the inline form the caller gave, both times.
    expect(d.started).toEqual([argsFor('a'), argsFor('b')])
    await sendStartWithRefs('other', { sid: 'c', args: argsFor('c') }, d.send)
    expect(d.frames[2]).toBeGreaterThan(50_000)
  })

  it('starts sent side by side name what the first carries, and a start whose answer was lost counts as sent', async () => {
    const d = daemon()
    // Sent together: the daemon reads them in order on one socket, so the first one's copies serve the rest.
    const all = await Promise.all(['a', 'b', 'c'].map((sid) => sendStartWithRefs('h', { sid, args: argsFor(sid) }, d.send)))
    expect(all.every((r) => r.ok)).toBe(true)
    expect(d.frames[0]).toBeGreaterThan(50_000)
    expect(d.frames.slice(1).every((n) => n < 1_000)).toBe(true)
    // A link that dropped before the host read the frame: the next start names it, is told it is missing, and sends it.
    const lost = daemon()
    await expect(sendStartWithRefs('h2', { sid: 'a', args: argsFor('a') }, () => Promise.reject(new Error('connection closed')))).rejects.toThrow('connection closed')
    expect(await sendStartWithRefs('h2', { sid: 'b', args: argsFor('b') }, lost.send)).toMatchObject({ ok: true })
    expect(lost.frames[0]).toBeLessThan(1_000)
    expect(lost.frames[1]).toBeGreaterThan(50_000)
    expect(lost.started).toEqual([argsFor('b')])
  })

  it('only the copy the host lost goes again in full', async () => {
    const d = daemon()
    await sendStartWithRefs('h', { sid: 'a', args: argsFor('a') }, d.send)
    fs.rmSync(d.copy(PROMPT))
    expect(await sendStartWithRefs('h', { sid: 'b', args: argsFor('b') }, d.send)).toMatchObject({ ok: true })
    expect(d.frames).toHaveLength(3)
    expect(d.frames[1]).toBeLessThan(1_000)
    // The prompt (20 KB) again, the hook (30 KB) still by hash.
    expect(d.frames[2]).toBeGreaterThan(19_000)
    expect(d.frames[2]).toBeLessThan(25_000)
    expect(d.started[1]).toEqual(argsFor('b'))
  })

  it('starts that all named a copy a dropped link lost send it again once, not each', async () => {
    const d = daemon()
    await expect(sendStartWithRefs('h', { sid: 'w', args: argsFor('w') }, () => Promise.reject(new Error('connection closed')))).rejects.toThrow()
    const all = await Promise.all(['a', 'b', 'c'].map((sid) => sendStartWithRefs('h', { sid, args: argsFor(sid) }, d.send)))
    expect(all.every((r) => r.ok)).toBe(true)
    const big = d.frames.filter((n) => n > 19_000)
    expect(big, 'one frame carries the lost copies again').toHaveLength(1)
    expect(d.started).toEqual(['a', 'b', 'c'].map(argsFor))
  })

  it('a host that misses a copy twice gets the start in full', async () => {
    const d = daemon()
    await sendStartWithRefs('h', { sid: 'a', args: argsFor('a') }, d.send)
    // The prompt's copy is gone; between the first try and the retry the hook's goes too (another
    // daemon sweeping a shared dir), so the retry, which still names the hook, misses again.
    let calls = 0
    const forgetful = (p: Record<string, unknown>) => { if (++calls === 2) fs.rmSync(path.join(d.root, 'argv', 'refs'), { recursive: true, force: true }); return d.send(p) }
    fs.rmSync(d.copy(PROMPT))
    expect(await sendStartWithRefs('h', { sid: 'b', args: argsFor('b') }, forgetful)).toMatchObject({ ok: true })
    expect(d.frames).toHaveLength(4)
    expect(d.frames[3]).toBeGreaterThan(50_000)
    expect(d.started[1]).toEqual(argsFor('b'))
  })

  it('an argument that already reads as a ref goes as it is, with no refs asked', async () => {
    const d = daemon()
    const args = ['claude', '--append-system-prompt', ARG_REF_TOKEN + 'not a hash ' + 'y'.repeat(2000)]
    const sent: Array<Record<string, unknown>> = []
    await sendStartWithRefs('h', { sid: 'a', args }, (p) => { sent.push(p); return d.send(p) })
    expect(sent).toEqual([{ sid: 'a', args }])
    expect(d.started).toEqual([args])
  })

  it('a copy that does not hash to its name is no copy, and a forged name is refused', () => {
    const d = daemon()
    d.af.rememberRefs([PROMPT])
    expect(fs.statSync(path.join(d.root, 'argv', 'refs')).mode & 0o777).toBe(0o700)
    expect(fs.statSync(d.copy(PROMPT)).mode & 0o777).toBe(0o600)
    fs.writeFileSync(d.copy(PROMPT), PROMPT + 'tampered')
    const h = argRefHash(PROMPT)
    expect(d.af.resolveRefs([ARG_REF_TOKEN + h]).missing).toEqual([h])
    // It is gone, so the next full start keeps a good copy again.
    expect(fs.existsSync(d.copy(PROMPT))).toBe(false)
    d.af.rememberRefs([PROMPT])
    expect(d.af.resolveRefs([ARG_REF_TOKEN + h]).args).toEqual([PROMPT])
    expect(d.af.resolveRefs([ARG_REF_TOKEN + '../../etc/passwd']).missing).toEqual(['../../etc/passwd'])
  })

  it('copies no start named for 3 days are swept at most hourly; a start that names one keeps it', () => {
    let t = Date.now()
    const d = daemon(() => t)
    d.af.rememberRefs([PROMPT, HOOK])
    const old = new Date(t - 4 * 24 * 3600_000)
    fs.utimesSync(d.copy(PROMPT), old, old)
    fs.utimesSync(d.copy(HOOK), old, old)
    // The hourly sweep already ran at the first call (when both were new): this one is skipped.
    d.af.rememberRefs([])
    expect(fs.existsSync(d.copy(PROMPT))).toBe(true)
    t += 2 * 3600_000
    // A start names the hook by hash: its copy is touched, so only the prompt's goes.
    expect(d.af.resolveRefs([ARG_REF_TOKEN + argRefHash(HOOK)]).args).toEqual([HOOK])
    d.af.rememberRefs([])
    expect(fs.existsSync(d.copy(PROMPT))).toBe(false)
    expect(fs.existsSync(d.copy(HOOK))).toBe(true)
  })

  it('the server and the daemon factory agree on the token and the length, and the capability is advertised', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/providers/cli-argv-files-core.ts'), 'utf8')
    expect(src).toContain(`var REF_TOKEN = '${ARG_REF_TOKEN}'`)
    expect(src).toContain(`var REF_MIN_CHARS = ${ARG_REF_MIN_CHARS}`)
    expect(ADVERTISED_DAEMON_CAPABILITIES as readonly string[]).toContain(START_ARG_REFS_CAPABILITY)
  })
})
