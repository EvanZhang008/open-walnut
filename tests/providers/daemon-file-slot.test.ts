/**
 * The host side of a compiled Mac's daemon deploy (src/providers/daemon-file-slot.ts):
 * the generated sh runs for real, under /bin/sh, against files in a temp dir that
 * stands in for the host's daemon dir and its Walnut server install.
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSeedAnswer, parseSlotAnswer, seedFromSlotScript, slotCheckScript, slotInstallScript } from '../../src/providers/daemon-file-slot.js'

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const run = (script: string) => execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

let dir = ''
let slot = ''
let app = ''
const FILE = Buffer.concat([Buffer.from('#!/bin/sh\necho walnut\n'), crypto.randomBytes(300_000)])
const OTHER = Buffer.from('#!/bin/sh\necho an older daemon\n')

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-slot-'))
  slot = path.join(dir, 'open-walnut', 'daemon-linux-arm64')
  app = path.join(dir, 'host', 'app', '0.6.99-abc1234', 'walnut')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('the daemon slot on a host', () => {
  it('answers none for an empty slot, have once it holds the file, and never for another file', () => {
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE))))).toBe('none')
    expect(fs.existsSync(path.dirname(slot))).toBe(true)
    fs.writeFileSync(slot, OTHER)
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE))))).toBe('none')
    fs.writeFileSync(slot, FILE)
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE))))).toBe('have')
  })

  it('copies the file from a host server install of it, executable, and leaves no part file', () => {
    fs.mkdirSync(path.dirname(app), { recursive: true })
    fs.writeFileSync(app, FILE)
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    fs.writeFileSync(slot, OTHER)
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE), [path.join(dir, 'missing', 'walnut'), app])))).toBe('copied')
    expect(sha(fs.readFileSync(slot))).toBe(sha(FILE))
    expect(fs.statSync(slot).mode & 0o111).not.toBe(0)
    expect(fs.existsSync(`${slot}.part`)).toBe(false)
    // An install of another build is no source.
    fs.writeFileSync(app, OTHER)
    fs.writeFileSync(slot, OTHER)
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE), [app])))).toBe('none')
  })

  it('installs from the uploaded gz: checked, renamed over the old daemon file, gz removed', () => {
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    fs.writeFileSync(slot, OTHER)
    const before = fs.statSync(slot).ino
    const gz = `${slot}.gz`
    fs.writeFileSync(gz, zlib.gzipSync(FILE))
    expect(parseSlotAnswer(run(slotInstallScript(slot, gz, sha(FILE))))).toBe('installed')
    expect(sha(fs.readFileSync(slot))).toBe(sha(FILE))
    // A rename, never a write into the file a running daemon may still execute.
    expect(fs.statSync(slot).ino).not.toBe(before)
    expect(fs.existsSync(gz)).toBe(false)
    expect(fs.existsSync(`${slot}.part`)).toBe(false)
  })

  it('clears what earlier uploads into the slot left: the gz and the chunks of a cut one', () => {
    const leftovers = () => fs.readdirSync(path.dirname(slot)).filter((n) => n !== path.basename(slot)).sort()
    const strew = () => {
      fs.mkdirSync(`${slot}.gz.chunks-0123456789abcdef`, { recursive: true })
      fs.writeFileSync(`${slot}.gz.chunks-0123456789abcdef/chunk_00000`, 'x')
      fs.writeFileSync(path.join(path.dirname(slot), 'daemon.pid'), '1')
    }
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    strew()
    fs.writeFileSync(`${slot}.gz`, zlib.gzipSync(FILE))
    expect(parseSlotAnswer(run(slotInstallScript(slot, `${slot}.gz`, sha(FILE))))).toBe('installed')
    expect(leftovers()).toEqual(['daemon.pid'])
    // The slot holds it already: nothing is sent, and a cut upload's chunks go too.
    strew()
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE))))).toBe('have')
    expect(leftovers()).toEqual(['daemon.pid'])
    // Copied from a host server install.
    fs.mkdirSync(path.dirname(app), { recursive: true })
    fs.writeFileSync(app, FILE)
    fs.writeFileSync(slot, OTHER)
    strew()
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE), [app])))).toBe('copied')
    expect(leftovers()).toEqual(['daemon.pid'])
    // None: the chunks stay for the upload to resume from.
    fs.writeFileSync(slot, OTHER)
    fs.rmSync(app)
    strew()
    expect(parseSlotAnswer(run(slotCheckScript(slot, sha(FILE), [app])))).toBe('none')
    expect(leftovers()).toEqual(['daemon-linux-arm64.gz.chunks-0123456789abcdef', 'daemon.pid'])
  })

  it('refuses a gz that unpacks to another file, and keeps the daemon file there', () => {
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    fs.writeFileSync(slot, OTHER)
    const gz = `${slot}.gz`
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.from('broken in transit')))
    expect(() => run(slotInstallScript(slot, gz, sha(FILE)))).toThrow(/arrived broken/)
    expect(fs.readFileSync(slot).equals(OTHER)).toBe(true)
    expect(fs.existsSync(`${slot}.part`)).toBe(false)
    // A gz that is not gzip at all.
    fs.writeFileSync(gz, 'not gzip')
    expect(() => run(slotInstallScript(slot, gz, sha(FILE)))).toThrow(/cannot unpack/)
    expect(fs.readFileSync(slot).equals(OTHER)).toBe(true)
  })

  it('seeds a host server install from the slot only when the slot holds that file', () => {
    const gz = path.join(dir, 'host', 'incoming', '0.6.99-abc1234.gz')
    expect(parseSeedAnswer(run(seedFromSlotScript(slot, sha(FILE), gz)))).toBe(false)
    fs.mkdirSync(path.dirname(slot), { recursive: true })
    fs.writeFileSync(slot, OTHER)
    expect(parseSeedAnswer(run(seedFromSlotScript(slot, sha(FILE), gz)))).toBe(false)
    expect(fs.existsSync(gz)).toBe(false)
    fs.writeFileSync(slot, FILE)
    expect(parseSeedAnswer(run(seedFromSlotScript(slot, sha(FILE), gz)))).toBe(true)
    // The install script unpacks it and checks the same sha256.
    expect(sha(zlib.gunzipSync(fs.readFileSync(gz)))).toBe(sha(FILE))
    expect(fs.existsSync(`${gz}.seed`)).toBe(false)
  })

  it('quotes every path: a home with a space and a quote stays one word', () => {
    const odd = path.join(dir, "John's home", 'open-walnut', 'daemon-linux-x64')
    const gz = `${odd}.gz`
    fs.mkdirSync(path.dirname(odd), { recursive: true })
    fs.writeFileSync(gz, zlib.gzipSync(FILE))
    expect(parseSlotAnswer(run(slotInstallScript(odd, gz, sha(FILE))))).toBe('installed')
    expect(parseSlotAnswer(run(slotCheckScript(odd, sha(FILE))))).toBe('have')
  })

  it('takes only a sha256 of 64 hex characters', () => {
    expect(() => slotCheckScript(slot, 'abc')).toThrow(/64 hex/)
    expect(() => slotInstallScript(slot, `${slot}.gz`, "'; rm -rf / #")).toThrow(/64 hex/)
    expect(() => seedFromSlotScript(slot, 'Z'.repeat(64), '/tmp/x.gz')).toThrow(/64 hex/)
  })
})
