/**
 * The server's exit record names the error that killed it.
 *
 * 2026-10-24 06:21:55Z: prod died of an uncaught `read ECONNRESET`, and the exit
 * log kept only that message: no stack, no errno, no syscall, so the socket that
 * had no 'error' listener could not be found. Real: a child process whose
 * loopback socket gets a TCP reset with no listener, and the same exitDetail the
 * server's uncaughtException handler records (src/web/server.ts installExitDiagnostics).
 */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { exitDetail, EXIT_STACK_MAX_CHARS } from '../../src/web/exit-detail.js'

const ROOT = path.resolve(__dirname, '../..')
const TSX = path.join(ROOT, 'node_modules/.bin/tsx')
const CHILD = path.join(__dirname, 'fixtures/exit-detail-child.ts')

function runChild(mode: string): Promise<{ code: number | null; out: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CHILD, mode], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
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
  it('a reset with no error listener: message, code, syscall, errno and the stack', async () => {
    const { code, out } = await runChild('reset')
    expect(code).toBe(1)
    expect(out.detail).toBe('read ECONNRESET')
    expect(out.code).toBe('ECONNRESET')
    expect(out.syscall).toBe('read')
    expect(typeof out.errno).toBe('number')
    // The frame that raised it (a socket read, the shape the 2026-10-24 crash had)
    // and, from Node's printed form, the class of the emitter nobody listened on.
    expect(String(out.stack)).toMatch(/^Error: read ECONNRESET\n\s+at TCP\.onStreamRead/)
    expect(String(out.stack)).toContain("Emitted 'error' event on Socket instance at:")
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
