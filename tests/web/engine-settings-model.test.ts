/**
 * The pure half of editing an engine's own settings (web/src/hooks/engine-settings-model.ts),
 * shared by Settings › Engines and the composer popover:
 *
 * 1. mergeLanded: a write's answer that arrives AFTER a newer write already
 * painted places only its own key, and rows with a write still in
 * flight keep their optimistic value instead of flashing back;
 * 2. optimisticSet: a row whose write target is another file (project scope)
 * reads as `source:'overlay'` naming that file from the first frame;
 * an emptied text field reads as the default;
 * 3. decideWriteFailure: only a server-confirmed 'not-written' reverts;
 * 4. group and file predicates the popover keys off.
 */
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../web/src/api/client'
import type { EngineSettingView, EngineSettingsView } from '../../web/src/api/engine-settings'
import {
  decideWriteFailure,
  findItem,
  rowLacksProjectLayer,
  mapItem,
  mergeLanded,
  optimisticReset,
  optimisticSet,
  otherGroups,
  rowHonoredHere,
  sessionsGroup,
} from '../../web/src/hooks/engine-settings-model'

function item(key: string, value: EngineSettingView['value'], extra: Partial<EngineSettingView> = {}): EngineSettingView {
  return {
    key, label: key, help: '', type: 'boolean', default: false, scope: 'sessions',
    file: 'user', value, source: 'file',
    writeTarget: { file: 'user', path: '/home/u/.claude/settings.json', holds: true },
    ...extra,
  }
}

function view(items: EngineSettingView[], groupId = 'sessions'): EngineSettingsView {
  return {
    engine: 'claude', displayName: 'Claude Code', host: '__local__', envChecked: true, scope: 'default',
    projectScopeAvailable: false,
    files: [{ id: 'user', path: '/home/u/.claude/settings.json', label: 'user settings', format: 'json', scope: 'user', readOnly: false, exists: true }],
    groups: [{ id: groupId, title: 'Sessions', help: '', items }],
  }
}

describe('mergeLanded', () => {
  it('a late answer places only its own key: the newer snapshot stays', () => {
    // A=verbose was patched first (seq 1), B=alwaysThinking second (seq 2).
    // B's answer landed first with B=true and (from disk at that moment) A=true.
    const onScreen = view([item('verbose', true), item('alwaysThinking', true)])
    // A's answer is a snapshot taken BEFORE B's write: it still shows B=false.
    const late = view([item('verbose', true), item('alwaysThinking', false)])
    const out = mergeLanded({ prev: onScreen, next: late, key: 'verbose', seq: 1, landedSeq: 2, savingKeys: ['verbose'] })
    expect(findItem(out.view, 'alwaysThinking')?.value).toBe(true)
    expect(findItem(out.view, 'verbose')?.value).toBe(true)
    expect(out.landedSeq).toBe(2)
  })

  it('a newer answer replaces the view and advances landedSeq', () => {
    const prev = view([item('verbose', true), item('alwaysThinking', false)])
    const next = view([item('verbose', false), item('alwaysThinking', true)])
    const out = mergeLanded({ prev, next, key: 'alwaysThinking', seq: 2, landedSeq: 1, savingKeys: ['alwaysThinking'] })
    expect(out.view).toBe(next)
    expect(out.landedSeq).toBe(2)
  })

  it('rows with their own write still in flight keep the optimistic value', () => {
    // verbose was toggled to true optimistically and its PATCH is still out.
    const prev = view([item('verbose', true), item('alwaysThinking', true)])
    // alwaysThinking's answer is a read taken before verbose's write reached disk.
    const next = view([item('verbose', false), item('alwaysThinking', true)])
    const out = mergeLanded({ prev, next, key: 'alwaysThinking', seq: 2, landedSeq: 1, savingKeys: ['verbose', 'alwaysThinking'] })
    expect(findItem(out.view, 'verbose')?.value).toBe(true)
    expect(findItem(out.view, 'alwaysThinking')?.value).toBe(true)
    expect(out.landedSeq).toBe(2)
  })

  it('with nothing on screen the answer is the view and landedSeq is untouched', () => {
    const next = view([item('verbose', true)])
    const out = mergeLanded({ prev: null, next, key: 'verbose', seq: 3, landedSeq: 1, savingKeys: ['verbose'] })
    expect(out.view).toBe(next)
    expect(out.landedSeq).toBe(1)
  })

  it('a late answer whose key vanished from the snapshot leaves the view alone', () => {
    const prev = view([item('verbose', true)])
    const next = view([item('other', true)])
    const out = mergeLanded({ prev, next, key: 'verbose', seq: 1, landedSeq: 2, savingKeys: [] })
    expect(out.view).toBe(prev)
  })
})

