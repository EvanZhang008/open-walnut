/**
 * A small S3-compatible server for tests: path-style PUT, GET, HEAD and DELETE on one bucket,
 * kept in memory. It checks Content-MD5 the way S3 does (400 BadDigest), answers the MD5 as
 * the ETag, and ignores signatures. Faults can be armed per call: drop the connection on the
 * next PUT (an interrupted upload) or serve other bytes on the next GET (a corrupted object);
 * `getDelayMs` holds every GET that long (a slow download).
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface FakeS3 {
  url: string
  bucket: string
  objects: Map<string, Buffer>
  requests: { method: string; key: string }[]
  faults: { dropNextPut: number; corruptNextGet: number; failAll: boolean; getDelayMs: number }
  close(): Promise<void>
}

const xmlError = (res: http.ServerResponse, status: number, code: string) => {
  res.writeHead(status, { 'content-type': 'application/xml' })
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`)
}

export async function startFakeS3(bucket = 'test-bucket'): Promise<FakeS3> {
  const objects = new Map<string, Buffer>()
  const requests: FakeS3['requests'] = []
  const faults = { dropNextPut: 0, corruptNextGet: 0, failAll: false, getDelayMs: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const parts = u.pathname.split('/').filter(Boolean)
    const b = decodeURIComponent(parts[0] ?? '')
    const key = parts.slice(1).map(decodeURIComponent).join('/')
    requests.push({ method: req.method ?? '', key })
    if (faults.failAll) { req.resume(); return xmlError(res, 503, 'ServiceUnavailable') }
    if (b !== bucket) { req.resume(); return xmlError(res, 404, 'NoSuchBucket') }
    if (req.method === 'PUT') {
      if (faults.dropNextPut > 0) {
        faults.dropNextPut--
        // Read part of the body, then cut the connection: the client sees a socket error.
        req.once('data', () => req.socket.destroy())
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const md5 = createHash('md5').update(body).digest()
        const sent = req.headers['content-md5']
        if (typeof sent === 'string' && Buffer.from(sent, 'base64').compare(md5) !== 0) return xmlError(res, 400, 'BadDigest')
        objects.set(key, body)
        res.writeHead(200, { etag: `"${md5.toString('hex')}"` })
        res.end()
      })
      return
    }
    req.resume()
    const obj = objects.get(key)
    if (req.method === 'HEAD') {
      if (!obj) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-length': String(obj.length), etag: `"${createHash('md5').update(obj).digest('hex')}"` })
      return res.end()
    }
    if (req.method === 'GET') {
      if (!obj) return xmlError(res, 404, 'NoSuchKey')
      let body = obj
      if (faults.corruptNextGet > 0) { faults.corruptNextGet--; body = Buffer.from(obj); body[body.length >> 1] ^= 0xff }
      const send = () => { res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' }); res.end(body) }
      if (faults.getDelayMs > 0) { setTimeout(send, faults.getDelayMs); return }
      return send()
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end() }
    xmlError(res, 405, 'MethodNotAllowed')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`, bucket, objects, requests, faults,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()) }),
  }
}
