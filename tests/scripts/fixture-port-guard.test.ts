/**
 * A browser spec takes a port for a server it starts from tests/e2e/browser/fixture-port.ts, never
 * by listening on port 0, closing and handing the number on: that number is an ephemeral port the
 * child's own port-0 listeners can take before it binds it (2026-11-26, plugin-update-round3.spec:
 * the fixture server's daemon door got the port and answered its readiness probe). This fails when
 * a file under tests/e2e/browser reserves a port that way again.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(import.meta.dirname, '../e2e/browser')

/** `listen(0` whose server is closed within a few lines with its port read: a reserve-and-release. */
function releasedPorts(text: string): number[] {
  const lines = text.split('\n')
  const hits: number[] = []
  lines.forEach((line, i) => {
    if (!/\.listen\(0\b/.test(line)) return
    const window = lines.slice(i, i + 9)
    const at = window.findIndex((l) => /\.close\(/.test(l) && !/^\s*close:/.test(l))
    if (at < 0) return
    if (window.slice(0, at + 3).some((l) => /\bport\b/.test(l) && !/^\s*\/\//.test(l))) hits.push(i + 1)
  })
  return hits
}

describe('browser specs take a fixture port from fixture-port.ts', () => {
  it('no file reserves a port with listen(0) and close', () => {
    const found: string[] = []
    for (const name of fs.readdirSync(DIR)) {
      if (!name.endsWith('.ts') || name === 'fixture-port.ts') continue
      for (const line of releasedPorts(fs.readFileSync(path.join(DIR, name), 'utf8'))) found.push(`${name}:${line}`)
    }
    expect(found).toEqual([])
  })

  it('the scan finds the shapes the specs used, and leaves a server that keeps listening alone', () => {
    const fn = [
      'async function reservePort(): Promise<number> {',
      '  const server = net.createServer()',
      '  await new Promise<void>((resolve, reject) => { server.once(\'error\', reject); server.listen(0, \'127.0.0.1\', resolve) })',
      '  const address = server.address()',
      '  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))',
      '  return address.port',
      '}',
    ].join('\n')
    const inline = "srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })"
    const kept = [
      "await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))",
      'const { port } = server.address() as { port: number }',
      'return {',
      '  url: `http://127.0.0.1:${port}/`,',
      '  close: () => new Promise<void>((resolve) => server.close(() => resolve())),',
      '}',
    ].join('\n')
    expect(releasedPorts(fn)).toEqual([3])
    expect(releasedPorts(inline)).toEqual([1])
    expect(releasedPorts(kept)).toEqual([])
  })
})
