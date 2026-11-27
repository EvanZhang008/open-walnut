/**
 * On a copy of the person's data, a plugin's OWN network writes (the global fetch, node:https) are
 * refused before anything leaves; its reads, local hosts and Walnut's own requests still go.
 * 2026-11-27: the notes importer reads Notion with its own fetch on an ephemeral server, beside the
 * real Notion secret the copy holds (src/core/plugins/copy-network-guard.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-copy-network-guard'))

const doors = await import('../../../src/core/leader/switch/doors.js')
const guard = await import('../../../src/core/plugins/copy-network-guard.js')

const sent: string[] = []
const realFetch = globalThis.fetch
const realRequest = https.request
let dir: string
let plugin: { post: () => Promise<unknown>; get: () => Promise<unknown>; local: () => Promise<unknown>; raw: () => unknown }

beforeAll(async () => {
  // What leaves is recorded instead of sent: the guard wraps these as it finds them.
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    sent.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return new Response('{}')
  }) as typeof fetch
  ;(https as unknown as { request: unknown }).request = (...args: unknown[]) => {
    sent.push(`https.request ${JSON.stringify(args[0])}`)
    return { on() {}, end() {} }
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-guard-plugin-'))
  const file = path.join(dir, 'server.mjs')
  fs.writeFileSync(file, [
    "import https from 'node:https'",
    // As plugin code is written: async, awaiting something first, a sync helper in a tail call
    // (the engine drops that helper's frame; the async caller's stays).
    "const call = (url, init) => fetch(url, init)",
    "export const post = async () => { await null; return call('https://api.example.invalid/v1/pages', { method: 'POST', body: '{}' }) }",
    "export const get = async () => { await null; return call('https://api.example.invalid/v1/pages/1') }",
    "export const local = async () => { await null; return call('http://127.0.0.1:9/x', { method: 'POST' }) }",
    "export function raw() { const req = https.request({ hostname: 'api.example.invalid', method: 'PATCH', path: '/v1/x' }); return req }",
  ].join('\n'))
  guard.notePluginCodeDir(dir)
  doors.closeAccountDoors('an ephemeral server')
  guard.guardPluginNetworkOnCopy()
  plugin = await import(pathToFileURL(file).href)
})

afterAll(() => {
  doors.closeAccountDoors(null)
  globalThis.fetch = realFetch
  ;(https as unknown as { request: unknown }).request = realRequest
  fs.rmSync(dir, { recursive: true, force: true })
  guard._forgetPluginCodeDirsForTesting()
})

describe('a plugin\'s own network on a copy', () => {
  it('a write (POST) is refused before it leaves, with the copy\'s sentence', async () => {
    sent.length = 0
    await expect(plugin.post()).rejects.toThrow(/isolated test server.*plugin-fetch own:POST:api\.example\.invalid/)
    expect(sent).toEqual([])
  })

  it('a node:https write is refused the same way', () => {
    sent.length = 0
    expect(() => plugin.raw()).toThrow(/plugin-fetch own:PATCH:api\.example\.invalid/)
    expect(sent).toEqual([])
  })

  it('a read still goes, and so does a write to this machine', async () => {
    sent.length = 0
    await plugin.get()
    await plugin.local()
    expect(sent).toEqual(['GET https://api.example.invalid/v1/pages/1', 'POST http://127.0.0.1:9/x'])
  })

  it('Walnut\'s own request is never refused for where it runs', async () => {
    sent.length = 0
    await fetch('https://api.example.invalid/model', { method: 'POST' })
    expect(sent).toEqual(['POST https://api.example.invalid/model'])
  })

  it('the person\'s own Walnut refuses nothing', async () => {
    doors.closeAccountDoors(null)
    try {
      sent.length = 0
      await plugin.post()
      expect(sent).toEqual(['POST https://api.example.invalid/v1/pages'])
    } finally {
      doors.closeAccountDoors('an ephemeral server')
    }
  })
})

describe('the parts', () => {
  it('a plugin frame anywhere on the stack counts (a tail call drops the direct caller)', () => {
    const at = (p: string) => `    at fn (${p}:1:1)`
    const stack = ['Error', at('/w/src/core/plugins/copy-network-guard.ts'), at('/w/src/core/plugins/server-api.ts'), at(path.join(dir, 'server.mjs'))].join('\n')
    expect(guard.pluginFrameIn(stack)).not.toBeNull()
    const walnut = ['Error', at('/w/src/core/plugins/copy-network-guard.ts'), at('/w/src/model/anthropic.ts')].join('\n')
    expect(guard.pluginFrameIn(walnut)).toBeNull()
  })

  it('a model call made for a plugin goes by its host', () => {
    const stack = ['Error', `    at fn (${path.join(dir, 'server.mjs')}:1:1)`].join('\n')
    expect(guard.pluginNetworkRefusal('POST', new URL('https://api.anthropic.com/v1/messages'), stack)).toBeNull()
    expect(guard.pluginNetworkRefusal('POST', new URL('https://bedrock-runtime.us-west-2.amazonaws.com/model/x/converse'), stack)).toBeNull()
    expect(guard.pluginNetworkRefusal('POST', new URL('https://s3.us-west-2.amazonaws.com/b/k'), stack)).toMatch(/plugin-fetch/)
    expect(guard.pluginNetworkRefusal('POST', new URL('https://api.notion.com/v1/search'), stack)).toMatch(/plugin-fetch/)
  })

  it('local hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', '10.1.2.3', '192.168.0.4', '172.20.0.1']) expect(guard.isLocalHost(h), h).toBe(true)
    for (const h of ['api.notion.com', 'slack.com', '172.32.0.1', '8.8.8.8']) expect(guard.isLocalHost(h), h).toBe(false)
  })
})

describe('the boot installs it on a copy only', () => {
  it('web/server.ts guards plugin networking inside the branch that closed the account doors', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/web/server.ts'), 'utf-8')
    const at = src.indexOf('guardPluginNetworkOnCopy()')
    expect(at).toBeGreaterThan(-1)
    expect(src.lastIndexOf('if (why) {', at)).toBeGreaterThan(src.lastIndexOf('closeAccountDoors(why', at))
  })

  it('the loader records every plugin that is not built in', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/integration-loader.ts'), 'utf-8')
    expect(src).toMatch(/if \(!isBuiltin\) notePluginCodeDir\(pluginDir\)/)
  })
})
