/**
 * host.endpoint (host-facts-core.ts endpoint, 'model-endpoint-v1'): the endpoint a host's Claude
 * Code sessions call, found the way Claude Code finds it (settings files over the environment,
 * Bedrock / Vertex / the API), the proxy in front of it probed instead, and the answer read from
 * the connection alone. HTTP is a fake: no network call.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHostFacts, type HostFactsDeps } from '../../src/providers/host-facts-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-endpoint-')))
afterAll(() => { if (tmp.includes('walnut-host-endpoint-')) fs.rmSync(tmp, { recursive: true, force: true }) })

type Behaviour = 'answer' | 'hang' | string // any other string: the error code
interface Asked { protocol: 'http' | 'https'; host: string; port?: string; method: string; path: string; headers?: unknown }

function fakeHttp(protocol: 'http' | 'https', asked: Asked[], behave: (host: string) => Behaviour): HostFactsDeps['http'] {
  return {
    request: ((opts: Record<string, unknown>, cb: (res: unknown) => void) => {
      asked.push({ protocol, host: String(opts.host), port: opts.port as string | undefined, method: String(opts.method), path: String(opts.path), headers: opts.headers })
      const req = new EventEmitter() as EventEmitter & { end(): void; destroy(): void }
      req.destroy = () => {}
      req.end = () => {
        const b = behave(String(opts.host))
        if (b === 'hang') return
        setImmediate(() => {
          if (b !== 'answer') { const e = new Error(b) as Error & { code: string }; e.code = b; req.emit('error', e); return }
          const res = new EventEmitter() as EventEmitter & { statusCode: number; resume(): void }
          res.statusCode = 404
          res.resume = () => {}
          cb(res)
        })
      }
      return req
    }) as unknown as HostFactsDeps['http']['request'],
  }
}

let n = 0
function hostWith(opts: { env?: Record<string, string>; user?: Record<string, string>; project?: Record<string, string>; local?: Record<string, string>; behave?: (host: string) => Behaviour; probeMs?: number }) {
  const home = path.join(tmp, `home-${++n}`)
  const cwd = path.join(tmp, `proj-${n}`)
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true })
  if (opts.user) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: opts.user, permissions: { allow: [] } }))
  if (opts.project) fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: opts.project }))
  if (opts.local) fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ env: opts.local }))
  const asked: Asked[] = []
  const behave = opts.behave ?? (() => 'answer')
  const facts = createHostFacts({
    fs, os, execFile: (() => ({})) as unknown as HostFactsDeps['execFile'],
    http: fakeHttp('http', asked, behave), https: fakeHttp('https', asked, behave),
    env: { ...(opts.env ?? {}) }, home, platform: 'linux', arch: 'x64',
    timeouts: { probeMs: opts.probeMs ?? 500 },
  })
  return { probe: () => facts.endpoint({ cwd }), asked }
}

describe('host.endpoint finds the URL the way Claude Code does', () => {
  it.each([
    ['the public API by default', {}, 'https://api.anthropic.com', 'default'],
    ['ANTHROPIC_BASE_URL from the environment, origin only', { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8402/v1/x?k=secret' } }, 'http://127.0.0.1:8402', 'env'],
    ['Bedrock with its base URL in the user settings', { user: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BEDROCK_BASE_URL: 'http://127.0.0.1:8402' } }, 'http://127.0.0.1:8402', 'settings'],
    ['Bedrock with no base URL: the regional endpoint', { env: { CLAUDE_CODE_USE_BEDROCK: 'true', AWS_REGION: 'us-west-2' } }, 'https://bedrock-runtime.us-west-2.amazonaws.com', 'default'],
    ['Bedrock turned off with 0', { env: { CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_BASE_URL: 'https://gw.example.test' } }, 'https://gw.example.test', 'env'],
    ['Vertex with its region', { env: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'europe-west1' } }, 'https://europe-west1-aiplatform.googleapis.com', 'default'],
    ['Vertex in the global region', { env: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global' } }, 'https://aiplatform.googleapis.com', 'default'],
    ['Foundry with its resource', { env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'acme' } }, 'https://acme.services.ai.azure.com', 'default'],
    ['Foundry with its base URL in the settings', { user: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_BASE_URL: 'https://gw.example.test/anthropic' } }, 'https://gw.example.test', 'settings'],
    ['the project settings over the user settings', { user: { ANTHROPIC_BASE_URL: 'http://user.example.test' }, project: { ANTHROPIC_BASE_URL: 'http://project.example.test' } }, 'http://project.example.test', 'settings'],
    ['the local settings over the project settings', { project: { ANTHROPIC_BASE_URL: 'http://project.example.test' }, local: { ANTHROPIC_BASE_URL: 'http://local.example.test:9000' } }, 'http://local.example.test:9000', 'settings'],
    ['the settings over the environment', { env: { ANTHROPIC_BASE_URL: 'http://env.example.test' }, user: { ANTHROPIC_BASE_URL: 'http://settings.example.test' } }, 'http://settings.example.test', 'settings'],
    ['a URL that does not parse falls back to the default', { env: { ANTHROPIC_BASE_URL: 'not a url' } }, 'https://api.anthropic.com', 'default'],
  ] as const)('%s', async (_name, opts, url, via) => {
    const h = hostWith(opts as Parameters<typeof hostWith>[0])
    const r = await h.probe()
    expect(r).toMatchObject({ url, via, probed: url, reachable: true })
    expect(r.error).toBeUndefined()
    // One HEAD of the root, no header, no credential.
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]).toMatchObject({ method: 'HEAD', path: '/' })
    expect(h.asked[0].headers).toBeUndefined()
  })
})

describe('host.endpoint probes the proxy the CLI would go through', () => {
  it('an https endpoint behind HTTPS_PROXY probes the proxy', async () => {
    const h = hostWith({ env: { HTTPS_PROXY: 'http://proxy.example.test:3128' } })
    const r = await h.probe()
    expect(r).toMatchObject({ url: 'https://api.anthropic.com', probed: 'http://proxy.example.test:3128', reachable: true })
    expect(h.asked[0]).toMatchObject({ protocol: 'http', host: 'proxy.example.test', port: '3128' })
  })

  it('NO_PROXY that covers the endpoint probes the endpoint itself', async () => {
    const h = hostWith({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8402', HTTP_PROXY: 'http://proxy.example.test:3128', NO_PROXY: 'localhost,127.0.0.1' } })
    expect(await h.probe()).toMatchObject({ probed: 'http://127.0.0.1:8402' })
  })

  it('a domain suffix in NO_PROXY covers its subdomains', async () => {
    const h = hostWith({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2', HTTPS_PROXY: 'http://proxy.example.test:3128', NO_PROXY: '.amazonaws.com' } })
    expect(await h.probe()).toMatchObject({ probed: 'https://bedrock-runtime.us-west-2.amazonaws.com' })
  })
})

describe('host.endpoint reads the connection, never an answer', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])('%s is unreachable, with its code', async (code) => {
    const h = hostWith({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8402' }, behave: () => code })
    expect(await h.probe()).toMatchObject({ url: 'http://127.0.0.1:8402', reachable: false, error: code })
  })

  it('no answer in time is unreachable (timeout), bounded', async () => {
    const h = hostWith({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8402' }, behave: () => 'hang', probeMs: 200 })
    const t0 = Date.now()
    expect(await h.probe()).toMatchObject({ reachable: false, error: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'])('%s got through: reached, so a continue tells', async (code) => {
    const h = hostWith({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.test' }, behave: () => code })
    expect(await h.probe()).toMatchObject({ reachable: true })
  })

  it('any HTTP answer (a 404 here) is reached', async () => {
    const h = hostWith({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8402' } })
    expect(await h.probe()).toMatchObject({ reachable: true })
  })
})
