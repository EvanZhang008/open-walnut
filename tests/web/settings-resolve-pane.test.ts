import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from '../../web/src/utils/log.js'
import {
  CORE_PANE_IDS,
  NAV_OWNER,
  navRowShown,
  parentPane,
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

  it('opens Sessions at one message hint\'s row (the chat\'s hint chip links there)', () => {
    expect(resolvePane('#message-hint-rich-output', [])).toEqual({ paneId: 'sessions', targetId: 'message-hint-rich-output', known: true, row: true })
    expect(resolvePane('#message-hint-', [])).toMatchObject({ known: false })
  })

  it('opens a lead pane with no scroll target', () => {
    expect(resolvePane('#sessions', [])).toMatchObject({ paneId: 'sessions', targetId: null })
    expect(resolvePane('#hooks', [])).toMatchObject({ paneId: 'hooks', targetId: null })
    expect(resolvePane('general', [])).toMatchObject({ paneId: 'general', targetId: null })
  })

  it('opens the owner of a folded section and targets the section', () => {
    expect(resolvePane('#focus-tiers', [])).toMatchObject({ paneId: 'tasks', targetId: 'focus-tiers' })
    expect(resolvePane('#providers', [])).toMatchObject({ paneId: 'advanced', targetId: 'providers' })
  })

  it('opens each of Phones & Cloud\'s ways as its own sub-page, old in-page anchors included', () => {
    // `#cloud` was a section folded into Phones & Cloud; it is the Cloud companion sub-page now.
    expect(resolvePane('#cloud', [])).toEqual({ paneId: 'cloud', targetId: null, known: true })
    expect(resolvePane('#devices-tailscale', [])).toEqual({ paneId: 'devices-tailscale', targetId: null, known: true })
    expect(resolvePane('#devices-browser', [])).toEqual({ paneId: 'devices-browser', targetId: null, known: true })
    for (const [way, pane] of [['cloud', 'cloud'], ['tailscale', 'devices-tailscale'], ['browser', 'devices-browser']]) {
      expect(resolvePane(`#devices-way-${way}`, [])).toEqual({ paneId: pane, targetId: null, known: true })
      expect(resolvePane(`#devices-way-panel-${way}`, [])).toEqual({ paneId: pane, targetId: null, known: true })
    }
    // A row on a sub-page opens that page at the row.
    expect(resolvePane('#devices-backup-leader', [])).toEqual({ paneId: 'cloud', targetId: 'devices-backup-leader', known: true, row: true })
    expect(resolvePane('#companion-keep', [])).toMatchObject({ paneId: 'cloud', targetId: 'companion-keep' })
    expect(resolvePane('#browser-access-runs-on', [])).toMatchObject({ paneId: 'devices-browser', targetId: 'browser-access-runs-on' })
    expect(resolvePane('#remote-access-card', [])).toMatchObject({ paneId: 'devices-tailscale', targetId: 'remote-access-card' })
    expect(resolvePane('#devices-new-name', [])).toMatchObject({ known: false })
    expect(parentPane('devices-tailscale')).toBe('devices')
    expect(parentPane('cloud')).toBe('devices')
    expect(parentPane('devices')).toBeNull()
  })

  it('shows a sub-page row only while its parent or a sibling is open, or while filtering', () => {
    expect(navRowShown('devices', 'general', false)).toBe(true)
    expect(navRowShown('devices-tailscale', 'general', false)).toBe(false)
    expect(navRowShown('devices-tailscale', 'devices', false)).toBe(true)
    expect(navRowShown('devices-tailscale', 'cloud', false)).toBe(true)
    expect(navRowShown('devices-tailscale', 'devices-tailscale', false)).toBe(true)
    expect(navRowShown('cloud', 'general', true)).toBe(true)
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
    expect(sectionsForPane('tasks').map((s) => s.id)).toEqual(['tasks', 'focus-tiers', 'tags', 'task-providers'])
    expect(sectionsForPane('devices').map((s) => s.id)).toEqual(['devices'])
    expect(sectionsForPane('cloud').map((s) => s.id)).toEqual(['cloud'])
    expect(sectionsForPane('advanced').map((s) => s.id)).toEqual(['advanced', 'providers'])
    expect(sectionsForPane('general').map((s) => s.id)).toEqual(['general'])
    for (const id of CORE_PANE_IDS) expect(NAV_OWNER[id]).toBe(id)
  })
})
