/**
 * TLS on loopback for tests: a throwaway self-signed certificate for 127.0.0.1 (made with the
 * system's openssl in a temp dir, never kept), a TLS front that terminates it and pipes the bytes
 * to a plain loopback port (what the companion's reverse proxy does in front of it), and a
 * witness door POST over https that trusts that one certificate.
 *
 * A child process trusts the certificate with NODE_EXTRA_CA_CERTS=<certFile> (node and bun both read it).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import tls from 'node:tls'
import type { DoorPost } from '../../src/core/leader/switch/witness-direct.js'

export interface LoopbackCert { key: string; cert: string; certFile: string }

export function makeLoopbackCert(dir: string): LoopbackCert {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keyFile = path.join(dir, 'loopback-key.pem')
  const certFile = path.join(dir, 'loopback-cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' })
  return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), certFile }
}

export interface TlsFront {
  port: number
  /** false: refuse every new connection and cut the open ones (the box is out of reach); true brings it back. */
  setUp(up: boolean): void
  close(): Promise<void>
}

/** A TLS front on a loopback port, each connection piped to `target()` (a port that may change across restarts). */
export async function startTlsFront(c: LoopbackCert, target: () => number): Promise<TlsFront> {
  let down = false
  const sockets = new Set<net.Socket>()
  const server = tls.createServer({ key: c.key, cert: c.cert }, (sock) => {
    if (down) { sock.destroy(); return }
    const up = net.connect(target(), '127.0.0.1')
    sockets.add(sock); sockets.add(up)
    const end = () => { sock.destroy(); up.destroy(); sockets.delete(sock); sockets.delete(up) }
    sock.on('error', end); up.on('error', end); sock.on('close', end); up.on('close', end)
    sock.pipe(up); up.pipe(sock)
  })
  server.on('tlsClientError', () => {})
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    port: (server.address() as net.AddressInfo).port,
    setUp(up) { down = !up; if (down) for (const s of sockets) s.destroy() },
    close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => server.close(() => r())) },
  }
}

/** A witness door POST over https that trusts `c` only, on one keep-alive agent (as fetch keeps its connection). */
export function httpsDoorPost(c: LoopbackCert, timeoutMs = 15_000): DoorPost & { agent: https.Agent } {
  const agent = new https.Agent({ ca: c.cert, keepAlive: true })
  const post = ((url: string, body: unknown, done: (r: { status: number; json: unknown } | null) => void) => {
    const text = JSON.stringify(body)
    let settled = false
    const finish = (r: { status: number; json: unknown } | null) => { if (!settled) { settled = true; done(r) } }
    const req = https.request(url, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (d: Buffer) => chunks.push(d))
      res.on('end', () => {
        let json: unknown = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        finish({ status: res.statusCode ?? 0, json })
      })
      res.on('error', () => finish(null))
    })
    req.on('error', () => finish(null))
    req.on('timeout', () => { req.destroy(); finish(null) })
    req.end(text)
    return () => { req.destroy() }
  }) as DoorPost & { agent: https.Agent }
  post.agent = agent
  return post
}

/** `post` as a promise (a test's own requests to a door). */
export function postOnce(post: DoorPost, url: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
  return new Promise((resolve) => { post(url, body, resolve) })
}
