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

describe('a plugin\'s sync callback that tail-calls fetch', () => {
  it('is refused once its API marks the callbacks it hands Walnut (a tail call drops its own frame)', async () => {
    sent.length = 0
    // The plugin's code: a sync arrow whose only call is fetch, in tail position.
    const callback = (await import(pathToFileURL(path.join(dir, 'server.mjs')).href)).post as () => unknown
    const timers: Array<() => unknown> = []
    const api = { timers: { timeout(handler: () => unknown) { timers.push(handler) } } }
    const tailCaller = new Function("return () => fetch('https://api.example.invalid/v1/tail', { method: 'POST' })")() as () => Promise<unknown>
    guard.markPluginCallbacks(api).timers.timeout(tailCaller)
    await expect(Promise.resolve().then(() => timers[0]!())).rejects.toThrow(/plugin-fetch own:POST/)
    expect(sent).toEqual([])
    // The same callback handed over unmarked leaves no frame to see: the mark is what catches it.
    await tailCaller()
    expect(sent).toEqual(['POST https://api.example.invalid/v1/tail'])
    void callback
  })

  it('keeps one wrapper per function (an off() finds what on() got), binds methods to their own object, and leaves stores alone', () => {
    const seen: unknown[] = []
    class Store { #v = 1; get() { return this.#v } }
    const store = new Store()
    const api = {
      events: { on(fn: unknown) { seen.push(fn) }, off(fn: unknown) { seen.push(fn) } },
      store,
      name: 'x',
    }
    const marked = guard.markPluginCallbacks(api)
    const handler = () => 1
    marked.events.on(handler)
    marked.events.off(handler)
    expect(seen[0]).toBe(seen[1])
    expect(seen[0]).not.toBe(handler)
    expect((seen[0] as () => number)()).toBe(1)
    expect(marked.store).toBe(store)
    expect(marked.store.get()).toBe(1)
    expect(marked.name).toBe('x')
    expect(marked.events).toBe(marked.events)
  })
})

describe('a callback handed over inside a spec, or to an object an API method answers', () => {
  const tail = () => new Function("return () => fetch('https://api.example.invalid/v1/spec', { method: 'POST' })")() as () => Promise<unknown>

  it('a spec method that tail-calls fetch (walnut.tool({ execute }), registerSync({ createTask })) is refused', async () => {
    sent.length = 0
    const held: Array<{ execute: () => unknown; nested: { createTask: () => unknown } }> = []
    const api = { tool(spec: (typeof held)[number]) { held.push(spec) } }
    const spec = { execute: tail(), nested: { createTask: tail() } }
    guard.markPluginCallbacks(api).tool(spec)
    expect(held[0]).toBe(spec) // the same object, its methods marked in place
    await expect(Promise.resolve().then(() => held[0]!.execute())).rejects.toThrow(/plugin-fetch own:POST/)
    await expect(Promise.resolve().then(() => held[0]!.nested.createTask())).rejects.toThrow(/plugin-fetch own:POST/)
    expect(sent).toEqual([])
  })

  it('a client an API method answers marks the callbacks given to it (services.require(...).onChange(cb))', async () => {
    sent.length = 0
    const listeners: Array<() => unknown> = []
    const api = { services: { require() { return { onChange(cb: () => unknown) { listeners.push(cb) } } } } }
    guard.markPluginCallbacks(api).services.require().onChange(tail())
    await expect(Promise.resolve().then(() => listeners[0]!())).rejects.toThrow(/plugin-fetch own:POST/)
    expect(sent).toEqual([])
  })

  it('keeps a handler\'s arity and name, leaves a class and a frozen namespace as they are', () => {
    const seen: unknown[] = []
    class Adapter { ok() { return 1 } }
    const frozen = Object.freeze({ on(fn: unknown) { seen.push(fn) } })
    const api = { routes: { use(fn: unknown) { seen.push(fn) } }, frozen, make(C: unknown) { seen.push(C) } }
    const marked = guard.markPluginCallbacks(api)
    function onError(_e: unknown, _q: unknown, _r: unknown, _n: unknown) { return 0 }
    marked.routes.use(onError)
    expect((seen[0] as () => unknown).length).toBe(4)
    expect((seen[0] as () => unknown).name).toBe('onError')
    marked.make(Adapter)
    expect(seen[1]).toBe(Adapter)
    // A frozen object's method is answered as it is (a Proxy may not answer it with another value).
    expect(() => marked.frozen.on).not.toThrow()
    marked.frozen.on(onError)
    expect(seen[2]).toBe(onError)
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

  it('the loader records every plugin that is not built in, and on a copy marks its callbacks', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/integration-loader.ts'), 'utf-8')
    expect(src).toMatch(/if \(!isBuiltin\) notePluginCodeDir\(pluginDir\)/)
    expect(src).toMatch(/const onCopy = !isBuiltin && accountDoorsClosedWhy\(\) !== null/)
    expect(src).toMatch(/\.then\(\(\) => activate!\(pluginApi\)\)/)
  })
})
