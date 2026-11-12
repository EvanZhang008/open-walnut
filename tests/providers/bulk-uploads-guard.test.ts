/**
 * Every daemon command that carries bytes UP to a host rides the bulk channel,
 * which over SSH has a connection of its own (daemon-connection.ts bulkForward),
 * never the session link's. 2026-11-10: the relay path to a dev host ended an
 * SSH connection every few MB carried up, so a file copied onto the host
 * (fs.writePart), a picture pasted into a session there (fs.write) or a note's
 * picture (attachments.put) on the session tunnel took every session's link
 * down with it: host.link.lost 8 an hour.
 *
 * This test reads the source: each place the server sends a daemon command whose
 * params name bytes (data, base64, files, rows, entries, body, content, sliceGz) is
 * an upload (BULK_UPLOADS, a subset of BULK_COMMANDS, or BULK_WHEN_BIG, which ride
 * the bulk channel once their request is big), a download (its params ask
 * for bytes back), or listed below with why it stays on the session link. A new
 * one fails until it is one of those.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../src')
const CONN = fs.readFileSync(path.join(SRC, 'providers/daemon-connection.ts'), 'utf8')

function setOf(name: string): Set<string> {
  const m = CONN.match(new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]`))
  if (!m) throw new Error(`${name} not found in daemon-connection.ts`)
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]))
}

/** Commands that ask for bytes back: the big frame is the answer, which the relay path carries fine. */
const DOWNLOADS = new Set([
  'fs.read',
  // rows is a requested row limit, never uploaded transcript content. The view or keys come back.
  'history.readyView', 'history.readyKeys',
])

/**
 * Uploads by a flag of the request (DaemonConnection.isUpload): the host's whole read copy
 * sent with `bind: false` (host-slice-unbound-v1) rides the bulk channel; its probe, and the
 * copy an older daemon takes, bind the socket they arrive on and stay on the session link.
 * 2026-11-11: the copy (about 0.9 MB, again after every reconnect) on the session link was
 * 14 drops in 30 minutes.
 */
const UPLOAD_BY_FLAG: Record<string, string> = {
  'host.slice': "cmd === 'host.slice' && params.bind === false",
}

/** Byte-carrying commands that stay on the session link, and why. */
const ON_SESSION_LINK: Record<string, string> = {
  'host.slice': 'without bind:false (an older daemon, a refused leader.configure) the copy binds the socket it arrives on for gateway calls; gzipped and paced (host-slice-pace.ts). Its probe carries no bytes',
  'http.request': "host_http's request body, a person's API call: small; ordered with the call that asked for it",
  'oneshot.run': 'a one-shot prompt, a few KB',
  'turns.guard': 'its files are paths a rewind would touch, not their bytes',
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The object literal that starts `text` (balanced braces), or the first 400 characters. */
function paramsOf(text: string): string {
  let depth = 0
  for (let i = 0; i < text.length && i < 2_000; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(0, i + 1)
  }
  return text.slice(0, 400)
}

const SEND_RE = /(?:\bsend\(\s*|call<[^>]*>\([^,()]+,\s*[^,()]+,\s*)'([a-z][a-zA-Z]*\.[a-zA-Z.]+)'\s*,\s*/g
// A list of every id this side knows grows with the user's data (the external scan's: 500 KB).
const BYTES_RE = /\bknown\w*Ids\b|base64|\bdata\b|\bsliceGz\b|\brows\b|\bfiles\b|\bentries\b|\bbody\b|\bcontent\b|\bchunk\b|\bimage\b|\bbuf\b/

function byteCarryingSends(): Array<{ cmd: string; at: string }> {
  const out: Array<{ cmd: string; at: string }> = []
  for (const f of sourceFiles(SRC)) {
    const rel = path.relative(SRC, f)
    // The daemon's own side (the twins and the sidecars they inline) answers commands; it sends none.
    if (/^providers\/(daemon-(standalone|source)|.*-core)\.ts$/.test(rel)) continue
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(SEND_RE)) {
      // The params: an object literal, or an expression choosing one (`gz ? { sliceGz } : { slice }`).
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 2_000)
      const close = after.search(/\)\s*(?:;|\n|as\b)/)
      const params = after.startsWith('{') ? paramsOf(after) : after.slice(0, close > 0 ? close : 200)
      if (!BYTES_RE.test(params)) continue
      const line = text.slice(0, m.index).split('\n').length
      out.push({ cmd: m[1], at: `${rel}:${line}` })
    }
  }
  return out
}

