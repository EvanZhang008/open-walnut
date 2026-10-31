/**
 * host-mcp-core.ts and host-http-core.ts on their own (both twins run them the same way,
 * host-reach-twins-e2e.test.ts proves the wiring): which servers a host has, as Claude Code
 * reads them; a stdio server called through the login shell; a call kept past its caller's
 * wait; a crash, a restart and the idle cap; the http transport (JSON and SSE answers,
 * its session id); and one HTTP request from the host with its limits.
 *
 * MACHINE SAFETY: HOME is a temp dir; the MCP server is a node script fixture; every HTTP
 * server listens on 127.0.0.1 on a free port; killGroup only signals pids the core spawned.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHostMcp, expandVars, toServerDef } from '../../src/providers/host-mcp-core.js'
import { createHostHttp } from '../../src/providers/host-http-core.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-reach-')))
const servers: http.Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
  if (root.includes('walnut-host-reach-')) fs.rmSync(root, { recursive: true, force: true })
})
const FAKE = path.resolve(__dirname, '../fixtures/mcp/host-mcp-fake.cjs')
const RUNTIME = process.execPath

function home(name: string, mcpServers: Record<string, unknown>, extra: { plugin?: Record<string, unknown>; project?: { dir: string; servers: Record<string, unknown> } } = {}): string {
  const h = path.join(root, name)
  fs.mkdirSync(path.join(h, '.claude', 'plugins'), { recursive: true })
  const main: Record<string, unknown> = { mcpServers }
  if (extra.project) main.projects = { [extra.project.dir]: { mcpServers: extra.project.servers } }
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify(main))
  if (extra.plugin) {
    const pr = path.join(h, 'plugin-root')
    fs.mkdirSync(pr, { recursive: true })
    fs.writeFileSync(path.join(pr, '.mcp.json'), JSON.stringify({ mcpServers: extra.plugin }))
    fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': false } }))
    fs.writeFileSync(path.join(h, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'tools@market': [{ installPath: pr }], 'off@market': [{ installPath: pr }] } }))
  }
  return h
}

const killGroup = (pid: number, signal: NodeJS.Signals) => { if (pid > 1) process.kill(-pid, signal) }
function core(h: string, env: NodeJS.ProcessEnv = {}) {
  return createHostMcp({ spawn: (c, a, o) => spawn(c, a, o), killGroup, shell: '/bin/sh', home: h, env: { PATH: process.env.PATH, HOME: h, ...env } })
}
const fakeServer = (env?: Record<string, string>) => ({ command: RUNTIME, args: [FAKE], ...(env ? { env } : {}) })

describe('which servers a host has', () => {
  it('reads the user\'s, the project\'s and the enabled plugins\' servers, as Claude Code names them', async () => {
    const proj = path.join(root, 'proj-a')
    fs.mkdirSync(proj, { recursive: true })
    // .mcp.json servers run only once approved there; one is, one is not, one was turned off.
    fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { fromdot: { command: 'x' }, unapproved: { command: 'x' }, turnedoff: { command: 'x' } } }))
    // Claude Code keys a project by the folder it was opened in: here a symlink to it.
    const link = path.join(root, 'proj-a-link')
    fs.symlinkSync(proj, link)
    const h = home('list', { mine: fakeServer(), web: { type: 'http', url: 'http://127.0.0.1:1/mcp' }, old: { type: 'sse', url: 'http://x' }, broken: { args: [] } }, {
      plugin: { pm: { command: '${CLAUDE_PLUGIN_ROOT}/bin/run' } }, project: { dir: link, servers: { mine: { command: 'project-wins' }, local: { command: 'y' } } },
    })
    const main = JSON.parse(fs.readFileSync(path.join(h, '.claude.json'), 'utf8'))
    main.projects[link].enabledMcpjsonServers = ['fromdot', 'turnedoff']
    main.projects[link].disabledMcpjsonServers = ['turnedoff']
    fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify(main))
    const c = core(h)
    expect(await c.list({})).toEqual({ ok: true, servers: [
      { name: 'mine', scope: 'user', type: 'stdio' }, { name: 'web', scope: 'user', type: 'http' }, { name: 'old', scope: 'user', type: 'sse' },
      { name: 'plugin:tools:pm', plugin: 'tools', scope: 'plugin', type: 'stdio' },
    ] })
    const withProject = await c.list({ cwd: link }) as { servers: Array<{ name: string; scope: string }> }
    expect(withProject.servers.map((s) => `${s.name}/${s.scope}`)).toEqual(['mine/project', 'local/project', 'fromdot/project', 'web/user', 'old/user', 'plugin:tools:pm/plugin'])
    // Opened by its real path the project entry is not found, but its approved .mcp.json is not either.
    expect(((await c.list({ cwd: proj })) as { servers: Array<{ name: string }> }).servers.map((s) => s.name)).toEqual(['mine', 'web', 'old', 'plugin:tools:pm'])
    expect(await c.list({ cwd: '/no/such/dir' })).toMatchObject({ ok: false, code: 'cwd_missing' })
    c.closeAll()
  })

  it('expands variables as Claude Code does', () => {
    const env = { A: 'one', EMPTY: '' }
    expect(expandVars('${A}/${B:-two}/${EMPTY:-three}/${CLAUDE_PLUGIN_ROOT}/x', env, '/plug')).toBe('one/two/three//plug/x')
    expect(toServerDef('n', { url: 'http://h' }, 'user')).toMatchObject({ type: 'http' })
    expect(toServerDef('n', { type: 'streamable-http', url: 'http://h' }, 'user')).toMatchObject({ type: 'http' })
    expect(toServerDef('n', { type: 'weird', command: 'x' }, 'user')).toBeNull()
  })
})

describe('a stdio server', () => {
  it('starts under the login shell with its env, lists tools over pages, and answers calls', async () => {
    const h = home('stdio', { fake: fakeServer({ FAKE_TOKEN: '${SECRET_SRC:-fallback}', PLAIN: 'yes' }) })
    const c = core(h, { SECRET_SRC: 'from-host-env' })
    const tools = await c.tools({ taskId: 't1', server: 'fake', wait: 30_000 }) as Record<string, unknown>
    expect(tools).toMatchObject({ ok: true, running: false, server: 'fake' })
    expect((tools.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['echo', 'slow', 'env', 'crash', 'image', 'secret', 'fails', 'cjk', 'crashleak'])

    const echo = await c.call({ taskId: 't1', server: 'fake', tool: 'echo', arguments: { text: 'héllo 你好' }, wait: 30_000 })
    expect(echo).toMatchObject({ ok: true, running: false, isError: false, truncated: false })
    expect(String(echo.text)).toContain('echo: héllo 你好')
    expect(String(echo.text)).toContain('roots asked true') // the client answered the server's roots/list
    expect(String(echo.text)).toContain(`cwd ${fs.realpathSync(h)}`)
    const pid = String(echo.text).match(/pid (\d+)/)![1]
    // The same task and server reuse the process; another task gets its own.
    expect(String((await c.call({ taskId: 't1', server: 'fake', tool: 'echo', arguments: { text: 'x' }, wait: 30_000 })).text)).toContain(`pid ${pid}`)
    expect(String((await c.call({ taskId: 't2', server: 'fake', tool: 'echo', arguments: { text: 'x' }, wait: 30_000 })).text)).not.toContain(`pid ${pid}`)
    expect(c.liveCount()).toBe(2)

    expect((await c.call({ taskId: 't1', server: 'fake', tool: 'env', arguments: { name: 'FAKE_TOKEN' }, wait: 30_000 })).text).toBe('from-host-env')
    expect(await c.call({ taskId: 't1', server: 'fake', tool: 'image', wait: 30_000 })).toMatchObject({ text: 'one image', images: [{ mimeType: 'image/png', bytes: 300 }] })
    expect(await c.call({ taskId: 't1', server: 'fake', tool: 'fails', wait: 30_000 })).toMatchObject({ ok: true, isError: true, text: 'it went wrong' })
    // 350 KB of multi-byte characters crosses many pipe chunks: none is cut in two.
    const cjk = await c.call({ taskId: 't1', server: 'fake', tool: 'cjk', wait: 30_000 })
    expect(String(cjk.text)).toBe('\u4e2d\u6587\ud83d\ude00'.repeat(50000).slice(0, 512 * 1024))
    expect(String(cjk.text)).not.toContain('\ufffd')
    expect(await c.call({ taskId: 't1', server: 'fake', tool: 'nope', wait: 30_000 })).toMatchObject({ ok: false, code: 'server_failed', error: expect.stringContaining('unknown tool nope') })
    expect(await c.call({ taskId: 't1', server: 'missing', tool: 'echo', wait: 1_000 })).toMatchObject({ ok: false, code: 'unknown_server' })
    expect(await c.call({ taskId: 't1', server: 'fake', tool: 'echo', arguments: [1] as unknown as Record<string, unknown> })).toMatchObject({ ok: false, code: 'bad_request' })
    c.closeAll()
  }, 60_000)

  it('keeps a call past its caller\'s wait, for that task only', async () => {
    const h = home('kept', { fake: fakeServer() })
    const c = core(h)
    const first = await c.call({ callId: 'mc-kept-0001', taskId: 't1', server: 'fake', tool: 'slow', arguments: { ms: 1_500 }, wait: 200 })
    expect(first).toMatchObject({ ok: true, callId: 'mc-kept-0001', running: true })
    expect(await c.result({ callId: 'mc-kept-0001', taskId: 'someone-else', wait: 100 })).toMatchObject({ ok: false, code: 'unknown_call' })
    expect(await c.result({ callId: 'mc-kept-0001', taskId: 't1', wait: 10_000 })).toMatchObject({ ok: true, running: false, text: 'slept 1500' })
    // Read again: the answer stays.
    expect(await c.result({ callId: 'mc-kept-0001', taskId: 't1' })).toMatchObject({ running: false, text: 'slept 1500' })
    expect(await c.call({ callId: 'mc-kept-0001', taskId: 't1', server: 'fake', tool: 'echo' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await c.result({ callId: 'mc-none-0001', taskId: 't1' })).toMatchObject({ ok: false, code: 'unknown_call' })
    c.closeAll()
  }, 60_000)

  it('reports a crash with the server\'s own words, and starts it again on the next call', async () => {
    const h = home('crash', { fake: fakeServer() })
    const c = core(h)
    const crash = await c.call({ taskId: 't1', server: 'fake', tool: 'crash', wait: 30_000 })
    expect(crash).toMatchObject({ ok: false, code: 'server_failed' })
    expect(String(crash.error)).toMatch(/exit 7.*crashing on purpose/s)
    expect(await c.call({ taskId: 't1', server: 'fake', tool: 'echo', arguments: { text: 'back' }, wait: 30_000 })).toMatchObject({ ok: true, isError: false })
    // A server whose command does not exist fails its start, with the shell's words.
    const h2 = home('nocmd', { gone: { command: '/no/such/program' } })
    const c2 = core(h2)
    expect(await c2.tools({ taskId: 't1', server: 'gone', wait: 30_000 })).toMatchObject({ ok: false, code: 'server_failed', error: expect.stringContaining('did not start') })
    expect(await c2.tools({ taskId: 't1', server: 'old', wait: 1_000 })).toMatchObject({ ok: false, code: 'unknown_server' })
    c.closeAll(); c2.closeAll()
  }, 60_000)

  it('runs at most 8 servers, making room by stopping the idle one used longest ago', async () => {
    const h = home('cap', { fake: fakeServer() })
    const c = core(h)
    for (let i = 0; i < 9; i++) expect(await c.call({ taskId: `cap-${i}`, server: 'fake', tool: 'echo', arguments: { text: String(i) }, wait: 30_000 })).toMatchObject({ ok: true })
    expect(c.liveCount()).toBe(8)
    // The evicted task comes back at once, before its old server has exited: when that old
    // process ends, it must not take the new one out of the pool with it.
    const back = await c.call({ taskId: 'cap-0', server: 'fake', tool: 'echo', arguments: { text: 'back' }, wait: 30_000 })
    const pid = String(back.text).match(/pid (\d+)/)![1]
    await new Promise((r) => setTimeout(r, 2_500))
    expect(c.liveCount()).toBe(8)
    expect(String((await c.call({ taskId: 'cap-0', server: 'fake', tool: 'echo', arguments: { text: 'again' }, wait: 30_000 })).text)).toContain(`pid ${pid}`)
    c.closeAll()
    expect(c.liveCount()).toBe(0)
  }, 90_000)

  it('refuses an sse server', async () => {
    const c = core(home('sse', { old: { type: 'sse', url: 'http://127.0.0.1:1/sse' } }))
    expect(await c.tools({ taskId: 't1', server: 'old', wait: 5_000 })).toMatchObject({ ok: false, code: 'unsupported_transport' })
    c.closeAll()
  })
})

async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`
}

describe('an http server', () => {
  it('speaks streamable HTTP: JSON and SSE answers, the session id, configured headers', async () => {
    const seen: Array<{ method: string; session?: string; auth?: string }> = []
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.method === 'DELETE') { res.writeHead(204).end(); return }
        const m = JSON.parse(body)
        seen.push({ method: m.method, session: req.headers['mcp-session-id'] as string | undefined, auth: req.headers.authorization })
        if (m.id === undefined) { res.writeHead(202).end(); return }
        if (m.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {} } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const result = m.method === 'tools/list' ? { tools: [{ name: 'ping' }] } : { content: [{ type: 'text', text: 'pong' }] }
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`)
      })
    })
    const c = core(home('http', { web: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer ${WEB_TOKEN}' } } }), { WEB_TOKEN: 'tok-on-host' })
    expect(await c.tools({ taskId: 't1', server: 'web', wait: 10_000 })).toMatchObject({ ok: true, tools: [{ name: 'ping' }] })
    expect(await c.call({ taskId: 't1', server: 'web', tool: 'ping', wait: 10_000 })).toMatchObject({ ok: true, text: 'pong' })
    expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(seen[0].session).toBeUndefined()
    expect(seen.slice(1).every((s) => s.session === 'sess-1' && s.auth === 'Bearer tok-on-host')).toBe(true)
    c.closeAll()
  })

  it('starts a fresh session when the server forgot the old one', async () => {
    let session = 1
    const inits: number[] = []
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.method === 'DELETE') { res.writeHead(204).end(); return } // the client ends its session at close
        const m = JSON.parse(body)
        if (m.method === 'initialize') {
          inits.push(session)
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `s${session}` })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {} } }))
          return
        }
        if (m.id === undefined) { res.writeHead(202).end(); return }
        if (req.headers['mcp-session-id'] !== `s${session}`) { res.writeHead(404).end('no such session'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `in s${session}` }] } }))
      })
    })
    const c = core(home('http404', { web: { type: 'http', url: `${base}/mcp` } }))
    expect(await c.call({ taskId: 't1', server: 'web', tool: 'x', wait: 10_000 })).toMatchObject({ ok: true, text: 'in s1' })
    session = 2 // the server restarted
    expect(await c.call({ taskId: 't1', server: 'web', tool: 'x', wait: 10_000 })).toMatchObject({ ok: false, code: 'server_failed', error: expect.stringContaining('HTTP 404') })
    expect(await c.call({ taskId: 't1', server: 'web', tool: 'x', wait: 10_000 })).toMatchObject({ ok: true, text: 'in s2' })
    expect(inits).toEqual([1, 2])
    c.closeAll()
  })

  it('names a refused sign-in plainly', async () => {
    const base = await listen((_req, res) => { res.writeHead(401).end() })
    const c = core(home('http401', { web: { type: 'http', url: `${base}/mcp` } }))
    expect(await c.tools({ taskId: 't1', server: 'web', wait: 10_000 })).toMatchObject({ ok: false, code: 'server_failed', error: expect.stringContaining('HTTP 401') })
    c.closeAll()
  })
})

describe('one HTTP request from the host', () => {
  it('returns text, bytes, the cap, hidden cookies, redirects and refusals', async () => {
    const base = await listen((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=secret', 'x-a': '1' }); res.end(JSON.stringify({ got: body, method: req.method, h: req.headers['x-test'] })); return }
        if (req.url === '/bin') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from([0, 1, 2, 255])); return }
        if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('x'.repeat(300 * 1024)); return }
        if (req.url === '/move') { res.writeHead(302, { location: '/json' }); res.end(); return }
        if (req.url === '/slow') { setTimeout(() => res.end('late'), 3_000); return }
        res.writeHead(404).end('nope')
      })
    })
    const h = createHostHttp()
    const j = await h.request({ url: `${base}/json`, method: 'post', headers: { 'x-test': 'v' }, body: 'café' })
    expect(j).toMatchObject({ ok: true, status: 200, contentType: 'application/json', truncated: false })
    expect(JSON.parse(String((j as { body: string }).body))).toEqual({ got: 'café', method: 'POST', h: 'v' })
    expect((j as { headers: Record<string, string> }).headers['set-cookie']).toBe('[hidden by Walnut]')
    expect(await h.request({ url: `${base}/bin` })).toMatchObject({ ok: true, bodyBase64: Buffer.from([0, 1, 2, 255]).toString('base64'), bodyBytes: 4 })
    expect(await h.request({ url: `${base}/big` })).toMatchObject({ ok: true, bodyBytes: 256 * 1024, truncated: true })
    expect(await h.request({ url: `${base}/move` })).toMatchObject({ ok: true, status: 200, url: `${base}/json` })
    expect(await h.request({ url: `${base}/missing` })).toMatchObject({ ok: true, status: 404, body: 'nope' })
    expect(await h.request({ url: `${base}/slow`, timeoutMs: 300 })).toMatchObject({ ok: false, code: 'timeout' })
    expect(await h.request({ url: 'http://127.0.0.1:1/' })).toMatchObject({ ok: false, code: 'request_failed' })
    expect(await h.request({ url: 'file:///etc/passwd' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await h.request({ url: `${base}/json`, method: 'TRACE' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await h.request({ url: `${base}/json`, body: 'x' })).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await h.request({ url: `${base}/json`, headers: { 'x-bad': 'a\r\nb: c' } })).toMatchObject({ ok: false, code: 'bad_request' })
  }, 30_000)
})
