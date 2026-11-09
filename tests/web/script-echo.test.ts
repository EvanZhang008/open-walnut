/**
 * The terminal hides the echo of the line the Scripts menu typed and shows the
 * script's own command instead (web/src/components/workspaces/script-echo.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetScriptEcho, expectScriptEcho, filterScriptEcho, shownCommand } from '../../web/src/components/workspaces/script-echo'
import { scriptTerminalRun } from '../../src/core/workspaces/script-line'

const mark = (id: string) => `\x1b]1337;walnut-run-start=${id}\x07`

describe('script echo', () => {
  let out = ''
  const write = (s: string) => { out += s }
  const g = globalThis as { localStorage?: unknown }
  const had = g.localStorage
  beforeEach(() => {
    const mem = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) }, removeItem: (k: string) => { mem.delete(k) } },
      configurable: true, writable: true,
    })
    out = ''; __resetScriptEcho(); vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers(); Object.defineProperty(globalThis, 'localStorage', { value: had, configurable: true, writable: true }) })

  it('the prompt stays, the typed line is replaced by the command, the output follows', () => {
    const line = scriptTerminalRun('Test', 'bun test', '/w/web', 'r1')
    expect(line.startsWith("printf '\\033]1337;walnut-run-start=%s\\007' 'r1'; ")).toBe(true)
    expectScriptEcho('s', 'r1', 'bun test')
    filterScriptEcho('s', 'user@box web % ', write)
    // A highlighter colours the echo, wraps it, and the shell adds a line end.
    filterScriptEcho('s', `\x1b[?2004l\x1b[32mpri`, write)
    filterScriptEcho('s', `ntf\x1b[39m ${line.slice(7, 60)}\r\n${line.slice(60)}\r\n`, write)
    // What came before its first word is drawn (a colour the command line then resets).
    expect(out).toBe('user@box web % \x1b[?2004l\x1b[32m')
    filterScriptEcho('s', `${mark('r1')}3 passed\r\n`, write)
    expect(out).toBe(`user@box web % \x1b[?2004l\x1b[32m${shownCommand('bun test')}3 passed\r\n`)
    // Done: later output passes as it is.
    filterScriptEcho('s', 'more', write)
    expect(out.endsWith('3 passed\r\nmore')).toBe(true)
  })

  it('fails open: no mark in time draws everything held, unchanged', () => {
    expectScriptEcho('s', 'r2', 'make dev')
    filterScriptEcho('s', '$ ', write)
    const line = scriptTerminalRun('Dev', 'make dev', '/w', 'r2')
    filterScriptEcho('s', line.slice(0, 80), write)
    expect(out).toBe('$ ')
    vi.advanceTimersByTime(4_000)
    expect(out).toBe(`$ ${line.slice(0, 80)}`)
  })

  it("a reattached terminal's replay hides earlier runs' echoes too; this run's echo shows its command", () => {
    const old = scriptTerminalRun('Lint', 'bun lint', '/w', 'old1')
    const line = scriptTerminalRun('Test', 'bun test', '/w', 'new1')
    expectScriptEcho('s', 'new1', 'bun test')
    filterScriptEcho('s', `$ ${old}\r\n${mark('old1')}No problems\r\n[Lint exited with 0]\r\n$ `, write)
    filterScriptEcho('s', `${line}\r\n`, write)
    filterScriptEcho('s', `${mark('new1')}3 passed\r\n`, write)
    // A run this browser never typed shows its name, read from the echo's end.
    expect(out).toBe(`$ \x1b[1mLint\x1b[0m\r\nNo problems\r\n[Lint exited with 0]\r\n$ ${shownCommand('bun test')}3 passed\r\n`)
  })

  it('after a reload the replay shows each run as its command, even cut between chunks', () => {
    const a = scriptTerminalRun('Test', 'bun test', '/w', 'ra')
    const b = scriptTerminalRun("It's", "echo 'hi'", '/w', 'rb')
    expectScriptEcho('s', 'ra', 'bun test')
    filterScriptEcho('s', `${a}\r\n${mark('ra')}ok\r\n`, write)
    out = ''
    // The page reloads: nothing is awaited, the terminal replays its scrollback.
    const replay = `$ ${a}\r\n${mark('ra')}ok\r\n$ ${b}\r\n${mark('rb')}hi\r\n$ `
    filterScriptEcho('s2', replay.slice(0, 40), write)
    filterScriptEcho('s2', replay.slice(40, 230), write)
    filterScriptEcho('s2', replay.slice(230), write)
    vi.advanceTimersByTime(200)
    expect(out).toBe(`$ ${shownCommand('bun test')}ok\r\n$ \x1b[1mIt's\x1b[0m\r\nhi\r\n$ `)
    // A plain printf typed by hand is drawn at once.
    out = ''
    filterScriptEcho('s2', "printf 'x'", write)
    expect(out).toBe("printf 'x'")
  })

  it("a line typed while another run still ran is drawn whole: its echo holds that run's end", () => {
    const line = scriptTerminalRun('Lint', 'bun lint', '/w', 'r5')
    expectScriptEcho('s', 'r5', 'bun lint')
    const end = `\r\n\x1b]1337;walnut-run=r4\x07\x1b[1m[Install exited with 0]\x1b[0m\r\n`
    filterScriptEcho('s', `${line}\r\nInstalled 3 packages${end}$ ${line}\r\n`, write)
    filterScriptEcho('s', `${mark('r5')}clean\r\n`, write)
    expect(out).toContain('Installed 3 packages')
    expect(out).toContain('[Install exited with 0]')
    expect(out.endsWith('clean\r\n')).toBe(true)
  })

  it('a multi-line command shows its first line', () => {
    expect(shownCommand('echo a\necho b')).toBe('\x1b[1mecho a …\x1b[0m\r\n')
  })

  it("a line typed while a hand-typed command ran keeps that command's output, live and replayed", () => {
    const line = scriptTerminalRun('Lint', 'bun lint', '/w', 'r7')
    // The terminal echoes the typed line at once, then the shell echoes it again when it reads it.
    const stream = `${line}\r\nadded 312 packages\r\n$ ${line}\r\n${mark('r7')}clean\r\n`
    expectScriptEcho('s', 'r7', 'bun lint')
    filterScriptEcho('s', '$ npm install\r\n', write)
    filterScriptEcho('s', stream, write)
    expect(out).toContain('added 312 packages')
    out = ''
    filterScriptEcho('s3', `$ npm install\r\n${stream}`, write)
    vi.advanceTimersByTime(200)
    expect(out).toContain('added 312 packages')
    expect(out.endsWith('clean\r\n')).toBe(true)
  })

  it('typing is drawn at once; two terminals of one session never share a held tail', () => {
    filterScriptEcho('s', 'pr', write)
    expect(out).toBe('pr')
    let a = ''
    let b = ''
    const wa = (x: string) => { a += x }
    const wb = (x: string) => { b += x }
    const line = scriptTerminalRun('Test', 'bun test', '/w', 'r8')
    const big = `${'x'.repeat(300)}$ ${line.slice(0, 40)}`
    filterScriptEcho('s', big, wa)
    filterScriptEcho('s', 'other terminal\r\n', wb)
    expect(b).toBe('other terminal\r\n')
    expect(a.startsWith('x'.repeat(300))).toBe(true)
    vi.advanceTimersByTime(200)
    expect(a).toBe(big)
  })
})
