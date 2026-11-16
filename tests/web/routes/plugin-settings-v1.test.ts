/**
 * An AI configures a plugin through the ops every agent has, end to end on a real server:
 * plugin_settings reads a plugin (by id or name) with its secrets masked, plugin_settings_set
 * writes config.yaml and tells every open console (`config:changed`), refuses a secret or a bad
 * value with nothing written, and the plugin's settings form reads the new value.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-plugin-settings-v1'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { registry } from '../../../src/core/integration-registry.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'
import { executeOp } from '../../../src/ops/index.js'

const PLUGIN = 'acme-relay'
// Built at run time so no secret-shaped literal sits in the source.
const SECRET = ['stored', 'value', 'for', 'acme'].join('-')

let server: HttpServer
let apiBase = ''
const changes: string[] = []

const call = (name: string, args: Record<string, unknown>) => executeOp(name, args, { apiBase })
async function onDisk(): Promise<Record<string, any>> {
  return (yaml.load(await fs.readFile(CONFIG_FILE, 'utf-8')) as Record<string, any>).plugins[PLUGIN]
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Owner' },
    plugins: {
      [PLUGIN]: {
        enabled: true,
        default_model: 'model-a',
        api_key: SECRET,
        endpoints: [{ name: 'hub', host: 'box', port: 19402 }],
      },
    },
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  registry.register(PLUGIN, createMockPlugin({
    id: PLUGIN, name: 'Acme Relay',
    configSchema: {
      type: 'object',
      properties: {
        default_model: { type: 'string' },
        poll_seconds: { type: 'integer', minimum: 5 },
        api_key: { type: 'string' },
      },
    },
    uiHints: { default_model: { label: 'Default model' } },
  }))
  bus.subscribe('plugin-settings-probe', (event) => {
    if (event.name === EventNames.CONFIG_CHANGED) changes.push(JSON.stringify(event.data ?? null))
  }, { global: true })
}, 120_000)

afterAll(async () => {
  bus.unsubscribe('plugin-settings-probe')
  registry.unregister?.(PLUGIN)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('plugin_settings', () => {
  it('lists the running plugins and reads one by name, secrets masked', async () => {
    const list = await call('plugin_settings', {})
    expect(list.ok).toBe(true)
    const plugins = (list as { result: { plugins: Array<{ id: string }> } }).result.plugins
    expect(plugins.map((p) => p.id)).toContain(PLUGIN)

    const one = await call('plugin_settings', { plugin: 'acme relay' })
    expect(one.ok).toBe(true)
    const view = (one as { result: Record<string, any> }).result
    expect(view.id).toBe(PLUGIN)
    expect(view.page).toBe(`/apps?plugin=${PLUGIN}`)
    const keys = view.fields.map((f: { key: string }) => f.key)
    expect(keys).toEqual(['default_model', 'poll_seconds', 'api_key', 'endpoints'])
    expect(JSON.stringify(view)).not.toContain(SECRET)
    expect(view.fields.find((f: { key: string }) => f.key === 'api_key')).toMatchObject({ secret: true, set: true })
  })

  it('names the running plugins when asked for one that is not there', async () => {
    const res = await call('plugin_settings', { plugin: 'no-such-plugin' })
    expect(res.ok).toBe(false)
    expect((res as { message: string }).message).toContain(PLUGIN)
  })
})

describe('plugin_settings_set', () => {
  it('writes a valid change, says what changed, and tells every console', async () => {
    changes.length = 0
    const res = await call('plugin_settings_set', {
      plugin: PLUGIN,
      set: { default_model: 'model-b', endpoints: [{ name: 'hub', host: 'box', port: 19402 }, { name: 'spoke', host: 'box', port: 19403 }] },
    })
    expect(res.ok).toBe(true)
    const result = (res as { result: Record<string, any> }).result
    expect(result.written).toBe(true)
    expect(result.outcome).toContain('Default model: "model-a" -> "model-b"')
    const stored = await onDisk()
    expect(stored).toMatchObject({ enabled: true, default_model: 'model-b', api_key: SECRET })
    expect(stored.endpoints).toHaveLength(2)
    expect(changes.some((c) => c.includes('model-b'))).toBe(true)
    expect(changes.join('\n')).not.toContain(SECRET)

    // The plugin's settings form reads it.
    const form = await (await fetch(`${apiBase}/api/integrations/settings`)).json() as Array<{ id: string; values: Record<string, unknown> }>
    expect(form.find((p) => p.id === PLUGIN)?.values.default_model).toBe('model-b')
  })

  it('never writes a secret, and writes nothing else in that call', async () => {
    const before = await onDisk()
    const res = await call('plugin_settings_set', { plugin: PLUGIN, set: { api_key: 'sk-made-up-by-an-ai', default_model: 'model-c' } })
    expect(res.ok).toBe(false)
    expect((res as { message: string }).message).toContain('nothing written')
    expect(await onDisk()).toEqual(before)
  })

  it('refuses a value the plugin does not take, with the reason', async () => {
    const before = await onDisk()
    const res = await executeOp('plugin_settings_set', { plugin: PLUGIN, set: { poll_seconds: 2 } }, { apiBase })
    expect(res.ok).toBe(false)
    const raw = await fetch(`${apiBase}/api/v1/plugin-settings/${PLUGIN}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ set: { poll_seconds: 2 } }),
    })
    const body = await raw.json() as { refused: Array<{ key: string; reason: string }> }
    expect(body.refused).toEqual([{ key: 'poll_seconds', label: 'poll_seconds', reason: 'poll_seconds: must be at least 5' }])
    expect(await onDisk()).toEqual(before)
  })

  it('removes a setting so its default applies', async () => {
    const res = await call('plugin_settings_set', { plugin: PLUGIN, unset: ['default_model'] })
    expect(res.ok).toBe(true)
    expect(await onDisk()).not.toHaveProperty('default_model')
  })
})