describe('bytes carried up to a host ride the bulk channel', () => {
  const bulk = setOf('BULK_COMMANDS')
  const uploads = setOf('BULK_UPLOADS')
  const whenBig = setOf('BULK_WHEN_BIG')
  const background = setOf('BACKGROUND_UPLOADS')

  it('every upload is a bulk command', () => {
    expect([...uploads].filter((c) => !bulk.has(c))).toEqual([])
  })

  it('finds the known uploads in the source', () => {
    const cmds = new Set(byteCarryingSends().map((s) => s.cmd))
    for (const c of ['fs.writePart', 'fs.write', 'upload.part', 'attachments.put', 'replica.put', 'replica.sync']) expect(cmds).toContain(c)
  })

  it('each byte-carrying daemon command is an upload, a download or listed with why it stays', () => {
    const bad = byteCarryingSends()
      .filter((s) => !uploads.has(s.cmd) && !whenBig.has(s.cmd) && !background.has(s.cmd) && !DOWNLOADS.has(s.cmd) && !(s.cmd in ON_SESSION_LINK))
      .map((s) => `${s.at} sends ${s.cmd} with bytes: add it to BULK_UPLOADS (and BULK_COMMANDS), BACKGROUND_UPLOADS or BULK_WHEN_BIG, or to ON_SESSION_LINK with why`)
    expect(bad).toEqual([])
  })

  it('an upload by flag is read as an upload, and its sender sets the flag', () => {
    const isUpload = CONN.slice(CONN.indexOf('static isBackgroundUpload('), CONN.indexOf('static isBackgroundUpload(') + 900)
    for (const [cmd, rule] of Object.entries(UPLOAD_BY_FLAG)) {
      expect(isUpload, cmd).toContain(rule)
      expect(CONN, cmd).toMatch(new RegExp(`send\\('${cmd.replace('.', '\\.')}'[^\n]*bind: false`))
    }
  })

  it('a background upload never falls back to the session link while its own channel is meant to be up', () => {
    const once = CONN.slice(CONN.indexOf('private async sendOnce('), CONN.indexOf('private async sendOnce(') + 6_000)
    expect(once).toMatch(/const upload = DaemonConnection\.isUpload\(cmd, params\)/)
    expect(once).toMatch(/if \(background && this\.bulkOwnLink && !bulkSocket\) \{\s*throw markLinkFailure\(/)
    // Every upload no person waits on is in the background set.
    for (const c of ['fs.writePart', 'replica.put', 'replica.sync', 'attachments.put', 'attachments.sync', 'sessions.discoverExternal']) expect(background, c).toContain(c)
    // At any size (2026-11-12: manifests under the size bar, 1.5 MB in 16 minutes, still
    // took the session link down): isUpload reads the whole background set.
    const isUpload = CONN.slice(CONN.indexOf('static isUpload('), CONN.indexOf('static isUpload(') + 400)
    expect(isUpload).toContain('DaemonConnection.BACKGROUND_UPLOADS.has(cmd)')
  })

  it('the listed exceptions are still sent somewhere', () => {
    const cmds = new Set(byteCarryingSends().map((s) => s.cmd))
    expect(Object.keys(ON_SESSION_LINK).filter((c) => !cmds.has(c))).toEqual([])
  })
})