describe('optimistic rows', () => {
  const projectTarget = { file: 'project-local', path: '/work/app/.claude/settings.local.json', holds: false }

  it('a write aimed at another file reads as an overlay from that file', () => {
    const before = item('verbose', false, { writeTarget: projectTarget })
    const after = optimisticSet(before, true)
    expect(after.value).toBe(true)
    expect(after.source).toBe('overlay')
    expect(after.overlay).toEqual({ file: 'project-local', path: '/work/app/.claude/settings.local.json' })
    expect(after.invalid).toBeUndefined()
  })

  it('a write into the row\'s own file reads as set in that file', () => {
    const before = item('verbose', false, { source: 'default', invalid: 'was garbage' })
    const after = optimisticSet(before, true)
    expect(after.source).toBe('file')
    expect(after.overlay).toBeUndefined()
    expect(after.invalid).toBeUndefined()
  })

  it('an emptied text field is an unset: of the row\'s own file it reads as the default', () => {
    const before = item('model', 'opus', { type: 'text', default: null, defaultLabel: 'the engine picks' })
    const after = optimisticSet(before, '')
    expect(after.source).toBe('default')
    expect(after.value).toBeNull()
    expect(after.overlay).toBeUndefined()
  })

  it('an emptied text field aimed at a project file that does not hold the key changes nothing but holds', () => {
    const before = item('model', 'opus', { type: 'text', default: null, defaultLabel: 'the engine picks', writeTarget: projectTarget })
    const after = optimisticSet(before, '')
    expect(after.source).toBe('file')
    expect(after.value).toBe('opus')
    expect(after.writeTarget.holds).toBe(false)
  })

  it('a reset of the row\'s own file never drops an overlay that is in force', () => {
    const before = item('verbose', true, { source: 'overlay', overlay: { file: 'project-local', path: '/x' } })
    const after = optimisticReset(before)
    expect(after).toMatchObject({ value: true, source: 'overlay', overlay: { file: 'project-local', path: '/x' }, invalid: undefined })
  })
})

describe('decideWriteFailure', () => {
  it('reverts only on a server-confirmed not-written', () => {
    expect(decideWriteFailure(new ApiError(409, 'refused', { error: 'refused', outcome: 'not-written' }))).toBe('revert')
    expect(decideWriteFailure(new ApiError(502, 'socket closed', { error: 'socket closed', outcome: 'unknown' }))).toBe('reload')
    expect(decideWriteFailure(new ApiError(504, 'deadline', { error: 'deadline', outcome: 'written' }))).toBe('reload')
  })

  it('an old server\'s bodyless 4xx was a refusal; a client-side timeout knows nothing', () => {
    expect(decideWriteFailure(new ApiError(400, 'bad value'))).toBe('revert')
    expect(decideWriteFailure(new Error('timeout'))).toBe('reload')
  })
})

