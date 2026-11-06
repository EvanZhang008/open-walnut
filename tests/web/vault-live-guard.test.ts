/**
 * Every web surface that reads the Passwords state follows it live (web/src/api/vault-live.ts):
 * a Lock or an unlock elsewhere on this computer (the extension, another window) reaches it through
 * `vault:changed` with no reload (review 2026-11-06: an extension Lock reached an open Passwords
 * page only after 13.6 s; Settings → Passwords ignored the extension's unlock until a reload).
 *
 * The class is every file under web/src that reads the vault state (vaultApi.status, vaultSession,
 * onVaultSessionChange): each must import vault-live, so the follower runs whichever surface is
 * mounted. A new reader that does not fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../../web/src')
/** The client itself and the follower. */
const EXEMPT = new Set(['api/vault.ts', 'api/vault-live.ts'])
const READS = /\bvaultApi\.status\(|\bvaultSession\(|\bonVaultSessionChange\(/
const IMPORTS_LIVE = /from\s+['"](?:@\/api|\.{1,2}(?:\/[\w.-]+)*)\/vault-live['"]|import\s+['"](?:@\/api|\.{1,2}(?:\/[\w.-]+)*)\/vault-live['"]/

function files(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('vault readers follow the vault live', () => {
  const readers = files(ROOT).map((f) => path.relative(ROOT, f)).filter((rel) => !EXEMPT.has(rel) && READS.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))

  it('finds the readers it guards', () => {
    // The Passwords page, Settings → Passwords and its sources group, the approval store and unlock form.
    expect(readers).toEqual(expect.arrayContaining([
      'components/passwords/PasswordsApp.tsx',
      'components/settings/sections/PasswordsSection.tsx',
      'components/approvals/approvals-store.ts',
    ]))
  })

  it('every reader imports api/vault-live', () => {
    const missing = readers.filter((rel) => !IMPORTS_LIVE.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    expect(missing, 'these read the vault state without following it live: import \'@/api/vault-live\'').toEqual([])
  })
})
