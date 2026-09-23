import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../web/src/utils/log.js'
import {
  CORE_PANE_IDS,
  NAV_OWNER,
  resolvePane,
  sectionsForPane,
} from '../../web/src/components/settings/settings-routing.js'

describe('resolvePane', () => {
  afterEach(() => vi.restoreAllMocks())

  it('opens General for an empty hash', () => {
    expect(resolvePane('', [])).toEqual({ paneId: 'general', targetId: null, known: true })
    expect(resolvePane('#', [])).toEqual({ paneId: 'general', targetId: null, known: true })
  })

  it('opens a lead pane with no scroll target', () => {
    expect(resolvePane('#sessions', [])).toMatchObject({ paneId: 'sessions', targetId: null })
    expect(resolvePane('#plugin-store', [])).toMatchObject({ paneId: 'plugin-store', targetId: null })
    expect(resolvePane('general', [])).toMatchObject({ paneId: 'general', targetId: null })
  })

  it('opens the owner of a folded section and targets the section', () => {
    expect(resolvePane('#focus-tiers', [])).toMatchObject({ paneId: 'tasks', targetId: 'focus-tiers' })
    expect(resolvePane('#cloud', [])).toMatchObject({ paneId: 'devices', targetId: 'cloud' })
    expect(resolvePane('#providers', [])).toMatchObject({ paneId: 'advanced', targetId: 'providers' })
  })

  it('opens a registered plugin panel by its key', () => {
    const key = 'fixture-plugin:panel'
    expect(resolvePane(`#${key}`, [key])).toEqual({ paneId: key, targetId: null, known: true })
    expect(resolvePane(`#${encodeURIComponent(key)}`, [key])).toMatchObject({ paneId: key })
  })

  it('falls back to General and warns for an unknown hash', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(resolvePane('#does-not-exist', [])).toEqual({ paneId: 'general', targetId: null, known: false })
    expect(warn).toHaveBeenCalledWith('settings', 'unknown settings hash', { hash: '#does-not-exist' })
  })

  it('stays quiet while plugin panels may still register', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(resolvePane('#fixture-plugin:panel', [], { silent: true })).toMatchObject({ paneId: 'general', known: false })
    expect(warn).not.toHaveBeenCalled()
  })

  it('mounts each pane lead first, then its folded sections', () => {
    expect(sectionsForPane('tasks').map((s) => s.id)).toEqual(['tasks', 'focus-tiers'])
    expect(sectionsForPane('devices').map((s) => s.id)).toEqual(['devices', 'cloud'])
    expect(sectionsForPane('advanced').map((s) => s.id)).toEqual(['advanced', 'providers'])
    expect(sectionsForPane('general').map((s) => s.id)).toEqual(['general'])
    for (const id of CORE_PANE_IDS) expect(NAV_OWNER[id]).toBe(id)
  })
})
