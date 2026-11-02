/**
 * walnut-net downloaded by a daemon whose install has none (src/providers/net-binary.ts):
 * the file is kept only when its SHA-256 matches (the pin, else the release's SHA256SUMS),
 * a mismatch leaves nothing under the final name, and the version pinned in code is the
 * crate's (native/walnut-net/Cargo.toml), so a release and the code never disagree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { NET_BIN_SHA256, NET_BIN_TAG, NET_BIN_VERSION, fetchNetBinary, netAssetName, netBinTarget, sumFor } from '../../src/providers/net-binary.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-net-bin-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const BODY = Buffer.from('#!/bin/sh\necho walnut-net 0.1.0\n')
const GZ = zlib.gzipSync(BODY)
const SHA = crypto.createHash('sha256').update(GZ).digest('hex')

function fakeFetch(files: Record<string, Buffer | string>, seen: string[] = []): typeof fetch {
  return (async (url: string) => {
    seen.push(String(url))
    const name = String(url).split('/').slice(-2).join('/')
    const body = files[name]
    if (body === undefined) return new Response('no', { status: 404 })
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 })
  }) as unknown as typeof fetch
}

describe('net-binary', () => {
  it('pins the crate version', () => {
    const cargo = fs.readFileSync(path.resolve(__dirname, '../../native/walnut-net/Cargo.toml'), 'utf8')
    expect(/^version = "(.+)"$/m.exec(cargo)?.[1]).toBe(NET_BIN_VERSION)
    expect(NET_BIN_TAG).toBe(`walnut-net-v${NET_BIN_VERSION}`)
  })

  it('names the four targets and nothing else', () => {
    expect(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((t) => t.split('-') as [string, string]).map(([p, a]) => netBinTarget(p, a)))
      .toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    expect(netBinTarget('win32', 'x64')).toBeNull()
    expect(netBinTarget('linux', 'ia32')).toBeNull()
  })

  it('reads SHA256SUMS lines', () => {
    const a = netAssetName('linux-x64')
    expect(sumFor(`${SHA}  ${a}\n${'0'.repeat(64)}  other.gz\n`, a)).toBe(SHA)
    expect(sumFor(`${SHA} *${a}`, a)).toBe(SHA)
    expect(sumFor('garbage', a)).toBeNull()
  })

  it('installs a file that matches the release SHA256SUMS', async () => {
    const asset = netAssetName('linux-x64')
    const seen: string[] = []
    const got = await fetchNetBinary({
      dir, base: 'https://example.invalid/dl', platform: 'linux', arch: 'x64', pins: {},
      fetchImpl: fakeFetch({ [`${NET_BIN_TAG}/${asset}`]: GZ, [`${NET_BIN_TAG}/SHA256SUMS`]: `${SHA}  ${asset}\n` }, seen),
    })
    expect(got).toBe(path.join(dir, `walnut-net-${NET_BIN_VERSION}`))
    expect(fs.readFileSync(got)).toEqual(BODY)
    expect(fs.statSync(got).mode & 0o777).toBe(0o755)
    expect(seen).toEqual([`https://example.invalid/dl/${NET_BIN_TAG}/SHA256SUMS`, `https://example.invalid/dl/${NET_BIN_TAG}/${asset}`])
  })

  it('refuses a file that does not match, and keeps nothing', async () => {
    const asset = netAssetName('linux-x64')
    await expect(fetchNetBinary({
      dir, base: 'https://example.invalid/dl', platform: 'linux', arch: 'x64', pins: {},
      fetchImpl: fakeFetch({ [`${NET_BIN_TAG}/${asset}`]: zlib.gzipSync(Buffer.from('evil')), [`${NET_BIN_TAG}/SHA256SUMS`]: `${SHA}  ${asset}\n` }),
    })).rejects.toThrow(/not the expected/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('refuses when the release does not list the file, or is not there', async () => {
    await expect(fetchNetBinary({ dir, base: 'https://example.invalid/dl', platform: 'darwin', arch: 'arm64', pins: {}, fetchImpl: fakeFetch({ [`${NET_BIN_TAG}/SHA256SUMS`]: '' }) }))
      .rejects.toThrow(/does not list/)
    await expect(fetchNetBinary({ dir, base: 'https://example.invalid/dl', platform: 'darwin', arch: 'arm64', pins: {}, fetchImpl: fakeFetch({}) }))
      .rejects.toThrow(/HTTP 404/)
    await expect(fetchNetBinary({ dir, platform: 'win32', arch: 'x64', fetchImpl: fakeFetch({}) })).rejects.toThrow(/no build/)
  })

  it('pins every target of the published release, and a pin outranks the release\'s own SHA256SUMS', async () => {
    expect(Object.keys(NET_BIN_SHA256).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    for (const v of Object.values(NET_BIN_SHA256)) expect(v).toMatch(/^[0-9a-f]{64}$/)
    // A release whose SHA256SUMS was swapped along with the file is still refused.
    const asset = netAssetName('linux-x64')
    const seen: string[] = []
    await expect(fetchNetBinary({
      dir, base: 'https://example.invalid/dl', platform: 'linux', arch: 'x64',
      fetchImpl: fakeFetch({ [`${NET_BIN_TAG}/${asset}`]: GZ, [`${NET_BIN_TAG}/SHA256SUMS`]: `${SHA}  ${asset}\n` }, seen),
    })).rejects.toThrow(/not the expected/)
    expect(seen).toEqual([`https://example.invalid/dl/${NET_BIN_TAG}/${asset}`])
    expect(fs.readdirSync(dir)).toEqual([])
  })
})
