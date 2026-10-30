/**
 * Every place that creates a session request marks it as on its way until its
 * message is in (undelivered-requests.ts noteRequestDelivering).
 *
 * A request row is written before the message that names it is queued or
 * started; a phase edge of the target's earlier turn landing in between found
 * no row and settled the request as answered (2026-10-30, CI). A new creator
 * that forgets the mark brings that race back, so this finds the creators from
 * the source.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = path.resolve(import.meta.dirname, '../../../src')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(p)
  }
  return out
}

describe('request creators mark the request as on its way', () => {
  const creators = sourceFiles(SRC)
    .filter((f) => !f.endsWith(path.join('core', 'session-requests.ts')))
    .filter((f) => /\bcreateSessionRequest\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f))

  it('finds them', () => {
    expect(creators.length).toBeGreaterThanOrEqual(2)
  })

  it('each creator calls noteRequestDelivering', () => {
    const missing = creators.filter((f) => !/\bnoteRequestDelivering\(/.test(fs.readFileSync(path.join(SRC, f), 'utf8')))
    expect(missing, 'mark each new request with noteRequestDelivering until its message is queued or started').toEqual([])
  })
})
