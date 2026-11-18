/**
 * A serving job's door (plugin-job-door.ts): the job's end (`serve`, its routes on a
 * real unix socket) and the daemon's end (`forward`, one request to that socket), with
 * real sockets and real timers. The whole path on real daemons is
 * tests/integration/plugin-jobs-serve-twins.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createPluginJobDoor, type DoorRouteRequest } from '../../src/providers/plugin-job-door.js'

let dir = ''
let sock = ''
const servers: Array<{ close(): void }> = []
const logs: Array<{ level: string; msg: string; data?: unknown }> = []

const door = createPluginJobDoor({
  fs, net,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
})

function serve() {
  const s = door.serve(sock, { prefix: '/api/plugins/acme-worker', log: (level, msg, data) => { logs.push({ level, msg, data }) } })
  servers.push(s)
  return s
}

function req(method: string, p: string, body = '', headers: Record<string, string> = {}) {
  const b = Buffer.from(body)
  return { method, path: p, headers, size: b.byteLength, data: b.toString('base64') }
}

function bodyOf(a: { data: string }): string { return Buffer.from(a.data, 'base64').toString('utf8') }

async function until(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10))
}

/** A route registered: its socket is listening. */
async function listening(): Promise<void> {
  await until(() => logs.some((l) => l.msg === 'serving routes'))
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjd-'))
  sock = path.join(dir, 'serve.sock')
  logs.length = 0
})

