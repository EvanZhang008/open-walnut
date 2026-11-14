/**
 * Every approval's detail says whether it is the request in words or technical (store.ts
 * detailRole), so the request in words is never folded into Details (2026-11-14, the user:
 * "summayr一直都显示不需要点detail detail只是xommend detail啥的"). Walnut's own asks (a browser step,
 * a sign-in, a password, a new signing device, the Approvals switch) wrote their whole explanation
 * into `detail`, and every screen folded it. The creators are read from the source: a new one that
 * passes a detail without saying which it is fails here.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (/\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

/** The text of a call from its `(` to the matching `)`. */
function callText(src: string, at: number): string {
  let depth = 0
  for (let i = at; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1)
  }
  return src.slice(at)
}

/** Every call of the store's createApproval (and the vault's wrapper of it) in src/. */
const CALL = /\b(?:store\.)?createApproval\(|\bcreate\(\{ what:/g

describe('every approval creator says what its detail is', () => {
  const calls: Array<{ file: string; text: string }> = []
  for (const file of walk('src')) {
    if (file === path.join('src', 'core', 'approvals', 'store.ts')) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(CALL)) {
      const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, src.indexOf('\n', m.index!))
      if (/^\s*(export )?(async )?function|import|ApprovalCreator/.test(line)) continue
      calls.push({ file, text: callText(src, m.index! + m[0].indexOf('(')) })
    }
  }

  it('finds the creators', () => {
    expect(calls.length).toBeGreaterThanOrEqual(8)
  })

  it('each one that passes a detail names its role', () => {
    const missing = calls.filter((c) => /\bdetail\b/.test(c.text) && !/\bdetailRole\b/.test(c.text) && !/\.\.\.text\b/.test(c.text))
    expect(missing.map((c) => `${c.file}: ${c.text.slice(0, 120)}`), 'say detailRole: "summary" (the request in words, shown whole) or "technical" (folded in Details)').toEqual([])
  })

  it('the vault\'s creator passes its words as the summary (agent.ts hands it what and detail)', () => {
    expect(fs.readFileSync('src/web/routes/vault-agent-v1.ts', 'utf8')).toMatch(/detail: input\.detail, detailRole: 'summary'/)
  })

  it('a script\'s own ask keeps its detail technical, and a signed envelope is always technical', () => {
    expect(fs.readFileSync('src/web/routes/approvals-v1.ts', 'utf8')).toMatch(/detailRole: 'technical'/)
    expect(fs.readFileSync('src/core/approvals/store.ts', 'utf8')).toMatch(/input\.detailRole === 'summary' && !input\.singleUse/)
  })
})
