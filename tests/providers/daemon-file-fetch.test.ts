/**
 * The host downloads the daemon's walnut file itself (src/providers/daemon-file-fetch.ts):
 * the decision (only the exact file this computer would send, from a web address) and
 * the generated sh, run for real (inside the same wrapper runRemoteSh sends) under the
 * shells a host's `sh` may be, against a temp dir that stands in for the host's daemon
 * dir. Downloads are real: curl over a local HTTP server that redirects the way GitHub
 * does, and over file://; wget and `timeout` are stand-ins (this Mac has neither) that
 * copy a local file and log their arguments. A PATH made of only the tools named takes
 * away curl, wget, `timeout` or the sha256 tools.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HOST_FETCH_MAX_SECONDS, HOST_FETCH_MIN_RATE, hostFetchPartPath, hostFetchScript, hostFetchSizeScript, newFetchToken, parseHostFetchAnswer,
  parseHostFetchSize, planHostFetch, type HostFetchScriptOpts,
} from '../../src/providers/daemon-file-fetch.js'
import { parseSlotAnswer, slotInstallScript } from '../../src/providers/daemon-file-slot.js'
import { extractMarkedOutput, wrapRemoteScript } from '../../src/providers/remote-sh.js'

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
/** A stand-in walnut file: answers the daemon version the install asks for, then bytes that never run. */
const FILE = Buffer.concat([Buffer.from('#!/bin/sh\nif [ "$1" = __daemon ]; then echo walnut-daemon-test; fi\nexit 0\n'), crypto.randomBytes(300_000)])
const GZ = zlib.gzipSync(FILE, { level: 9 })

let dir = ''
let slot = ''
let gz = ''
let token = ''
let part = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fetch-'))
  slot = path.join(dir, 'open-walnut', 'daemon-linux-x64')
  gz = `${slot}.gz`
  token = newFetchToken()
  part = hostFetchPartPath(gz, token)
  fs.writeFileSync(path.join(dir, 'walnut-0.6.99-linux-x64.gz'), GZ)
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'
/** A bin dir holding only `names` (linked to this machine's own), plus stand-in scripts. */
function binWith(names: string[], scripts: Record<string, string> = {}): string {
  const bin = fs.mkdtempSync(path.join(dir, 'bin-'))
  for (const n of names) {
    const real = SYSTEM_PATH.split(':').map((d) => path.join(d, n)).find((f) => fs.existsSync(f))
    if (real) fs.symlinkSync(real, path.join(bin, n))
  }
  for (const [n, body] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, n), body, { mode: 0o755 })
  return bin
}
const BASE_TOOLS = ['rm', 'mkdir', 'mv', 'tr', 'cut', 'awk', 'wc', 'cat', 'env', 'true']
const SHA_TOOLS = ['sha256sum', 'shasum', 'perl']
/** wget: logs its arguments and HOME, answers --help with the options GNU wget has, copies a file:// URL. */
const WGET = [
  '#!/bin/sh',
  'echo "HOME=$HOME $*" >> "$WGET_LOG"',
  'case "$1" in --help) echo "  --no-config  --no-hsts  --no-hpkp  --tries=NUMBER"; exit 0;; esac',
  'out=; url=',
  'while [ $# -gt 0 ]; do case "$1" in -O|-T) [ "$1" = -O ] && out=$2; shift 2;; -*) shift;; *) url=$1; shift;; esac; done',
  'cat "${url#file://}" > "$out"',
].join('\n')
/** timeout N cmd...: runs the command (the limit itself is GNU's business). */
const TIMEOUT = '#!/bin/sh\nshift\nexec "$@"\n'

/** The shells a host's `sh` may be: bash as sh (here and on many hosts) and dash (Debian, Ubuntu). */
const SHELLS = ['/bin/sh', '/bin/dash'].filter((sh) => fs.existsSync(sh))

const left = () => fs.existsSync(path.dirname(slot)) ? fs.readdirSync(path.dirname(slot)).sort() : []
const fileUrl = () => `file://${path.join(dir, 'walnut-0.6.99-linux-x64.gz')}`
const script = (over: Partial<HostFetchScriptOpts> = {}) => hostFetchScript({ url: fileUrl(), gz, token, gzSha256: sha(GZ), ...over })

