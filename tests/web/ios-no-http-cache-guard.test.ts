/**
 * The phone app keeps no HTTP cache (ios-native/Walnut/API/AppHTTP.swift). Everything it loads
 * is a paired server's, Disconnect must leave none of it behind, and a response in `URLCache`
 * was a copy the erase had to chase: on the iOS 26.0 simulator a response stored right after the
 * erase was still readable after the erase's later passes (2026-11-15, PostEraseLogTests).
 *
 * So every session the app builds turns the cache off (`keepingNoHTTPCache()`, or `urlCache =
 * nil` where that helper is not in the target), and nothing loads through `URLSession.shared`,
 * whose cache is the shared one: `AppHTTP.session` takes those loads.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const IOS = path.join(ROOT, 'ios-native')
/** Every target's sources; the test bundles may use anything. */
const DIRS = ['Walnut', 'Shared', 'WalnutWidgets', 'WalnutAutoFill']

function swiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return swiftFiles(p)
    return e.name.endsWith('.swift') ? [p] : []
  })
}

function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

/** The text of the call whose `(` is at `open`, through its matching `)`. */
function callText(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

const sources = DIRS.flatMap((d) => swiftFiles(path.join(IOS, d))).map((f) => ({
  rel: path.relative(IOS, f),
  src: code(fs.readFileSync(f, 'utf8')),
}))

const line = (src: string, index: number) => src.slice(0, index).split('\n').length

describe('iOS: no session keeps an HTTP cache', () => {
  it('every URLSession the app builds turns the cache off', () => {
    const found: string[] = []
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      for (const m of src.matchAll(/\bURLSession\s*\(\s*configuration\s*:/g)) {
        const at = m.index! + m[0].indexOf('(')
        const call = callText(src, at)
        found.push(rel)
        if (/keepingNoHTTPCache\(\)/.test(call)) continue
        // A configuration built in a variable just above: its own lines turn the cache off.
        const before = src.slice(Math.max(0, m.index! - 600), m.index!)
        if (/\burlCache\s*=\s*nil/.test(before) && /\.reloadIgnoringLocalCacheData/.test(before)) continue
        offenders.push(`${rel}:${line(src, m.index!)}`)
      }
    }
    expect(found.length, 'found no URLSession at all: the scan is broken').toBeGreaterThan(5)
    expect(offenders, 'pass the configuration through keepingNoHTTPCache() (Walnut/API/AppHTTP.swift)').toEqual([])
  })

  it('nothing loads through URLSession.shared', () => {
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      for (const m of src.matchAll(/\bURLSession\s*\.\s*shared\s*\.\s*(data|download|upload|dataTask|downloadTask|uploadTask|bytes|webSocketTask)\b/g)) {
        offenders.push(`${rel}:${line(src, m.index!)}: ${m[0]}`)
      }
      // `session: URLSession = .shared`, a default that loads through the shared cache.
      for (const m of src.matchAll(/:\s*URLSession\s*=\s*\.shared\b/g)) offenders.push(`${rel}:${line(src, m.index!)}: ${m[0].trim()}`)
    }
    expect(offenders, 'load through AppHTTP.session (Walnut/API/AppHTTP.swift)').toEqual([])
  })

  it('the helper turns off both the store and the read', () => {
    const src = sources.find((s) => s.rel === 'Walnut/API/AppHTTP.swift')!.src
    expect(src).toMatch(/urlCache\s*=\s*nil/)
    expect(src).toMatch(/requestCachePolicy\s*=\s*\.reloadIgnoringLocalCacheData/)
    expect(src).toMatch(/static let session = URLSession\(configuration: DemoMode\.configured\(URLSessionConfiguration\.default\.keepingNoHTTPCache\(\)\)\)/)
  })
})