afterEach(() => {
  for (const s of servers.splice(0)) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('serve and forward', () => {
  it('a GET reaches its route with the full path, the query and the headers; a json reply comes back typed', async () => {
    let seen: DoorRouteRequest | null = null
    serve().route('GET', '/items', (r) => { seen = r; return { json: { ok: true, n: 2 } } })
    await listening()
    const a = await door.forward(sock, req('GET', '/items?limit=5&tag=a&tag=b', '', { 'x-walnut-origin': 'remote-http', accept: 'application/json' }))
    expect(a.status).toBe(200)
    expect(a.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(bodyOf(a))).toEqual({ ok: true, n: 2 })
    expect(seen!.method).toBe('GET')
    expect(seen!.path).toBe('/api/plugins/acme-worker/items?limit=5&tag=a&tag=b')
    expect(seen!.query).toEqual({ limit: '5', tag: ['a', 'b'] })
    expect(seen!.headers).toMatchObject({ 'x-walnut-origin': 'remote-http', accept: 'application/json' })
  })

  it('a POST body reads as json and text; text, bytes and gathered chunks come back as the server half sends them', async () => {
    const s = serve()
    s.route('POST', '/queue', async (r) => ({ status: 201, json: { got: await r.json(), raw: await r.text() } }))
    s.route('GET', '/page', () => ({ text: '<b>hi é</b>' }))
    s.route('GET', '/bin', () => ({ headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([0, 1, 2, 255]) }))
    s.route('GET', '/chunks', () => ({ body: (async function* () { yield new Uint8Array([104, 105]); yield new Uint8Array([33]) })() }))
    s.route('DELETE', '/queue', () => ({}))
    await listening()
    const posted = await door.forward(sock, req('POST', '/queue', '{"item":"a"}', { 'content-type': 'application/json' }))
    expect(posted.status).toBe(201)
    expect(JSON.parse(bodyOf(posted))).toEqual({ got: { item: 'a' }, raw: '{"item":"a"}' })
    const page = await door.forward(sock, req('GET', '/page'))
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(bodyOf(page)).toBe('<b>hi é</b>')
    const bin = await door.forward(sock, req('GET', '/bin'))
    expect(bin.headers['content-type']).toBe('image/png')
    expect([...Buffer.from(bin.data, 'base64')]).toEqual([0, 1, 2, 255])
    expect(bodyOf(await door.forward(sock, req('GET', '/chunks')))).toBe('hi!')
    // Nothing to send: 204, as the server half answers.
    expect((await door.forward(sock, req('DELETE', '/queue'))).status).toBe(204)
  })

  it('matches paths as an Express mount does: params, a trailing rest, an optional slash, any case; HEAD by a GET route', async () => {
    const s = serve()
    const hits: string[] = []
    s.route('GET', '/items/:id', (r) => { hits.push(`one ${r.path}`); return { text: 'one' } })
    s.route('GET', '/files/*rest', (r) => { hits.push(`rest ${r.path}`); return { text: 'rest' } })
    await listening()
    expect((await door.forward(sock, req('GET', '/items/42'))).status).toBe(200)
    expect((await door.forward(sock, req('GET', '/ITEMS/42/'))).status).toBe(200)
    expect((await door.forward(sock, req('GET', '/files/a/b/c.txt'))).status).toBe(200)
    expect((await door.forward(sock, req('GET', '/items'))).status).toBe(404)
    expect((await door.forward(sock, req('GET', '/items/42/more'))).status).toBe(404)
    expect((await door.forward(sock, req('GET', '/files'))).status).toBe(404)
    expect((await door.forward(sock, req('POST', '/items/42'))).status).toBe(404)
    const head = await door.forward(sock, req('HEAD', '/items/7'))
    expect(head.status).toBe(200)
    // Its body comes too: the leader answers the HEAD with only its length, as Express does.
    expect(head.size).toBe(3)
    expect(hits).toEqual(['one /api/plugins/acme-worker/items/42', 'one /api/plugins/acme-worker/ITEMS/42/', 'rest /api/plugins/acme-worker/files/a/b/c.txt', 'one /api/plugins/acme-worker/items/7'])
  })

  it('a route that throws answers 500 with its message, in the log; a reply past 2 MB answers 502', async () => {
    const s = serve()
    s.route('GET', '/boom', () => { throw new Error('the queue is gone') })
    s.route('GET', '/huge', () => ({ text: 'x'.repeat(2 * 1024 * 1024 + 1) }))
    await listening()
    const boom = await door.forward(sock, req('GET', '/boom'))
    expect(boom.status).toBe(500)
    expect(JSON.parse(bodyOf(boom))).toEqual({ error: 'the queue is gone' })
    expect(logs.some((l) => l.level === 'error' && l.msg === 'route failed')).toBe(true)
    const huge = await door.forward(sock, req('GET', '/huge'))
    expect(huge.status).toBe(502)
    expect(JSON.parse(bodyOf(huge)).error).toMatch(/larger than 2 MB/)
  })

  it('a request body is at most 256 KB (the upload to the job\'s machine), an answer up to 2 MB', async () => {
    const s = serve()
    s.route('POST', '/size', async (r) => ({ json: { got: (await r.text()).length } }))
    s.route('GET', '/big', () => ({ body: new Uint8Array(2 * 1024 * 1024).fill(97) }))
    await listening()
    const at = Buffer.alloc(256 * 1024, 98)
    const ok = await door.forward(sock, { method: 'POST', path: '/size', headers: {}, size: at.byteLength, data: at.toString('base64') })
    expect(JSON.parse(bodyOf(ok))).toEqual({ got: 256 * 1024 })
    const over = Buffer.alloc(256 * 1024 + 1, 98)
    await expect(door.forward(sock, { method: 'POST', path: '/size', headers: {}, size: over.byteLength, data: over.toString('base64') }))
      .rejects.toMatchObject({ code: 'request_too_large', message: 'the request body is larger than the 256 KB a plugin job takes' })
    const big = await door.forward(sock, req('GET', '/big'))
    expect(big).toMatchObject({ status: 200, size: 2 * 1024 * 1024 })
    // A sender that is not the daemon's forward (it checks first) is told 413 by the job itself.
    const answer = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const c = net.connect(sock)
      let text = ''
      c.on('data', (b) => { text += b.toString() })
      c.on('end', () => { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } })
      c.on('error', reject)
      c.write(JSON.stringify({ v: 1, method: 'POST', path: '/size', headers: {}, size: over.byteLength, data: over.toString('base64') }) + '\n')
    })
    expect(answer.status).toBe(413)
  })

  it('serves on a socket only its owner can open, from the first route on, and a disposed route is gone', async () => {
    const s = serve()
    expect(fs.existsSync(sock)).toBe(false)
    const r = s.route('GET', '/a', () => ({ text: 'a' }))
    await listening()
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600)
    r.dispose()
    expect((await door.forward(sock, req('GET', '/a'))).status).toBe(404)
  })

  it('a socket file a crashed run left behind is replaced', async () => {
    // A run killed while it listened leaves its socket file, with nobody behind it.
    const crashed = spawn(process.execPath, ['-e', 'require("node:net").createServer().listen(process.argv[process.argv.length - 1])', sock], { stdio: 'ignore' })
    try {
      await until(() => fs.existsSync(sock))
    } finally {
      if (crashed.pid && crashed.pid > 1) crashed.kill('SIGKILL')
    }
    await new Promise<void>((res) => crashed.once('exit', () => res()))
    expect(fs.lstatSync(sock).isSocket()).toBe(true)
    await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'not_ready' })
    serve().route('GET', '/a', () => ({ text: 'a' }))
    await listening()
    expect(bodyOf(await door.forward(sock, req('GET', '/a')))).toBe('a')
  })

  it('route() refuses an unknown method and a path that climbs out', () => {
    const s = serve()
    expect(() => s.route('TRACE', '/a', () => ({}))).toThrow(/Unsupported Plugin route method/)
    expect(() => s.route('GET', '/a/../b', () => ({}))).toThrow(/must not contain/)
    expect(() => s.route('GET', 'a', () => ({}))).toThrow(/absolute in-plugin path/)
  })
})

