/**
 * Routes whose answers hold secrets never go through the applied-ops ledger
 * (src/web/middleware/op-id.ts SECRET_ROUTE_RE): the ledger is a plain file kept for days,
 * and a replay from it would skip the route's own checks. Every vault route defined in
 * src/web/routes is listed here from the source, so a new one outside the pattern fails.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { SECRET_ROUTE_RE } from '../../src/web/middleware/op-id.js'

const ROUTES = path.resolve(__dirname, '../../src/web/routes')

function vaultPaths(): string[] {
  const out: string[] = []
  for (const name of fs.readdirSync(ROUTES)) {
    if (!name.endsWith('.ts')) continue
    const text = fs.readFileSync(path.join(ROUTES, name), 'utf8')
    for (const m of text.matchAll(/\.(?:get|post|put|patch|delete)\(\s*[`'"]([^`'"]*vault[^`'"]*)[`'"]/gi)) out.push(m[1])
  }
  return out
}

describe('secret routes skip the op-id ledger', () => {
  it('finds the vault routes', () => {
    expect(vaultPaths().length).toBeGreaterThan(10)
  })

  it('every vault route matches the pattern the middleware skips', () => {
    for (const p of vaultPaths()) expect(SECRET_ROUTE_RE.test(`/api/v1${p.replace(/\$\{[^}]+\}/g, 'x')}`), p).toBe(true)
  })

  it('does not skip other routes', () => {
    for (const p of ['/api/v1/tasks', '/api/v1/vaults-elsewhere', '/api/vault/x']) expect(SECRET_ROUTE_RE.test(p), p).toBe(false)
  })
})
