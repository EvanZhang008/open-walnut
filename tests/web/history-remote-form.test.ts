/**
 * The remote history storage form's setting (web/src/components/settings/sections/
 * history-remote-model.ts): the fields it edits are laid over the saved setting, so a field
 * it does not show (prefix, force_path_style) survives every edit, and an emptied field is
 * cleared (2026-11-11 review: an edit of the bucket dropped a custom prefix and a store's
 * virtual-host addressing).
 */
import { describe, expect, it } from 'vitest'
import { remoteFormConfig } from '../../web/src/components/settings/sections/history-remote-model'

const form = {
  enabled: true, target: 'other' as const, bucket: 'b2', region: 'auto', endpoint: 'https://s3.example.test', days: 90, method: 'aws_chain' as const, profile: '',
}

describe('remote history form setting', () => {
  it('keeps the saved fields the form does not edit', () => {
    const saved = { enabled: false, bucket: 'b1', endpoint: 'https://s3.example.test', prefix: 'team/history', force_path_style: false }
    expect(remoteFormConfig(form, saved)).toEqual({
      prefix: 'team/history', force_path_style: false,
      enabled: true, days: 90, bucket: 'b2', region: 'auto', endpoint: 'https://s3.example.test', auth: { method: 'aws_chain' },
    })
  })

  it('clears an emptied field, and AWS S3 has no endpoint', () => {
    const saved = { enabled: true, bucket: 'b1', endpoint: 'https://s3.example.test', region: 'auto', days: 30, prefix: 'p' }
    const out = remoteFormConfig({ ...form, target: 'aws', region: ' ', days: undefined }, saved)
    expect(out).toEqual({ prefix: 'p', enabled: true, bucket: 'b2', auth: { method: 'aws_chain' } })
  })

  it('names a profile only when one is chosen', () => {
    expect(remoteFormConfig({ ...form, method: 'profile', profile: 'history' }).auth).toEqual({ method: 'profile', profile: 'history' })
    expect(remoteFormConfig({ ...form, method: 'profile', profile: '' }).auth).toEqual({ method: 'aws_chain' })
  })
})
