import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry.js'

const EXPECTED_IDS = [
  'repositories', 'hooks',
  'providers', 'general', 'sessions', 'focus-tiers', 'integrations', 'calendar',
  'permissions', 'plugin-store', 'search', 'stt', 'audio-capture', 'heartbeat',
  'backup', 'remote-hosts', 'devices', 'cloud', 'advanced', 'usage', 'timeline', 'bug-report',
]

describe('core settings registry', () => {
  it('keeps one owner-scoped source of truth for page and navigation order', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.id)).toEqual(EXPECTED_IDS)
    expect(new Set(EXPECTED_IDS).size).toBe(EXPECTED_IDS.length)
    expect(CORE_SETTINGS_CONTRIBUTIONS.every((entry) => entry.owner === 'walnut')).toBe(true)
  })

  it('keeps the existing Manage and Configure split', () => {
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'manage')
      .map((entry) => entry.id)).toEqual(['repositories', 'hooks'])
    expect(CORE_SETTINGS_CONTRIBUTIONS
      .filter((entry) => entry.group === 'configure')
      .map((entry) => entry.id)).toEqual(EXPECTED_IDS.slice(2))
  })
})