describe('groups, files and rows', () => {
  it('sessionsGroup / otherGroups split by id in response order', () => {
    const v: EngineSettingsView = {
      ...view([item('a', true)]),
      groups: [
        { id: 'updates', title: 'Updates', help: '', items: [item('u', true)] },
        { id: 'sessions', title: 'Sessions', help: '', items: [item('a', true)] },
        { id: 'terminal', title: 'Terminal only', help: '', items: [] },
      ],
    }
    expect(sessionsGroup(v)?.items.map((i) => i.key)).toEqual(['a'])
    expect(otherGroups(v).map((g) => g.id)).toEqual(['updates', 'terminal'])
    expect(sessionsGroup(null)).toBeUndefined()
    expect(otherGroups(null)).toEqual([])
  })

  it('rowLacksProjectLayer: only the server\'s explicit flag locks a row, never a label or an id', () => {
    expect(rowLacksProjectLayer({ ...item('a', true), projectLayer: false })).toBe(true)
    expect(rowLacksProjectLayer({ ...item('a', true), file: 'global' })).toBe(false)
    expect(rowLacksProjectLayer(item('a', true))).toBe(false)
  })

  it('rowHonoredHere: an explicit false or an unknown timing is not a promise', () => {
    expect(rowHonoredHere(item('a', true))).toBe(true)
    expect(rowHonoredHere(item('a', true, { appliesOn: 'next-turn' }))).toBe(true)
    expect(rowHonoredHere(item('a', true, { appliesOn: 'new-session' }))).toBe(true)
    expect(rowHonoredHere({ ...item('a', true), appliesOn: 'someday' as never })).toBe(false)
    expect(rowHonoredHere({ ...item('a', true), honoredHere: false } as EngineSettingView)).toBe(false)
  })

  it('mapItem touches one row and leaves the others by identity', () => {
    const v = view([item('a', true), item('b', false)])
    const out = mapItem(v, 'a', (i) => ({ ...i, value: false }))
    expect(findItem(out, 'a')?.value).toBe(false)
    expect(findItem(out, 'b')).toBe(findItem(v, 'b'))
  })
})

describe('optimisticReset: never an invented "Default" while another layer holds the key', () => {
  const projectTarget = { file: 'project-local', path: '/work/app/.claude/settings.local.json', holds: true }

  it('unset from the row\'s own file when the value came from it: the default, holds cleared', () => {
    const after = optimisticReset(item('verbose', true, { source: 'file' }))
    expect(after).toMatchObject({ value: false, source: 'default', overlay: undefined, invalid: undefined })
    expect(after.writeTarget.holds).toBe(false)
  })

  it('unset from the row\'s own file while a project overlay is in force: the overlay stays in force', () => {
    const before = item('verbose', true, { source: 'overlay', overlay: { file: 'project-local', path: '/x' } })
    const after = optimisticReset(before)
    expect(after.source).toBe('overlay')
    expect(after.value).toBe(true)
    expect(after.overlay).toEqual({ file: 'project-local', path: '/x' })
    expect(after.writeTarget.holds).toBe(false)
  })

  it('unset from a project overlay that holds the value (project scope Reset): the row keeps what it shows until the answer', () => {
    const before = item('outputStyle', 'Learning', {
      type: 'select', default: null, source: 'overlay', overlay: { file: 'project-local', path: projectTarget.path }, writeTarget: projectTarget,
    })
    const after = optimisticReset(before)
    expect(after.source).toBe('overlay')
    expect(after.value).toBe('Learning')
    expect(after.writeTarget.holds).toBe(false)
    expect(after.invalid).toBeUndefined()
  })

  it('a legacy-sourced value is read from a file the target is not: it stays too', () => {
    const before = item('model', 'opus', { type: 'text', default: null, source: 'legacy', legacy: { file: 'global', path: '/old.json' } })
    const after = optimisticReset(before)
    expect(after.source).toBe('legacy')
    expect(after.value).toBe('opus')
  })

  it('an emptied text field aimed at a project overlay follows the same rule', () => {
    const before = item('model', 'opus', { type: 'text', default: null, source: 'overlay', overlay: { file: 'project-local', path: projectTarget.path }, writeTarget: projectTarget })
    const after = optimisticSet(before, '')
    expect(after.source).toBe('overlay')
    expect(after.writeTarget.holds).toBe(false)
  })
})