describe('whether the host downloads the file itself', () => {
  const file = { sha256: sha(FILE), gzSha256: sha(GZ), gz: GZ }
  const asset = { url: 'https://github.com/o/r/releases/download/v0.6.99/walnut-0.6.99-linux-x64.gz', gzSha256: sha(GZ), sha256: sha(FILE) }

  it('a released build whose release holds this very file: yes, with its size for the bar', () => {
    expect(planHostFetch(asset, file)).toEqual({ url: asset.url, gzSha256: sha(GZ), total: GZ.length, minRate: HOST_FETCH_MIN_RATE })
  })

  it('a download too slow to end in time is cut early: the slowest rate it may go follows the size', () => {
    const big = { ...file, gz: { length: 67_101_187 } }
    expect(planHostFetch(asset, big)).toMatchObject({ minRate: Math.ceil(67_101_187 / HOST_FETCH_MAX_SECONDS) })
  })

  it('the same file in another gz (this computer gzipped it itself): yes, with no size known', () => {
    const own = zlib.gzipSync(FILE, { level: 6 })
    expect(planHostFetch(asset, { ...file, gzSha256: sha(own), gz: own })).toEqual({ url: asset.url, gzSha256: sha(GZ), total: null, minRate: HOST_FETCH_MIN_RATE })
  })

  it('a dev build (no release publishes it): no, and why', () => {
    expect(planHostFetch({ none: 'this server runs a build of its own checkout, which no release publishes' }, file))
      .toEqual({ skip: 'this server runs a build of its own checkout, which no release publishes' })
  })

  it('a release of the same version with other bytes: no, the upload sends this build', () => {
    const plan = planHostFetch({ ...asset, sha256: 'c'.repeat(64) }, file)
    expect(plan).toEqual({ skip: expect.stringMatching(/is not the one this computer would send/) })
  })

  it('an address a host cannot reach, or sums that are no sha256: no', () => {
    expect(planHostFetch({ ...asset, url: 'file:///Users/me/mirror/x.gz' }, file)).toEqual({ skip: expect.stringMatching(/not a web address/) })
    expect(planHostFetch({ ...asset, gzSha256: 'nope' }, file)).toEqual({ skip: expect.stringMatching(/no usable sha256/) })
  })
})

