/**
 * Secrets editor (web/src/components/settings/sections/secret-hosts.ts): its Save changes only the
 * hosts the person ticked or unticked in it, so a host's own "This host" copy switch flipped while
 * the editor was open is kept (review: the Save wrote back the list it opened with).
 */
import { describe, expect, it } from 'vitest'
import { mergeSecretHosts, tickSecretHost } from '../../web/src/components/settings/sections/secret-hosts'

describe('mergeSecretHosts', () => {
  it('a switch flipped elsewhere while the editor is open stands', () => {
    // Opened with devbox; This host then added gpu-box and took devbox off; the editor ticked nothing.
    expect(mergeSecretHosts(['gpu-box'], ['devbox'], ['devbox'])).toEqual(['gpu-box'])
    expect(mergeSecretHosts(['devbox', 'gpu-box'], ['devbox'], ['devbox'])).toEqual(['devbox', 'gpu-box'])
  })
  it('the ticks made in the editor win for their hosts', () => {
    expect(mergeSecretHosts(['devbox', 'gpu-box'], ['devbox'], [])).toEqual(['gpu-box'])
    expect(mergeSecretHosts(['gpu-box'], ['devbox'], ['devbox', '__local__'])).toEqual(['gpu-box', '__local__'])
  })
  it('a tick rebases on what is shown', () => {
    expect(tickSecretHost(['devbox'], 'gpu-box', true)).toEqual(['devbox', 'gpu-box'])
    expect(tickSecretHost(['devbox', 'gpu-box'], 'devbox', false)).toEqual(['gpu-box'])
    expect(tickSecretHost(['devbox'], 'devbox', true)).toEqual(['devbox'])
  })
})
