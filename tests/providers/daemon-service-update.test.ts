import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { updateRemoteDaemonService } from '../../src/providers/daemon-service-update.js'

let root: string
let binary: string
const version = 'walnut-daemon-1234abcd'
const remote = '/tmp/open-walnut-update.Abc123xyz9'

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-update-test-'))
  binary = path.join(root, 'daemon')
  await fs.writeFile(binary, randomBytes(800_000))
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

function lab(fault?: 'chunk' | 'version' | 'checksum' | 'service' | 'transport' | 'path') {
  const chunks = new Map<number, Buffer>()
  const calls: string[] = []
  const slots: number[] = []
  let retried = false
  const chunk = vi.fn(async (data: Buffer, directory: string, index: number) => {
    expect(directory).toBe(remote)
    expect(data.length).toBeLessThanOrEqual(262_144)
    slots.push(index)
    if (fault === 'chunk' || !retried) { retried = true; return false }
    chunks.set(index, Buffer.from(data))
    return true
  })
  const run = vi.fn(async (command: string) => {
    calls.push(command)
    if (command.includes('mktemp -d')) return fault === 'path' ? `${remote}; unwanted` : remote
    if (command.includes('sha256sum')) {
      if (fault === 'checksum') throw new Error('checksum mismatch')
      const indices = [...command.matchAll(/chunk_(\d+)/g)].map((match) => Number(match[1]))
      expect(indices.every((index) => chunks.has(index))).toBe(true)
      const payload = Buffer.concat(indices.map((index) => chunks.get(index)!))
      expect(command).toContain(createHash('sha256').update(payload).digest('hex'))
      expect(gunzipSync(payload)).toEqual(await fs.readFile(binary))
      return fault === 'version' ? 'different-build' : version
    }
    expect(command).toBe(`${remote}/daemon walnut daemon update --yes --scope user --executable ${remote}/daemon`)
    if (fault === 'transport') throw new Error('connection lost')
    return fault === 'service' ? JSON.stringify({ ok: false, failure: { message: 'busy', rollback: 'unchanged' } }) : '{"ok":true}'
  })
  return { run, chunk, calls, slots }
}

describe('managed daemon upload and update', () => {
  it('reassembles only confirmed chunks, verifies bytes and version, then requests a user service update', async () => {
    const l = lab()
    await updateRemoteDaemonService(binary, version, l)
    expect(l.chunk.mock.calls.length).toBeGreaterThan(3)
    expect(new Set(l.slots).size).toBe(l.slots.length)
    expect(l.calls).toHaveLength(3)
    expect(l.calls.join('\n')).not.toMatch(/sudo|nohup|kill|enable/)
    expect(l.run.mock.calls[2][1]).toBe(600_000)
  })

  it.each(['chunk', 'version', 'checksum', 'path'] as const)('does not touch the service after a %s failure', async (fault) => {
    const l = lab(fault)
    await expect(updateRemoteDaemonService(binary, version, l)).rejects.toThrow()
    expect(l.calls.some((command) => command.includes('daemon update'))).toBe(false)
    if (fault === 'chunk') expect(l.chunk).toHaveBeenCalledTimes(3)
    if (fault === 'path') expect(l.chunk).not.toHaveBeenCalled()
  })

  it.each(['service', 'transport'] as const)('does not retry or start an unmanaged replacement after a %s failure', async (fault) => {
    const l = lab(fault)
    await expect(updateRemoteDaemonService(binary, version, l)).rejects.toThrow()
    expect(l.calls.filter((command) => command.includes('daemon update'))).toHaveLength(1)
    expect(l.calls.join('\n')).not.toContain('--start')
  })

  it('rejects an invalid build version before any remote operation', async () => {
    const l = lab()
    await expect(updateRemoteDaemonService(binary, 'build; invalid', l)).rejects.toThrow('Invalid daemon build version')
    expect(l.run).not.toHaveBeenCalled()
  })
})
