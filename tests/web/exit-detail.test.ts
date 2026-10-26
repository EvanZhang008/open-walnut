/**
 * The server's exit record names the error that killed it: message, code,
 * syscall, errno and stack.
 *
 * History: 2026-10-24 06:21:55Z prod, then on Node, died of an uncaught
 * `read ECONNRESET` (a socket's 'error' event with no listener), and the exit
 * log kept only that message: no stack, no errno, no syscall, so the socket
 * could not be found. Walnut's server now runs on bun, so the child here is bun
 * too (the runner's own, process.execPath), with the same exitDetail the
 * server's uncaughtException handler records (src/web/server.ts
 * installExitDiagnostics). What each case pins:
 *   - refused: an error that really kills a bun process (a connect to a closed
 *     loopback port, no 'error' listener) is recorded whole;
 *   - reset: today's crash class, a TCP reset with no listener, does not kill a
 *     bun process at all (measured on bun 1.4.4: the socket ends and closes),
 *     which would change if a later bun made it fatal again as Node does;
 *   - secret: credentials are redacted in the message and the stack.
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { exitDetail, EXIT_STACK_MAX_CHARS } from '../../src/web/exit-detail.js'

const ROOT = path.resolve(__dirname, '../..')
const CHILD = path.join(__dirname, 'fixtures/exit-detail-child.ts')

function runChild(mode: string): Promise<{ code: number | null; out: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, mode], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => {
      try { resolve({ code, out: JSON.parse(stdout) }) } catch { reject(new Error(`child printed no record (code ${code}): ${stderr.slice(0, 800)}`)) }
    })
  })
}

describe('exitDetail on a real uncaught socket error', () => {
  it('a refused connect with no error listener kills bun: message, code, syscall, errno and the stack', async () => {
    const { code, out } = await runChild('refused')
    expect(code).toBe(1)
    expect(out.detail).toMatch(/^connect ECONNREFUSED 127\.0\.0\.1:\d+$/)
    expect(out.code).toBe('ECONNREFUSED')
    expect(out.syscall).toBe('connect')
    expect(typeof out.errno).toBe('number')
    // The error line, then the frame that raised it as bun prints it (node:net's afterConnect).
    expect(String(out.stack)).toMatch(/^Error: connect ECONNREFUSED 127\.0\.0\.1:\d+\n\s+at afterConnect\b/)
  }, 60_000)

  it('a reset socket with no error listener does not kill bun, so there is no record', async () => {
    const { code, out } = await runChild('reset')
    expect(code).toBe(0)
    expect(out).toEqual({ alive: true, clientClosed: true })
  }, 60_000)

  it('redacts credentials in the message and the stack', async () => {
    const { out } = await runChild('secret')
    expect(JSON.stringify(out)).not.toContain('hunter2-not-a-real-one')
    expect(String(out.detail)).toContain('sync.example.test')
    expect(String(out.stack)).toContain('[REDACTED]')
  }, 60_000)
})

describe('exitDetail shapes', () => {
  it('a signal exit has no detail; a thrown non-error keeps its value', () => {
    expect(exitDetail(undefined)).toEqual({})
    expect(exitDetail('boom')).toEqual({ detail: 'boom' })
  })

  it('a thrown string is redacted like a message', () => {
    const d = exitDetail('push failed for https://tester:hunter2-not-a-real-one@sync.example.test/repo')
    expect(String(d.detail)).not.toContain('hunter2-not-a-real-one')
    expect(String(d.detail)).toContain('sync.example.test')
  })

  // It runs inside the uncaughtException handler: a throw there exits with code 7
  // and the record is never written.
  it('never throws, for an error whose message or stack getter throws', () => {
    const e = new Error('x')
    Object.defineProperty(e, 'message', { get() { throw new Error('getter') } })
    expect(() => exitDetail(e)).not.toThrow()
    const s = new Error('y')
    Object.defineProperty(s, 'stack', { get() { throw new Error('getter') } })
    expect(() => exitDetail(s)).not.toThrow()
    const odd = new Error('z') as Error & { message: unknown }
    odd.message = { not: 'a string' }
    expect(exitDetail(odd).detail).toBe('[object Object]')
  })

  it('caps a very deep stack', () => {
    const e = new Error('deep')
    e.stack = 'Error: deep\n' + '    at frame (file.ts:1:1)\n'.repeat(1_000)
    expect(String(exitDetail(e).stack).length).toBe(EXIT_STACK_MAX_CHARS)
  })

  it('the server records it for an uncaught exception', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    expect(src).toMatch(/\.\.\.exitDetail\(detail\)/)
    expect(src).toMatch(/process\.on\('uncaughtException', \(err\) => \{ exitLog\('uncaughtException', err\)/)
  })

  // A stop signal ends every deploy and every quit: logged, never a card (it
  // rang the bell once per deploy, 129 times by 2026-10-25). A crash still is one.
  it('a stop signal is logged without a card', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    expect(src).toMatch(/exitLog\(reason, undefined, \{ card \}\)/)
    expect(src).toMatch(/fatalSignal\('SIGTERM', '[^']+', false\)/)
    // A hangup is not a routine stop: it keeps its card.
    expect(src).toMatch(/fatalSignal\('SIGHUP', '[^']+'\)\)/)
    expect(src).toMatch(/opts\.card === false \? \{ skipNotify: true \}/)
  })
})
