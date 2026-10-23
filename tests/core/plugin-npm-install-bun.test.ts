/**
 * The npm plugin installer against real bun: `bun info` and `bun add` as
 * src/core/plugin-npm-install.ts runs them (the default runner, no seam), from
 * a small HTTPS registry this test serves on localhost. It pins what the fake
 * runner in plugin-npm-install.test.ts can only assume: the flags bun accepts,
 * the bun.lock receipt it writes, the hoisted tree it leaves, and that the
 * plugin still loads its dependency once Walnut moved it beside the plugin.
 *
 * It also proves the npmrc proxy bun itself ignores reaches it (plugin-npm-env.ts).
 *
 * Needs openssl for the registry's certificate; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { installNpmPlugin, setNpmRunner } from '../../src/core/plugin-npm-install.js'

const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0

interface Served { stop(force?: boolean): void; port: number }
type BunServe = (options: {
  port: number; hostname: string; tls: { cert: string; key: string }; fetch(req: Request): Response
}) => Served

const PACKAGES: Record<string, Record<string, string>> = {
  'livecheck-dep': {
    'package.json': JSON.stringify({ name: 'livecheck-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
    'index.js': "export const answer = 'dep-' + (40 + 2)\n",
  },
  'walnut-livecheck-plugin': {
    'package.json': JSON.stringify({ name: 'walnut-livecheck-plugin', version: '1.0.0', type: 'module', dependencies: { 'livecheck-dep': '1.0.0' } }),
    'manifest.json': JSON.stringify({ id: 'livecheck', name: 'Live check', version: '1.0.0', apiVersion: 1, server: 'server.mjs' }),
    'server.mjs': "export { answer } from 'livecheck-dep'\n",
  },
}

/** Pack one fixture package as the registry serves it. */
function pack(name: string, files: Record<string, string>, tag = ''): { bytes: Buffer; integrity: string } {
  const root = path.join(tmp, `pkgs${tag}`, name, 'package')
  fs.mkdirSync(root, { recursive: true })
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text)
  const file = path.join(tmp, `pkgs${tag}`, `${name}.tgz`)
  execFileSync('tar', ['-czf', file, '-C', path.dirname(root), 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const bytes = fs.readFileSync(file)
  return { bytes, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` }
}

let tmp = ''
let server: Served | null = null
const tarballs: Record<string, { bytes: Buffer; integrity: string }> = {}
const saved: Record<string, string | undefined> = {}
const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig']
const ENV = ['NPM_CONFIG_REGISTRY', 'NODE_EXTRA_CA_CERTS', 'BUN_INSTALL_CACHE_DIR', 'BUN_CONFIG_REGISTRY', ...PROXY_ENV]

beforeAll(() => {
  if (!HAS_OPENSSL) return
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-npm-bun-'))
  const cnf = path.join(tmp, 'openssl.cnf')
  fs.writeFileSync(cnf, [
    '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no', '[dn]', 'CN=localhost',
    '[v3]', 'subjectAltName=DNS:localhost,IP:127.0.0.1', 'basicConstraints=critical,CA:TRUE',
    'keyUsage=digitalSignature,keyCertSign,keyEncipherment', 'extendedKeyUsage=serverAuth', '',
  ].join('\n'))
  const cert = path.join(tmp, 'cert.pem')
  const key = path.join(tmp, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-config', cnf], { stdio: 'ignore' })

  for (const [name, files] of Object.entries(PACKAGES)) tarballs[name] = pack(name, files)

  const serve = (globalThis as unknown as { Bun: { serve: BunServe } }).Bun.serve
  let origin = ''
  server = serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: { cert: fs.readFileSync(cert, 'utf8'), key: fs.readFileSync(key, 'utf8') },
    fetch(req) {
      const parts = decodeURIComponent(new URL(req.url).pathname).split('/').filter(Boolean)
      const name = parts[0] ?? ''
      const pkg = PACKAGES[name]
      if (!pkg) return Response.json({ error: 'Not found' }, { status: 404 })
      if (parts[1] === '-') return new Response(tarballs[name]!.bytes)
      const version = {
        ...JSON.parse(pkg['package.json']!) as Record<string, unknown>,
        dist: { tarball: `${origin}/${name}/-/${name}-1.0.0.tgz`, integrity: tarballs[name]!.integrity },
      }
      if (parts[1]) return Response.json(version)
      return Response.json({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': version } })
    },
  })
  origin = `https://localhost:${server.port}`

  for (const k of ENV) saved[k] = process.env[k]
  process.env.NPM_CONFIG_REGISTRY = `${origin}/`
  delete process.env.BUN_CONFIG_REGISTRY
  process.env.NODE_EXTRA_CA_CERTS = cert
  process.env.BUN_INSTALL_CACHE_DIR = path.join(tmp, 'cache')
  // This machine's own proxy settings must not decide where these requests go.
  for (const k of PROXY_ENV) delete process.env[k]
  process.env.NPM_CONFIG_USERCONFIG = path.join(tmp, 'no-npmrc')
  setNpmRunner(null)
}, 60_000)

afterAll(() => {
  server?.stop(true)
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

describe.skipIf(!HAS_OPENSSL)('installing an npm plugin with real bun', () => {
  it('pins the version, checks the bun.lock receipt, and leaves a plugin that loads its dependency', async () => {
    const stagingRoot = path.join(tmp, 'plugin-stores')
    const finalDir = path.join(stagingRoot, 'npm-walnut-livecheck-plugin')
    const result = await installNpmPlugin({ spec: 'walnut-livecheck-plugin', finalDir, stagingRoot })

    expect(result).toMatchObject({
      name: 'walnut-livecheck-plugin',
      version: '1.0.0',
      resolved: 'walnut-livecheck-plugin@1.0.0',
      integrity: tarballs['walnut-livecheck-plugin']!.integrity,
      tarball: `https://localhost:${server!.port}/walnut-livecheck-plugin/-/walnut-livecheck-plugin-1.0.0.tgz`,
    })
    expect(fs.existsSync(path.join(finalDir, 'manifest.json'))).toBe(true)
    // The dependency moved beside the plugin, a real directory, and resolves from its code.
    expect(fs.lstatSync(path.join(finalDir, 'node_modules', 'livecheck-dep')).isDirectory()).toBe(true)
    const mod = await import(pathToFileURL(path.join(finalDir, 'server.mjs')).href) as { answer: string }
    expect(mod.answer).toBe('dep-42')
    // Nothing of the staging dir is left.
    expect(fs.readdirSync(stagingRoot).filter((n) => n.startsWith('.'))).toEqual([])
  }, 120_000)

  it('installs what the registry serves now when a version was re-published, not what bun cached', async () => {
    // A private registry re-publishes 1.0.0 with other bytes. process.env names one
    // shared bun cache (beforeAll), which the first install filled with the old ones.
    const name = 'walnut-livecheck-plugin'
    const before = tarballs[name]!
    tarballs[name] = pack(name, { ...PACKAGES[name]!, 'server.mjs': "export const answer = 'republished'\n" }, '-republished')
    try {
      const stagingRoot = path.join(tmp, 'plugin-stores-2')
      const finalDir = path.join(stagingRoot, 'npm-walnut-livecheck-plugin')
      const result = await installNpmPlugin({ spec: name, finalDir, stagingRoot })
      expect(result.integrity).toBe(tarballs[name]!.integrity)
      expect(fs.readFileSync(path.join(finalDir, 'server.mjs'), 'utf8')).toContain('republished')
      // The per-install cache went with the staging dir.
      expect(fs.readdirSync(stagingRoot).filter((n) => n.startsWith('.'))).toEqual([])
    } finally {
      tarballs[name] = before
    }
  }, 120_000)

  it('goes through the proxy ~/.npmrc names, which bun does not read itself', async () => {
    // A CONNECT proxy that records every tunnel it opens.
    const tunnels: string[] = []
    const proxy = net.createServer((sock) => {
      sock.once('data', (head) => {
        const line = head.toString().split('\r\n')[0] ?? ''
        tunnels.push(line)
        const m = /^CONNECT ([^:\s]+):(\d+) /.exec(line)
        if (!m) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
        const up = net.connect(Number(m[2]), '127.0.0.1', () => {
          sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
          up.pipe(sock)
          sock.pipe(up)
        })
        up.on('error', () => sock.destroy())
        sock.on('error', () => up.destroy())
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const npmrc = path.join(tmp, 'proxy-npmrc')
    fs.writeFileSync(npmrc, `https-proxy=http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}\n`)
    process.env.NPM_CONFIG_USERCONFIG = npmrc
    try {
      const stagingRoot = path.join(tmp, 'plugin-stores-proxy')
      const finalDir = path.join(stagingRoot, 'npm-walnut-livecheck-plugin')
      await installNpmPlugin({ spec: 'walnut-livecheck-plugin', finalDir, stagingRoot })
      expect(tunnels.length).toBeGreaterThan(0)
      expect(tunnels.every((t) => t.startsWith(`CONNECT localhost:${server!.port} `))).toBe(true)
      const mod = await import(pathToFileURL(path.join(finalDir, 'server.mjs')).href) as { answer: string }
      expect(mod.answer).toBe('dep-42')
    } finally {
      process.env.NPM_CONFIG_USERCONFIG = path.join(tmp, 'no-npmrc')
      await new Promise((resolve) => proxy.close(resolve))
    }
  }, 120_000)
})
