/**
 * The Walnut MCP mount a session gets (walnutMcpProfile): `<this runtime>
 * <this CLI entry> mcp`. The server process IS the CLI, so its own argv[1] is
 * the entry (`bun dist/cli.js`, `bun src/cli.ts` from source, the compiled
 * file's `/$bunfs/root/walnut`), run by its own executable. This pins which
 * argv[1] counts as the CLI, and that the command the mount builds from source
 * really answers an MCP initialize on bun.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cliEntryOf } from '../../src/core/sessions/profiles.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const homes: string[] = []
afterAll(() => { for (const h of homes) fs.rmSync(h, { recursive: true, force: true }) })

describe('the MCP mount runs this CLI with this runtime', () => {
  it('takes every CLI entry this server can run as, and nothing else', () => {
    for (const entry of ['/app/dist/cli.js', '/repo/src/cli.ts', '/usr/lib/node_modules/open-walnut/bin/open-walnut.js', '/repo/bin/walnut.js', '/usr/local/bin/open-walnut', '/$bunfs/root/walnut']) {
      expect(cliEntryOf(entry), entry).toBe(path.resolve(entry))
    }
    for (const other of [undefined, '', '/repo/node_modules/vitest/vitest.mjs', '/repo/src/web/server.ts', '/repo/scripts/cli.mjs']) {
      expect(cliEntryOf(other), String(other)).toBeNull()
    }
  })

  it('the mount from source answers an MCP initialize on bun', async () => {
    const entry = cliEntryOf(path.join(ROOT, 'src/cli.ts'))
    expect(entry).not.toBeNull()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-mcp-mount-'))
    homes.push(home)
    // Port 9 (discard): initialize needs no API, and nothing answers there.
    const child = spawn(process.execPath, [entry!, 'mcp', '--api-url', 'http://127.0.0.1:9'], {
      cwd: ROOT,
      env: { ...process.env, OPEN_WALNUT_HOME: home, BUN_BE_BUN: undefined },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const reply = await new Promise<{ id?: number; result?: { serverInfo?: { name?: string } } }>((resolve, reject) => {
        let out = ''
        let err = ''
        const timer = setTimeout(() => reject(new Error(`no initialize reply in 30s; stderr: ${err.slice(-500)}`)), 30_000)
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString()
          const line = out.split('\n').find((l) => l.startsWith('{'))
          if (line && out.includes('\n', out.indexOf(line))) { clearTimeout(timer); resolve(JSON.parse(line)) }
        })
        child.stderr.on('data', (d: Buffer) => { err += d.toString() })
        child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`mcp exited ${code}; stderr: ${err.slice(-500)}`)) })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })}\n`)
      })
      expect(reply.id).toBe(1)
      expect(reply.result?.serverInfo?.name).toBe('walnut')
    } finally {
      child.stdin.end()
      if (child.exitCode === null) child.kill('SIGTERM')
    }
  }, 45_000)
})