describe('forward refusals', () => {
  it('no socket, or a socket nobody listens on: not_ready', async () => {
    await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'not_ready' })
    const s = serve()
    s.route('GET', '/a', () => ({ text: 'a' }))
    await listening()
    s.close()
    await until(() => !fs.existsSync(sock))
    await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'not_ready' })
  })

  it('a job that does not answer in time: timeout, and the handler sees its request end', async () => {
    let signal: AbortSignal | null = null
    serve().route('GET', '/slow', (r) => { signal = r.signal; return new Promise(() => {}) })
    await listening()
    await expect(door.forward(sock, req('GET', '/slow'), 200)).rejects.toMatchObject({ code: 'timeout' })
    await until(() => signal?.aborted === true)
    expect(signal!.aborted).toBe(true)
  })

  it('a request out of bounds never leaves the daemon', async () => {
    let connects = 0
    const s = net.createServer((c) => { connects += 1; c.destroy() })
    await new Promise<void>((res) => s.listen(sock, () => res()))
    try {
      const big = Buffer.alloc(256 * 1024 + 1)
      await expect(door.forward(sock, { method: 'POST', path: '/a', headers: {}, size: big.byteLength, data: big.toString('base64') })).rejects.toMatchObject({ code: 'request_too_large' })
      await expect(door.forward(sock, req('GET', '/a', '', { 'x-big': 'v'.repeat(64 * 1024) }))).rejects.toMatchObject({ code: 'too_large' })
      await expect(door.forward(sock, req('TRACE', '/a'))).rejects.toMatchObject({ code: 'bad_request' })
      await expect(door.forward(sock, req('GET', '/a', 'body'))).rejects.toMatchObject({ code: 'bad_request' })
      await expect(door.forward(sock, req('GET', '/a/../b'))).rejects.toMatchObject({ code: 'bad_request' })
      await expect(door.forward(sock, req('GET', 'a'))).rejects.toMatchObject({ code: 'bad_request' })
      await expect(door.forward(sock, { method: 'POST', path: '/a', headers: {}, size: 3, data: Buffer.from('ab').toString('base64') })).rejects.toMatchObject({ code: 'bad_request' })
      await expect(door.forward(sock, req('GET', '/a', '', { 'bad\nname': 'v' }))).rejects.toMatchObject({ code: 'bad_request' })
      expect(connects).toBe(0)
    } finally { s.close() }
  })

  it('an answer that is not one, too long, or missing: bad_answer, too_large, no_answer', async () => {
    let reply: (c: net.Socket) => void = () => {}
    const s = net.createServer((c) => { c.once('data', () => reply(c)) })
    await new Promise<void>((res) => s.listen(sock, () => res()))
    try {
      reply = (c) => c.end('not json\n')
      await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'bad_answer' })
      reply = (c) => c.end(JSON.stringify({ v: 1, status: 99, headers: {}, size: 0, data: '' }) + '\n')
      await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'bad_answer' })
      reply = (c) => c.end(JSON.stringify({ v: 1, status: 200, headers: {}, size: 5, data: '' }) + '\n')
      await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'bad_answer' })
      reply = (c) => { c.write('{"v":1,"data":"'); c.end('A'.repeat(3 * 1024 * 1024)) }
      await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'too_large' })
      reply = (c) => c.end()
      await expect(door.forward(sock, req('GET', '/a'))).rejects.toMatchObject({ code: 'no_answer' })
    } finally { s.close() }
  })
})
