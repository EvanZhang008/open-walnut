/**
 * Every view of the extension's popup and side panel that shows something kept in the extension's
 * storage follows it while on show (packages/browser-extension/src/popup-view.ts followStorage).
 * Review R3-5: the panel's Settings listed no site after the save bar's "Never for this site" until
 * the panel was opened again. A new view file that reads storage fails here until it follows it or
 * is listed below with the reason it need not.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = path.join(process.cwd(), 'packages/browser-extension/src')
/** The views (the popup's pages and the key popover). */
const VIEW = /^(popup.*|key-pop)\.ts$/
const READS = /ext\.storage\.(local|session)\.get\(|\bgetSettings\(\)|\bpageFillOn\(\)/
const PASSING: Record<string, string> = {
  'popup-connect.ts': 'the address last used, read once as a suggestion when the connect view opens; nothing is listed from it',
  'popup-generator.ts': 'the generator\'s choices, which the person makes in this very view',
}

describe('views that show stored things follow them', () => {
  it('each view file that reads storage calls followStorage, or says why it need not', () => {
    const offenders: string[] = []
    for (const f of fs.readdirSync(DIR).filter((n) => VIEW.test(n))) {
      const text = fs.readFileSync(path.join(DIR, f), 'utf8')
      if (!READS.test(text) || PASSING[f]) continue
      if (!text.includes('followStorage(')) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
  it('the list of exceptions names only files that still read storage', () => {
    for (const f of Object.keys(PASSING)) expect(READS.test(fs.readFileSync(path.join(DIR, f), 'utf8')), f).toBe(true)
  })
})
