import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { MAX_PLUGIN_WEB_MODULE_BYTES } from '../../../src/core/plugins/plugin-web-module.js'

const callPrimaryControlMock = vi.hoisted(() => vi.fn())

vi.mock('../../../src/web/routes/v1-control-relay.js', () => ({
  callPrimaryControl: callPrimaryControlMock,
}))

import {
  callPrimaryPluginOp,
  listPrimaryPluginOps,
  listPrimaryPluginWebModules,
  managePrimaryPlugin,
  PluginRuntimeRelayError,
  prunePluginWebModuleCache,
  readPrimaryPluginWebModule,
  relayPrimaryPluginHttpRequest,
} from '../../../src/web/routes/plugin-runtime-bridge.js'

const cacheRoot = path.join(WALNUT_HOME, 'cache', 'plugin-web-modules')

function hash(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function relayModule(
  content: string | Buffer,
  overrides: Record<string, unknown> = {},
): { ok: true; result: Record<string, unknown> } {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return {
    ok: true,
    result: {
      id: 'sample',
      name: 'Sample',
      version: '1.2.3',
      hash: hash(buffer),
      size: buffer.byteLength,
      data: buffer.toString('base64'),
      ...overrides,
    },
  }
}

beforeEach(async () => {
  callPrimaryControlMock.mockReset()
  await fs.rm(cacheRoot, { recursive: true, force: true })
})

afterEach(async () => {
  await fs.rm(cacheRoot, { recursive: true, force: true })
})

describe('cloud Plugin runtime relay', () => {
  it('validates diagnostics and deduplicates the primary module catalogue', async () => {
    const firstHash = 'a'.repeat(64)
    const secondHash = 'b'.repeat(64)
    callPrimaryControlMock.mockResolvedValue({
      ok: true,
      result: {
        plugins: [
          { id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0 },
          { id: '../escape', name: 'Unsafe', state: 'active', builtin: false, failureCount: 0 },
        ],
        tombstones: [
          { id: 'old', name: 'Old', reason: 'disabled', at: '2026-08-01T00:00:00.000Z' },
          { id: 'bad', name: 'Bad', reason: 'invented', at: '2026-08-01T00:00:00.000Z' },
        ],
        modules: [
          { id: 'sample', name: 'Old', hash: firstHash, size: 1 },
          { id: '../escape', name: 'Unsafe', hash: firstHash, size: 1 },
          { id: 'sample', name: 'Current', version: '2.0.0', hash: secondHash, size: 2 },
          { id: 'huge', name: 'Huge', hash: firstHash, size: MAX_PLUGIN_WEB_MODULE_BYTES + 1 },
        ],
        errors: [
          { id: 'broken', error: 'missing bundle' },
          { id: 42, error: 'ignored' },
        ],
      },
    })

    await expect(listPrimaryPluginWebModules()).resolves.toEqual({
      plugins: [{ id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0 }],
      tombstones: [{ id: 'old', name: 'Old', reason: 'disabled', at: '2026-08-01T00:00:00.000Z' }],
      modules: [{ id: 'sample', name: 'Current', version: '2.0.0', hash: secondHash, size: 2 }],
      errors: [{ id: 'broken', error: 'missing bundle' }],
    })
    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.plugin-runtime',
      '__server__',
      undefined,
      15_000,
    )
  })

  it('maps bridge and version-skew failures to HTTP-ready errors', async () => {
    callPrimaryControlMock.mockResolvedValueOnce({
      ok: false,
      failure: { kind: 'bridge_offline', message: 'offline' },
    })
    await expect(listPrimaryPluginWebModules()).rejects.toMatchObject({
      name: 'PluginRuntimeRelayError',
      message: 'offline',
      status: 503,
    })

    callPrimaryControlMock.mockResolvedValueOnce({
      ok: false,
      failure: { kind: 'needs_upgrade', message: 'upgrade required' },
    })
    await expect(readPrimaryPluginWebModule('sample')).rejects.toMatchObject({
      status: 501,
      message: 'upgrade required',
    })
  })

  it('caches verified bytes by Plugin id and content hash', async () => {
    const source = 'export const cached = true\n'
    const expectedHash = hash(source)
    callPrimaryControlMock.mockResolvedValue(relayModule(source))

    const first = await readPrimaryPluginWebModule('sample', expectedHash)
    const second = await readPrimaryPluginWebModule('sample', expectedHash)

    expect(first.content.toString()).toBe(source)
    expect(second.content.toString()).toBe(source)
    expect(callPrimaryControlMock).toHaveBeenCalledOnce()
    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.plugin-web-module',
      '__server__',
      { pluginId: 'sample', expectedHash },
      15_000,
    )
  })

  it('replaces a corrupt cache entry with revalidated primary bytes', async () => {
    const source = 'export const repaired = true\n'
    const expectedHash = hash(source)
    callPrimaryControlMock.mockResolvedValue(relayModule(source))
    await readPrimaryPluginWebModule('sample', expectedHash)

    const file = path.join(cacheRoot, `sample-${expectedHash}.mjs`)
    await fs.writeFile(file, 'corrupt')
    const repaired = await readPrimaryPluginWebModule('sample', expectedHash)

    expect(repaired.content.toString()).toBe(source)
    expect(callPrimaryControlMock).toHaveBeenCalledTimes(2)
    expect(await fs.readFile(file, 'utf8')).toBe(source)
  })

  it('rejects unsafe ids, stale hashes, malformed sizes, and changed bytes', async () => {
    await expect(readPrimaryPluginWebModule('../escape')).rejects.toMatchObject({ status: 400 })
    await expect(readPrimaryPluginWebModule('sample', 'bad-hash')).rejects.toMatchObject({ status: 400 })
    expect(callPrimaryControlMock).not.toHaveBeenCalled()

    const source = 'export const current = true\n'
    callPrimaryControlMock.mockResolvedValueOnce(relayModule(source))
    await expect(readPrimaryPluginWebModule('sample', 'a'.repeat(64))).rejects.toMatchObject({ status: 409 })

    callPrimaryControlMock.mockResolvedValueOnce(relayModule(source, { size: Buffer.byteLength(source) + 1 }))
    await expect(readPrimaryPluginWebModule('sample')).rejects.toMatchObject({ status: 502 })

    callPrimaryControlMock.mockResolvedValueOnce(relayModule(source, { hash: 'b'.repeat(64) }))
    await expect(readPrimaryPluginWebModule('sample')).rejects.toMatchObject({ status: 502 })

    callPrimaryControlMock.mockResolvedValueOnce(relayModule('', { size: MAX_PLUGIN_WEB_MODULE_BYTES + 1 }))
    await expect(readPrimaryPluginWebModule('sample')).rejects.toMatchObject({ status: 413 })
  })

  it('keeps concurrent cache fills atomic', async () => {
    const source = 'export const concurrent = true\n'
    const expectedHash = hash(source)
    callPrimaryControlMock.mockResolvedValue(relayModule(source))

    const modules = await Promise.all(
      Array.from({ length: 5 }, () => readPrimaryPluginWebModule('sample', expectedHash)),
    )
    expect(modules.every((module) => module.content.toString() === source)).toBe(true)

    callPrimaryControlMock.mockClear()
    const cached = await readPrimaryPluginWebModule('sample', expectedHash)
    expect(cached.content.toString()).toBe(source)
    expect(callPrimaryControlMock).not.toHaveBeenCalled()
  })

  it('prunes only stale module builds that are absent from the current catalogue', async () => {
    const now = Date.now()
    const currentHash = 'a'.repeat(64)
    const oldHash = 'b'.repeat(64)
    const recentHash = 'c'.repeat(64)
    await fs.mkdir(cacheRoot, { recursive: true })
    const current = path.join(cacheRoot, `sample-${currentHash}.mjs`)
    const old = path.join(cacheRoot, `sample-${oldHash}.mjs`)
    const recent = path.join(cacheRoot, `sample-${recentHash}.mjs`)
    await Promise.all([current, old, recent].map((file) => fs.writeFile(file, 'x')))
    await fs.utimes(old, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000))
    await fs.utimes(current, new Date(now - 8 * 24 * 60 * 60 * 1_000), new Date(now - 8 * 24 * 60 * 60 * 1_000))

    await prunePluginWebModuleCache([
      { id: 'sample', name: 'Sample', hash: currentHash, size: 1 },
    ], now)

    await expect(fs.stat(current)).resolves.toBeDefined()
    await expect(fs.stat(recent)).resolves.toBeDefined()
    await expect(fs.stat(old)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('relays Plugin ops and lifecycle management with validation', async () => {
    callPrimaryControlMock.mockResolvedValueOnce({
      ok: true,
      result: {
        ops: [
          { name: 'task_get', title: 'Get task', readonly: true },
          { name: 'Bad Name', title: 'Ignored', readonly: true },
        ],
      },
    })
    await expect(listPrimaryPluginOps('sample')).resolves.toEqual([
      { name: 'task_get', title: 'Get task', readonly: true },
    ])

    callPrimaryControlMock.mockResolvedValueOnce({ ok: true, result: { ok: true, result: { value: 1 } } })
    await expect(callPrimaryPluginOp('sample', 'task_get', { id: 'abc' })).resolves.toEqual({
      ok: true,
      result: { value: 1 },
    })

    callPrimaryControlMock.mockResolvedValueOnce({
      ok: true,
      result: { plugin: { id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0 } },
    })
    await expect(managePrimaryPlugin('sample', 'reload')).resolves.toEqual({
      plugin: { id: 'sample', name: 'Sample', state: 'active', builtin: false, failureCount: 0 },
    })
    expect(callPrimaryControlMock).toHaveBeenLastCalledWith(
      'server.plugin-manage',
      '__server__',
      { pluginId: 'sample', operation: 'reload' },
      30_000,
    )

    await expect(callPrimaryPluginOp('sample', 'Bad Name', {})).rejects.toMatchObject({ status: 400 })
  })

  it('relays bounded raw Plugin HTTP requests and filters credentials', async () => {
    const responseBody = Buffer.from('created')
    callPrimaryControlMock.mockResolvedValue({
      ok: true,
      result: {
        status: 201,
        headers: { 'content-type': 'text/plain', connection: 'close' },
        size: responseBody.byteLength,
        data: responseBody.toString('base64'),
      },
    })

    const response = await relayPrimaryPluginHttpRequest({
      pluginId: 'sample',
      method: 'POST',
      path: '/webhook?source=test',
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        'content-type': 'application/octet-stream',
        'x-signature': 'abc',
      },
      body: Buffer.from([0, 1, 2, 255]),
    })

    expect(response).toEqual({
      status: 201,
      headers: { 'content-type': 'text/plain' },
      body: responseBody,
    })
    expect(callPrimaryControlMock).toHaveBeenCalledWith(
      'server.plugin-http',
      '__server__',
      expect.objectContaining({
        pluginId: 'sample',
        method: 'POST',
        path: '/webhook?source=test',
        headers: {
          'content-type': 'application/octet-stream',
          'x-signature': 'abc',
        },
        size: 4,
        data: Buffer.from([0, 1, 2, 255]).toString('base64'),
      }),
      15_000,
    )

    callPrimaryControlMock.mockClear()
    await expect(relayPrimaryPluginHttpRequest({
      pluginId: 'sample',
      method: 'POST',
      path: '/webhook',
      headers: {},
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ status: 413 })
    expect(callPrimaryControlMock).not.toHaveBeenCalled()

    for (const unsafePath of [
      '/../config',
      '/safe/../../config',
      '/%2e%2e/%2e%2e/config',
      '/%252e%252e/config',
      '/..\\..\\config',
    ]) {
      await expect(relayPrimaryPluginHttpRequest({
        pluginId: 'sample',
        method: 'GET',
        path: unsafePath,
        headers: {},
        body: Buffer.alloc(0),
      })).rejects.toMatchObject({ status: 400 })
    }
    expect(callPrimaryControlMock).not.toHaveBeenCalled()
  })

  it('preserves explicit relay status codes', () => {
    const error = new PluginRuntimeRelayError('conflict', 409)
    expect(error).toMatchObject({ name: 'PluginRuntimeRelayError', status: 409 })
  })
})
