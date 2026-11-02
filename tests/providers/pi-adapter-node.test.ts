/**
 * pi's ACP adapter runs on the Node that runs pi (src/providers/pi-adapter-node.ts), read from
 * pi's own `#!` line: the node on PATH for `env node`, an absolute Node as named, and nothing
 * (keep the walnut file) for anything else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildPiAcp } from '../../scripts/build-pi-acp.mjs'
import { nodeFromShebang, piNodeFor } from '../../src/providers/pi-adapter-node.js'

let root: string
beforeAll(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-node-')) })
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

async function file(rel: string, body: string, mode = 0o755): Promise<string> {
  const p = path.join(root, rel)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, body, { mode })
  return p
}

describe('nodeFromShebang', () => {
  it.each([
    ['#!/usr/bin/env node', { onPath: 'node' }],
    ['#!/usr/bin/env node\r', { onPath: 'node' }],
    ['#!/usr/bin/env -S node --no-warnings', { onPath: 'node' }],
    ['#!/opt/homebrew/opt/node@22/bin/node', { file: '/opt/homebrew/opt/node@22/bin/node' }],
    ['#!/bin/sh', null],
    ['#!/usr/bin/env bun', null],
    ['\x7fELF', null],
  ] as const)('%s', (line, want) => { expect(nodeFromShebang(line)).toEqual(want) })
})

describe('piNodeFor', () => {
  it('finds the node on PATH for an `env node` launcher reached through a bin link', async () => {
    const node = await file('nodes/bin/node', '#!/bin/sh\n')
    const cli = await file('lib/pi/dist/cli.js', '#!/usr/bin/env node\nconsole.log(1)\n')
    await fs.mkdir(path.join(root, 'bin'), { recursive: true })
    await fs.symlink(cli, path.join(root, 'bin', 'pi'))
    expect(await piNodeFor(path.join(root, 'bin', 'pi'), { PATH: [path.join(root, 'empty'), path.dirname(node)].join(path.delimiter) })).toBe(node)
  })

  it('takes an absolute Node as named, and only when it is there', async () => {
    const node = await file('abs/node', '#!/bin/sh\n')
    expect(await piNodeFor(await file('abs/pi', `#!${node}\n`), { PATH: '' })).toBe(node)
    expect(await piNodeFor(await file('abs/pi-gone', `#!${path.join(root, 'abs/missing/node')}\n`), { PATH: '' })).toBeUndefined()
  })

  it('keeps the walnut file for a wrapper, a native pi, no node on PATH, or an unreadable file', async () => {
    expect(await piNodeFor(await file('w/pi', '#!/bin/sh\nexec node cli.js\n'), { PATH: '' })).toBeUndefined()
    expect(await piNodeFor(await file('n/pi', '\x7fELF\x02\x01'), { PATH: '' })).toBeUndefined()
    expect(await piNodeFor(await file('e/pi', '#!/usr/bin/env node\n'), { PATH: path.join(root, 'empty') })).toBeUndefined()
    expect(await piNodeFor(path.join(root, 'nope'), { PATH: '' })).toBeUndefined()
  })

  it('never takes a node named by a relative path: the adapter starts in the session cwd', async () => {
    await file('rel/bin/node', '#!/bin/sh\n')
    const pi = await file('rel/pi', '#!/usr/bin/env node\n')
    const cwd = process.cwd()
    process.chdir(path.join(root, 'rel'))
    try {
      expect(await piNodeFor(pi, { PATH: 'bin' })).toBeUndefined()
      expect(await piNodeFor(await file('rel/pi-abs', '#!bin/node\n'), { PATH: '' })).toBeUndefined()
    } finally { process.chdir(cwd) }
  })
})

// The bundle used to run only on the walnut file (Bun). A CommonJS dependency that esbuild wraps in
// a require shim runs on Bun and crashes on Node, so the built bundle answers initialize on Node.
describe('the pi adapter bundle on Node', () => {
  it('answers initialize', async () => {
    const node = await piNodeFor(await file('smoke/pi', '#!/usr/bin/env node\n'), process.env)
    if (!node) return
    const out = path.join(root, 'smoke', 'dist')
    await buildPiAcp(out)
    const child = spawn(node, [path.join(out, 'pi-acp.js')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buf = ''
        child.stdout.on('data', (d) => {
          buf += d
          const line = buf.split('\n').find((l) => l.includes('"id":1'))
          if (line) resolve(JSON.parse(line))
        })
        child.on('exit', (code) => reject(new Error(`adapter exited ${code}`)))
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n')
      })
      expect(reply).toMatchObject({ id: 1, result: { protocolVersion: 1 } })
    } finally { child.kill() }
  }, 30_000)
})