describe.each(SHELLS)('the host\'s download under %s, run for real', (shell) => {
  /** The script as runRemoteSh sends it (its wrapper), asynchronously: a local HTTP server answers meanwhile. */
  const run = (body: string, env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH }): Promise<string> => new Promise((resolve, reject) => {
    execFile(shell, ['-c', wrapRemoteScript(body)], { env, encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${err.message}\n${stderr}`)); return }
      const marked = extractMarkedOutput(stdout)
      if (!marked.found) { reject(new Error(`no markers in: ${stdout}`)); return }
      resolve(marked.body)
    })
  })

  it('over HTTP with the release\'s redirect: checked, kept beside the slot, and the slot\'s own install takes it from there', async () => {
    const seen: string[] = []
    const server = http.createServer((req, res) => {
      seen.push(req.url!)
      if (req.url === '/releases/download/v0.6.99/walnut-0.6.99-linux-x64.gz') {
        res.statusCode = 302
        res.setHeader('location', '/objects/abc')
        res.end()
        return
      }
      if (req.url === '/objects/abc') { res.end(GZ); return }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/download/v0.6.99/walnut-0.6.99-linux-x64.gz`
      expect(parseHostFetchAnswer(await run(script({ url })))).toEqual({ ok: true })
      expect(seen).toEqual(['/releases/download/v0.6.99/walnut-0.6.99-linux-x64.gz', '/objects/abc'])
      expect(fs.readFileSync(part).equals(GZ)).toBe(true)
      // Never under the gz's own name: that is the upload's.
      expect(left()).toEqual([path.basename(part)])
      // The same install as after an upload: unpacked, checked, run as this build's daemon, renamed in, the part gone.
      const installed = execFileSync(shell, ['-c', slotInstallScript(slot, part, sha(FILE), { version: 'walnut-daemon-test' })], { encoding: 'utf8' })
      expect(parseSlotAnswer(installed)).toBe('installed')
      expect(sha(fs.readFileSync(slot))).toBe(sha(FILE))
      expect(left()).toEqual(['daemon-linux-x64'])
    } finally {
      server.close()
    }
  })

  it('curl reads no ~/.curlrc and runs with the HOME it is given (a test server\'s own)', async () => {
    const home = path.join(dir, 'install-home')
    fs.mkdirSync(home)
    // A curlrc that would send the download elsewhere, if it were read.
    fs.writeFileSync(path.join(home, '.curlrc'), `output = "${path.join(dir, 'elsewhere')}"\n`)
    expect(parseHostFetchAnswer(await run(script({ home })))).toEqual({ ok: true })
    expect(fs.readFileSync(part).equals(GZ)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'elsewhere'))).toBe(false)
    expect(script({ home })).toContain(`env HOME='${home}' curl -q `)
  })

  it('the link to the host drops mid-download (no signal reaches the command): it never writes the gz\'s name', async () => {
    // A release host that sends half the file, then the rest once the test says so.
    let rest: (() => void) | null = null
    const server = http.createServer((_req, res) => {
      res.setHeader('content-length', String(GZ.length))
      res.write(GZ.subarray(0, GZ.length >> 1))
      rest = () => res.end(GZ.subarray(GZ.length >> 1))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.gz`
      const child = spawn(shell, ['-c', wrapRemoteScript(script({ url }))], { env: { PATH: SYSTEM_PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      for (let i = 0; i < 200 && !(rest && fs.existsSync(part) && fs.statSync(part).size > 0); i++) await new Promise((r) => setTimeout(r, 50))
      expect(fs.statSync(part).size).toBeGreaterThan(0)
      // What sshd does when the client goes: the command's output has nowhere to go, and nothing else.
      child.stdout!.destroy()
      child.stderr!.destroy()
      rest!()
      await exited
      // It ran to its end: a checked part may stay (the slot's leftovers clear it), the gz's name is never taken.
      expect(fs.existsSync(gz)).toBe(false)
      expect(left()).toEqual([path.basename(part)])
      expect(fs.readFileSync(part).equals(GZ)).toBe(true)
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it('stopped by a signal mid-download (a ^C, a timeout): the part goes', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-length', String(GZ.length))
      res.write(GZ.subarray(0, GZ.length >> 1))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.gz`
      const child = spawn(shell, ['-c', wrapRemoteScript(script({ url }))], { env: { PATH: SYSTEM_PATH }, detached: true, stdio: 'ignore' })
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      for (let i = 0; i < 200 && !(fs.existsSync(part) && fs.statSync(part).size > 0); i++) await new Promise((r) => setTimeout(r, 50))
      expect(fs.statSync(part).size).toBeGreaterThan(0)
      // Its own process group only (spawned detached here): never a broadcast.
      expect(child.pid).toBeGreaterThan(1)
      process.kill(-child.pid!, 'SIGTERM')
      await exited
      // The outer shell goes at once; the script's own subshell runs its trap once curl is gone.
      for (let i = 0; i < 100 && fs.existsSync(part); i++) await new Promise((r) => setTimeout(r, 50))
      expect(left()).toEqual([])
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })

  it('a download that is not the release\'s gz: refused, and nothing is left beside the slot', async () => {
    expect(parseHostFetchAnswer(await run(script({ gzSha256: 'd'.repeat(64) })))).toEqual({ ok: false, reason: 'sha', detail: `got ${sha(GZ)}` })
    expect(left()).toEqual([])
  })

  it('a release that is not there: a failed download, nothing left', async () => {
    const out = await run(script({ url: `file://${path.join(dir, 'missing.gz')}` }))
    expect(parseHostFetchAnswer(out)).toMatchObject({ ok: false, reason: 'download', detail: expect.stringMatching(/^exit \d+/) })
    expect(left()).toEqual([])
  })

  it('a host with neither curl nor wget: no download, nothing written', async () => {
    const PATH = binWith([...BASE_TOOLS, ...SHA_TOOLS])
    expect(parseHostFetchAnswer(await run(script(), { PATH }))).toEqual({ ok: false, reason: 'no-downloader' })
    expect(left()).toEqual([])
  })

  it('a host with no sha256 tool: nothing could check it, so nothing is downloaded', async () => {
    const PATH = binWith([...BASE_TOOLS, 'curl'])
    expect(parseHostFetchAnswer(await run(script(), { PATH }))).toEqual({ ok: false, reason: 'no-sha256' })
    expect(left()).toEqual([])
  })

  it('wget when there is no curl: under `timeout`, without its config, HSTS or HPKP files, one try, with the HOME given', async () => {
    const log = path.join(dir, 'wget.log')
    const home = path.join(dir, 'install-home')
    const PATH = binWith([...BASE_TOOLS, ...SHA_TOOLS], { wget: WGET, timeout: TIMEOUT })
    expect(parseHostFetchAnswer(await run(script({ home }), { PATH, WGET_LOG: log }))).toEqual({ ok: true })
    expect(fs.readFileSync(part).equals(GZ)).toBe(true)
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(calls[0]).toMatch(/ --help$/)
    expect(calls[1]).toMatch(new RegExp(`^HOME=${home} -q +--no-config --no-hsts --no-hpkp --tries=1 -T \\d+ -O ${part} `))
  })

  it('wget with no `timeout` to bound the whole download: no download (wget alone has no such limit)', async () => {
    const log = path.join(dir, 'wget.log')
    const PATH = binWith([...BASE_TOOLS, ...SHA_TOOLS], { wget: WGET })
    expect(parseHostFetchAnswer(await run(script(), { PATH, WGET_LOG: log }))).toEqual({ ok: false, reason: 'no-timeout' })
    expect(fs.existsSync(log)).toBe(false)
    expect(left()).toEqual([])
  })

  it('the size read for the bar: the part\'s bytes while it downloads, nothing before', async () => {
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    expect(parseHostFetchSize(await run(hostFetchSizeScript(gz, token)))).toBeNull()
    fs.writeFileSync(part, Buffer.alloc(12_345))
    expect(parseHostFetchSize(await run(hostFetchSizeScript(gz, token)))).toBe(12_345)
  })
})

describe('the script\'s words', () => {
  it('answers that are cut off read as no answer', () => {
    expect(parseHostFetchAnswer('')).toBeNull()
    expect(parseHostFetchAnswer('noise\nfetch=no reason=no-dir\n')).toEqual({ ok: false, reason: 'no-dir' })
  })

  it('refuses to build a script for a sha256, an address or a part name it cannot quote safely', () => {
    expect(() => script({ gzSha256: 'x' })).toThrow(/64 hex/)
    expect(() => script({ url: 'ftp://host/x' })).toThrow(/web address/)
    expect(() => hostFetchPartPath(gz, '../x')).toThrow(/hex/)
    expect(newFetchToken()).toMatch(/^[0-9a-f]{16}$/)
  })
})
