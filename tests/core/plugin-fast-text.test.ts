/**
 * `walnut.model.fastText`, the host half (C29, C87): one short answer on the user's configured
 * MAIN provider. The call never names a provider (so sendMessage resolves the user's own), the
 * model comes from `fastModelFor`, and the direct-route picker (which chooses ANOTHER configured
 * provider) is never involved. Work mail may only go where the user already sends everything else.
 */
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMessage = vi.fn()
let config: Record<string, unknown> = {}

vi.mock('../../src/model/model.js', () => ({ sendMessage: (...args: unknown[]) => sendMessage(...args) }))
vi.mock('../../src/core/config-manager.js', () => ({ getConfig: async () => config }))

import { pluginFastText, setPluginFastTextOverride, setPluginFastTextTestGuard } from '../../src/core/plugins/plugin-fast-text.js'
import { fastModelFor } from '../../src/core/cheap-model.js'

beforeEach(() => {
  sendMessage.mockReset()
  sendMessage.mockResolvedValue({ content: [{ type: 'text', text: ' {"when":{"from":"a@*"},' }, { type: 'text', text: '"then":"Important"} ' }] })
  config = { agent: { fast_model: 'fast-model-x' } }
  // `sendMessage` is mocked here, so the real path may run.
  setPluginFastTextTestGuard(false)
})

afterEach(() => {
  setPluginFastTextOverride(null)
  setPluginFastTextTestGuard(true)
})

describe('pluginFastText', () => {
  it('calls sendMessage with NO provider field and the model fastModelFor picks', async () => {
    const text = await pluginFastText({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], maxTokens: 300 })
    expect(text).toBe('{"when":{"from":"a@*"},"then":"Important"}')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0]![0] as { system: string; messages: unknown[]; config: Record<string, unknown> }
    expect(call.system).toBe('sys')
    expect(call.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(call.config).toEqual({ maxTokens: 300, model: fastModelFor(config as never) })
    expect(call.config.model).toBe('fast-model-x')
    expect('provider' in call).toBe(false)
    expect('provider' in call.config).toBe(false)
  })

  it('omits the model entirely when fastModelFor has none (sendMessage then uses the main model)', async () => {
    config = { agent: { main_provider: 'no-such-provider-in-catalog' } }
    await pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 50 })
    const call = sendMessage.mock.calls[0]![0] as { config: Record<string, unknown> }
    expect(fastModelFor(config as never)).toBeUndefined()
    expect(call.config).toEqual({ maxTokens: 50 })
  })

  it('caps maxTokens so a plugin cannot ask for a huge non-stream call', async () => {
    await pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 64_000 })
    expect((sendMessage.mock.calls[0]![0] as { config: { maxTokens: number } }).config.maxTokens).toBe(2_048)
  })

  it('passes the abort signal through', async () => {
    const controller = new AbortController()
    await pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10, signal: controller.signal })
    expect((sendMessage.mock.calls[0]![0] as { signal: AbortSignal }).signal).toBe(controller.signal)
  })

  it('the test override replaces the real call entirely (test servers never reach a model)', async () => {
    const fake = vi.fn(async () => 'canned')
    setPluginFastTextOverride(fake)
    expect(await pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 })).toBe('canned')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('in a test run with no override it refuses before any model call', async () => {
    setPluginFastTextTestGuard(true)
    await expect(pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }))
      .rejects.toThrow('No model call in a test run')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('a provider error reaches the caller (the plugin maps it to status unavailable)', async () => {
    sendMessage.mockRejectedValueOnce(new Error('no credentials'))
    await expect(pluginFastText({ system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 })).rejects.toThrow('no credentials')
  })
})

describe('the seam stays on the main provider (grep)', () => {
  const read = (relative: string) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8')

  it('plugin-fast-text never uses the direct route or a third-party endpoint', () => {
    const text = read('../../src/core/plugins/plugin-fast-text.ts').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')
    expect(text).not.toMatch(/directFastRoute|openrouter|jev/i)
    expect(text).not.toMatch(/provider\s*:/)
  })

  it('the plugin api adds exactly one model method', () => {
    const text = read('../../packages/plugin-api/src/server.ts')
    const block = /export interface ModelService \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
    expect(block.match(/^\s{2}[a-zA-Z]+\(/gm)).toEqual(['  fastText('])
  })

  it('the mail plugin imports neither the model layer nor getConfig', () => {
    const dir = new URL('../../src/integrations/mail/', import.meta.url)
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue
      const text = fs.readFileSync(new URL(name, dir), 'utf8')
      expect(text, name).not.toMatch(/from '\.\.\/\.\.\/model\//)
      expect(text, name).not.toMatch(/getConfig\s*\(/)
      expect(text, name).not.toMatch(/directFastRoute/)
    }
  })
})
