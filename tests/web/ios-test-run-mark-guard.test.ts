/**
 * The phone's twin of the web app's test-run marking (web/src/api/test-run.ts): every request
 * the iOS app makes to Walnut carries `x-walnut-test-run` when the app runs under automation
 * (ios-native/Shared/TestRunMark.swift), so what a test creates on the user's own Walnut is a
 * test object and its messages are never read as the user's words (2026-11-09: a Maestro run
 * against the live server queued a message that was recorded as the user's, and Walnut
 * reported the test task as "the user is talking with it in its own chat").
 *
 * The members are read from source, so a new request path fails here until it is marked:
 * - the device token is put on a request only by `authorizeForWalnut(token:)` (or, for an
 *   AVURLAsset, `TestRunMark.headers(token:)`), which also marks it;
 * - every Swift file that builds URLRequests marks exactly as many as it builds
 *   (`authorizeForWalnut` or `markTestRun`), unless listed below with why;
 * - no request is made from a bare URL (`session.data(from:)` and its kin), which no mark reaches.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../ios-native')
const SOURCES = ['Walnut', 'Shared', 'WalnutWidgets', 'WalnutAutoFill']
const HELPER = 'Shared/TestRunMark.swift'

/** Files whose URLRequests outnumber their marks, and why the rest never reach Walnut. */
const UNMARKED: Record<string, string> = {}

/** Source without comments, so a name in a comment neither adds nor approves a request. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length

const BUILDS_RE = /\bURLRequest\s*\(|:\s*URLRequest\s*=\s*\.init\s*\(/g
const MARKS_RE = /\.(?:authorizeForWalnut|markTestRun)\s*\(/g
/** A raw Authorization header: a setValue/addValue for it, or a header dictionary key. */
const RAW_AUTH_RE = /forHTTPHeaderField:\s*"Authorization"|"Authorization"\s*:/g
/** A load from a bare URL: the request it makes is built where no mark reaches. */
const BARE_URL_RE = /\.(?:data|download|bytes)\(\s*from:/g
const ASSET_RE = /\bAVURLAsset\s*\(/g
const ASSET_MARK_RE = /TestRunMark\.headers\s*\(/g

export interface Finding { file: string; problem: string }

/** Pure: what is wrong with these sources (path relative to ios-native, text). */
export function auditTestRunMarks(files: Array<{ file: string; text: string }>, unmarked: Record<string, string> = UNMARKED): Finding[] {
  const findings: Finding[] = []
  for (const { file, text } of files) {
    if (file === HELPER) continue
    const src = code(text)
    if (count(src, RAW_AUTH_RE) > 0) {
      findings.push({ file, problem: 'sets the Authorization header itself; use authorizeForWalnut(token:) so the request is marked' })
    }
    const builds = count(src, BUILDS_RE)
    const marks = count(src, MARKS_RE)
    if (builds !== marks && !unmarked[file]) {
      findings.push({ file, problem: `builds ${builds} URLRequest(s) but marks ${marks}; call authorizeForWalnut(token:) or markTestRun() once on each request to Walnut, or list the file in UNMARKED with why` })
    }
    if (count(src, BARE_URL_RE) > 0 && !unmarked[file]) {
      findings.push({ file, problem: 'loads from a bare URL; build a URLRequest and mark it, or list the file in UNMARKED with why' })
    }
    const assets = count(src, ASSET_RE)
    if (assets > count(src, ASSET_MARK_RE)) {
      findings.push({ file, problem: `opens ${assets} AVURLAsset(s) without TestRunMark.headers(token:)` })
    }
  }
  return findings
}

function swiftFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

const sources = SOURCES.flatMap((d) => swiftFiles(path.join(ROOT, d)))
  .map((full) => ({ file: path.relative(ROOT, full), text: fs.readFileSync(full, 'utf8') }))

describe('iOS requests to Walnut carry the test-run mark under automation', () => {
  it('reads the app sources', () => {
    expect(sources.some((s) => s.file === 'Walnut/API/WalnutAPI.swift')).toBe(true)
    expect(sources.some((s) => s.file === HELPER)).toBe(true)
  })

  it('every request path marks itself', () => {
    expect(auditTestRunMarks(sources)).toEqual([])
  })

  it('the helper authorizes and marks in one place', () => {
    const helper = code(fs.readFileSync(path.join(ROOT, HELPER), 'utf8'))
    expect(helper).toMatch(/static let header = "x-walnut-test-run"/)
    expect(helper).toMatch(/mutating func authorizeForWalnut\(token: String\?\) \{\s*if let token, !token\.isEmpty \{ setValue\("Bearer \\\(token\)", forHTTPHeaderField: "Authorization"\) \}\s*markTestRun\(\)/)
  })

  it('every UNMARKED entry is still a file that needs it', () => {
    for (const file of Object.keys(UNMARKED)) {
      const found = sources.find((s) => s.file === file)
      expect(found, file).toBeDefined()
      const src = code(found!.text)
      expect(count(src, BUILDS_RE) !== count(src, MARKS_RE) || count(src, BARE_URL_RE) > 0, file).toBe(true)
    }
  })

  it('catches a new request path that skips the mark', () => {
    const raw = 'var r = URLRequest(url: u)\nr.setValue("Bearer \\(t)", forHTTPHeaderField: "Authorization")'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: raw }]).map((f) => f.problem)).toEqual([
      expect.stringContaining('sets the Authorization header itself'),
      expect.stringContaining('builds 1 URLRequest(s) but marks 0'),
    ])
    const second = 'var a = URLRequest(url: u)\na.authorizeForWalnut(token: t)\nvar b = URLRequest(url: v)'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: second }])).toHaveLength(1)
    const asset = 'AVURLAsset(url: u, options: ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \\(t)"]])'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: asset }])).toHaveLength(2)
    // A name in a comment neither adds a request nor marks one.
    const commented = '// URLRequest(url: u)\nvar r = URLRequest(url: u) // r.markTestRun()'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: commented }])).toHaveLength(1)
    // Two marks for one request (an if/else) would hide a third, unmarked request.
    const twice = 'var r = URLRequest(url: u)\nif x { r.authorizeForWalnut(token: t) } else { r.markTestRun() }'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: twice }])).toHaveLength(1)
    const typed = 'let r: URLRequest = .init(url: u)\nlet (d, _) = try await URLSession.shared.data(from: u)'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: typed }]).map((f) => f.problem)).toEqual([
      expect.stringContaining('builds 1 URLRequest(s) but marks 0'),
      expect.stringContaining('loads from a bare URL'),
    ])
    const marked = 'var r = URLRequest(url: u)\nr.authorizeForWalnut(token: t)\nsession.dataTask(with: r)'
    expect(auditTestRunMarks([{ file: 'Walnut/New.swift', text: marked }])).toEqual([])
  })
})
