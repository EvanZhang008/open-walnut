import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerOwnedProviderAdapter,
  removeOwnedProviderAdapters,
  resetAllAdapters,
  resolveProvider,
} from '../../../src/agent/providers/registry.js'
import type { ProtocolAdapter } from '../../../src/agent/providers/types.js'

function adapter(protocol = 'plugin-a:custom'): ProtocolAdapter {
  return {
    protocol,
    sendMessage: vi.fn(async () => ({ content: [], stopReason: 'end_turn' })),
    sendMessageStream: vi.fn(async () => ({ content: [], stopReason: 'end_turn' })),
    resetClient: vi.fn(),
  }
}

afterEach(() => {
  removeOwnedProviderAdapters('plugin-a')
  resetAllAdapters()
})

describe('owner-scoped Plugin provider adapters', () => {
  it('resolves a custom protocol until its owner disposes the registration', () => {
    const custom = adapter()
    const registration = registerOwnedProviderAdapter('plugin-a', custom.protocol, custom)
    const providers = { custom: { api: custom.protocol } }

    expect(resolveProvider('custom', providers).adapter).toBe(custom)

    registration.dispose()
    expect(() => resolveProvider('custom', providers)).toThrow('Unknown protocol')
  })

  it('refreshes but does not remove Plugin adapters', () => {
    const custom = adapter()
    registerOwnedProviderAdapter('plugin-a', custom.protocol, custom)

    resetAllAdapters()

    expect(custom.resetClient).toHaveBeenCalledOnce()
    expect(resolveProvider('custom', { custom: { api: custom.protocol } }).adapter).toBe(custom)
  })

  it('does not allow a Plugin to replace builtin protocols or mismatch ids', () => {
    expect(() => registerOwnedProviderAdapter('plugin-a', 'bedrock', adapter('bedrock')))
      .toThrow('cannot replace a builtin')
    expect(() => registerOwnedProviderAdapter('plugin-a', 'plugin-a:one', adapter('plugin-a:two')))
      .toThrow('does not match')
  })
})
