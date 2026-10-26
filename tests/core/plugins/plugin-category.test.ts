/**
 * The Apps page groups plugins by a closed set of categories. A value the host does not
 * know must never become a group of its own, and a plugin that names none is placed by
 * what it does.
 */
import { describe, expect, it } from 'vitest'
import {
  derivePluginCategory,
  parsePluginCategory,
  PLUGIN_CATEGORIES,
} from '../../../src/core/plugins/plugin-category.js'

describe('parsePluginCategory', () => {
  it('accepts every known category', () => {
    for (const category of PLUGIN_CATEGORIES) expect(parsePluginCategory(category)).toBe(category)
  })

  it('tolerates case and surrounding space', () => {
    expect(parsePluginCategory(' Time ')).toBe('time')
  })

  it('returns undefined for junk', () => {
    for (const junk of [undefined, null, '', 'games', 42, true, ['time'], { category: 'time' }]) {
      expect(parsePluginCategory(junk)).toBeUndefined()
    }
  })
})

describe('derivePluginCategory', () => {
  it('puts a sync plugin under tasks', () => {
    expect(derivePluginCategory({ id: 'acme', capabilities: ['ui', 'sync'] })).toBe('tasks')
    expect(derivePluginCategory({ id: 'acme', adds: ['App', 'Task sync'] })).toBe('tasks')
  })

  it('puts the mail base, its providers and its dependents under communication', () => {
    expect(derivePluginCategory({ id: 'mail' })).toBe('communication')
    expect(derivePluginCategory({ id: 'mail-imap', capabilities: ['tools'] })).toBe('communication')
    expect(derivePluginCategory({ id: 'reader', dependencyIds: ['mail'] })).toBe('communication')
  })

  it('does not match a mere prefix of mail', () => {
    expect(derivePluginCategory({ id: 'mailbox' })).toBe('other')
  })

  it('lets sync win over mail', () => {
    expect(derivePluginCategory({ id: 'mail-tasks', capabilities: ['sync'] })).toBe('tasks')
  })

  it('falls back to other', () => {
    expect(derivePluginCategory({ id: 'plain' })).toBe('other')
    expect(derivePluginCategory({ id: 'plain', capabilities: [], adds: [], dependencyIds: [] })).toBe('other')
  })
})
