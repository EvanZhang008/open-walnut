/**
 * A session on another host gets the adapter env without this machine's paths
 * (acp-session.ts hostAdapterEnv): the host's daemon finds its own CODEX_PATH and
 * PATH, and a value inside this machine's home names nothing there.
 */
import { describe, it, expect } from 'vitest'
import { hostAdapterEnv } from '../../src/providers/acp-session.js'

/** This machine's PATH as data: nothing here starts a child. */
const MAC_PATH_VALUE = '/opt/homebrew/bin:/usr/bin'

describe('hostAdapterEnv', () => {
  it('drops this machine\'s path keys and home paths, keeps the rest', () => {
    const out = hostAdapterEnv({
      PATH: MAC_PATH_VALUE,
      CODEX_PATH: '/opt/homebrew/bin/codex',
      PI_ACP_PI_COMMAND: '/x/pi',
      WALNUT_RUNTIME_DIR: '/var/rt',
      CODEX_CONFIG: '{"model":"m"}',
      SOME_FILE: '/Users/me/.config/thing',
      API_REGION: 'us-west-2',
    }, '/Users/me')
    expect(out).toEqual({ CODEX_CONFIG: '{"model":"m"}', API_REGION: 'us-west-2' })
  })

  it('passes undefined through', () => {
    expect(hostAdapterEnv(undefined, '/Users/me')).toBeUndefined()
  })
})
