import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../web/src/utils/log.js'
import {
  CORE_PANE_IDS,
  NAV_OWNER,
  resolvePane,
  sectionsForPane,
} from '../../web/src/components/settings/settings-routing.js'
import { hostRowId } from '../../web/src/utils/host-settings-nav.js'

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

  it('opens Remote Hosts for one host row and targets that row', () => {
    const owner = NAV_OWNER['remote-hosts']
    expect(resolvePane('#rh-host-olddev', [])).toEqual({ paneId: owner, targetId: 'rh-host-olddev', known: true })
    // The alias is URI-encoded in the id; the target is the decoded element id.
    expect(resolvePane('#rh-host-dev%20box', [])).toEqual({ paneId: owner, targetId: 'rh-host-dev box', known: true })
    // The prefix matches the row id Open Settings builds.
    expect(resolvePane(`#${hostRowId('buildbox')}`, [])).toMatchObject({ paneId: owner, targetId: 'rh-host-buildbox' })
  })

  it('opens the owning pane for a ROW link and flags it as a row', () => {
    // The strip's "Adjust panels" toast links here: General, scrolled to and
    // flashing the Session panels control rather than the top of the pane.
    expect(resolvePane('#session-panels', [])).toEqual({ paneId: 'general', targetId: 'settings-session-panels', known: true, row: true })
  })

  it('still sends an unknown hash to the default pane', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {})
    expect(resolvePane('#rh-hostx', [])).toEqual({ paneId: 'general', targetId: null, known: false })
    expect(resolvePane('#no-such-pane', [])).toEqual({ paneId: 'general', targetId: null, known: false })
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
    expect(sectionsForPane('tasks').map((s) => s.id)).toEqual(['tasks', 'focus-tiers', 'tags'])
    expect(sectionsForPane('devices').map((s) => s.id)).toEqual(['devices', 'cloud'])
    expect(sectionsForPane('advanced').map((s) => s.id)).toEqual(['advanced', 'providers'])
    expect(sectionsForPane('general').map((s) => s.id)).toEqual(['general'])
    for (const id of CORE_PANE_IDS) expect(NAV_OWNER[id]).toBe(id)
  })
})
