/**
 * The session header's controls that need the session's task (Fork, Board,
 * Locate) exist or not from the first frame, by what the page already knows of
 * the task (headerTaskPresence), and wait disabled for the record only while it
 * loads (recordGateReason), so the tool row never moves when the record lands
 * (2026-10-11: Fork appeared in front of Changed and Files after first paint and
 * a click aimed at Files opened Changed) and a session with no task keeps no dead
 * chip on it. Once drawn, the three keep their places as inert spacers when the
 * session turns out to have no task (taskControlSlot), so a click aimed at Files
 * never lands on Terminal. This pins the rules, every state of the Fork chip, and
 * the "..." chip's handling of spacers, rendered through renderToStaticMarkup with
 * the engine catalog mocked. The panel's memory of what it drew (useTaskControlSlot):
 * tests/web/session-task-control-slot.test.ts.
 * The browser half (positions, clicks, both engines):
 * tests/e2e/browser/session-header-chips-hold-place.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

vi.mock('../../web/src/hooks/useEngineCatalog', async () => {
  const { DEFAULT_ENGINE_CATALOG } = await import('../../web/src/utils/engines')
  return { useEngineCatalog: () => DEFAULT_ENGINE_CATALOG }
})

const {
  headerPlanFacts, headerTaskPresence, recordGateReason, TASK_SLOT_IDS, TASK_SLOT_SPACER, taskControlSlot,
} = await import('../../web/src/components/sessions/header-record-gate')
const { SessionForkButton } = await import('../../web/src/components/sessions/SessionForkButton')
const { SessionHeaderMoreMenu } = await import('../../web/src/components/sessions/SessionHeaderMore')

type ForkProps = Parameters<typeof SessionForkButton>[0]

const RECORD = { cwd: '/home/dev/work/repo-a', host: null, project: 'Acme', model: undefined, engine: 'claude', taskId: 'task-1', title: 'Fixture' } as const
const openDraft = () => undefined

/** The rendered chip's attributes (empty when it renders nothing). */
function fork(props: Partial<ForkProps>): { html: string; disabled: boolean; title: string; label: string; text: string } {
  const html = renderToStaticMarkup(createElement(SessionForkButton, { sessionId: 'sess-1', onOpenForkDraft: openDraft, ...props } as ForkProps))
  const attr = (name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1]?.replace(/&#x27;/g, "'") ?? ''
  return {
    html,
    disabled: /\sdisabled=""/.test(html),
    title: attr('title'),
    label: attr('aria-label'),
    text: html.replace(/<[^>]+>/g, ''),
  }
}

describe('headerTaskPresence', () => {
  const versioned = (taskId: string | null) => ({ taskId, statusRevision: 4 })
  const legacy = (taskId: string | null) => ({ taskId, statusRevision: null })

  it('the record, once here, decides', () => {
    expect(headerTaskPresence({ taskId: 'task-1' }, versioned(null))).toBe('task')
    expect(headerTaskPresence({ taskId: '' }, versioned('task-1'))).toBe('none')
    expect(headerTaskPresence({ taskId: null }, null)).toBe('none')
    expect(headerTaskPresence({}, undefined)).toBe('none')
  })

  it('before the record, a status entry that names a task, or says there is none, is known', () => {
    expect(headerTaskPresence(null, versioned('task-1'))).toBe('task')
    expect(headerTaskPresence(null, legacy('task-1'))).toBe('task')
    expect(headerTaskPresence(null, versioned(null))).toBe('none')
    expect(headerTaskPresence(null, versioned(''))).toBe('none')
    expect(headerTaskPresence(null, legacy(''))).toBe('none')
  })

  it('nothing on the page named the session, or only an unversioned entry that never heard a task', () => {
    expect(headerTaskPresence(null, null)).toBe('unknown')
    expect(headerTaskPresence(undefined, undefined)).toBe('unknown')
    expect(headerTaskPresence(null, legacy(null))).toBe('unknown')
  })
})

describe('taskControlSlot: drawn, kept as a spacer, or never drawn', () => {
  it('a session that has or may have a task gets the controls', () => {
    expect(taskControlSlot('task', false)).toBe('live')
    expect(taskControlSlot('unknown', false)).toBe('live')
    expect(taskControlSlot('task', true)).toBe('live')
    expect(taskControlSlot('unknown', true)).toBe('live')
  })

  it('"no task" after the panel drew them keeps their places; known from the first frame, none', () => {
    expect(taskControlSlot('none', true)).toBe('spacer')
    expect(taskControlSlot('none', false)).toBe('absent')
  })

  it('names the three by their row ids, and a spacer is out of reach', () => {
    expect([...TASK_SLOT_IDS].sort()).toEqual(['board', 'fork', 'locate'])
    expect(TASK_SLOT_SPACER).toEqual({ 'aria-hidden': true, tabIndex: -1, disabled: true, 'data-header-spacer': 'true' })
  })
})

describe('recordGateReason', () => {
  it('waits while the record loads and gives up once it failed', () => {
    expect(recordGateReason('The Board', null, true)).toBe('The Board becomes available once the session has loaded')
    expect(recordGateReason('The Board', undefined, false)).toBe("The Board is unavailable because this session's details did not load")
  })

  it('is null once the record is here (a control is drawn then only when the session has a task)', () => {
    expect(recordGateReason('Fork', { taskId: 'task-1' }, false)).toBeNull()
    expect(recordGateReason('Fork', { taskId: 'task-1' }, true)).toBeNull()
  })
})

describe('SessionForkButton: drawn when the session may have a task, waiting until the record', () => {
  it('renders nothing where the host has no fork draft surface, or the session is known to have no task', () => {
    expect(fork({ onOpenForkDraft: undefined, slot: 'live', session: RECORD }).html).toBe('')
    expect(fork({ onOpenForkDraft: undefined, slot: 'live', session: null, loading: true }).html).toBe('')
    expect(fork({ slot: 'absent', session: null, loading: true }).html).toBe('')
    expect(fork({ slot: 'absent', session: { ...RECORD, taskId: '' } }).html).toBe('')
  })

  it('before the record, known task or not known yet: the chip, disabled, named for its action, saying it waits', () => {
    {
      const chip = fork({ slot: 'live', session: null, loading: true })
      expect(chip.text).toBe('Fork')
      expect(chip.disabled).toBe(true)
      expect(chip.label).toBe('Fork session into a child task')
      expect(chip.title).toBe('Fork becomes available once the session has loaded')
    }
  })

  it('a record that never loaded, a session with no folder: disabled, each with its reason', () => {
    expect(fork({ slot: 'live', session: null, loading: false })).toMatchObject({
      text: 'Fork', disabled: true, title: "Fork is unavailable because this session's details did not load",
    })
    expect(fork({ slot: 'live', session: { ...RECORD, cwd: '' } })).toMatchObject({
      text: 'Fork', disabled: true, title: 'Fork is unavailable because this session has no working folder',
    })
  })

  it('an engine without session forking keeps its reason as the name (codex-parity-discovery pins it)', () => {
    const reason = 'Fork is unavailable because this Codex adapter does not support session forking'
    expect(fork({ slot: 'live', session: { ...RECORD, engine: 'codex' } })).toMatchObject({ text: 'Fork', disabled: true, title: reason, label: reason })
  })

  it('a spacer: the same chip and text (so the same width), inert, unnamed, out of reach', () => {
    for (const session of [null, { ...RECORD, taskId: '' }]) {
      const chip = fork({ slot: 'spacer', session, loading: session === null })
      expect(chip.html).toMatch(/^<button[^>]*class="session-action-chip"/)
      expect(chip.text).toBe('Fork')
      expect(chip.disabled).toBe(true)
      expect(chip.html).toContain('data-header-spacer="true"')
      expect(chip.html).toContain('aria-hidden="true"')
      expect(chip.html).toContain('tabindex="-1"')
      expect(chip.title).toBe('')
      expect(chip.label).toBe('')
    }
    // A host with no fork draft surface draws nothing, spacer or not.
    expect(fork({ slot: 'spacer', onOpenForkDraft: undefined, session: null }).html).toBe('')
  })

  it('a loaded session with a task and a folder: enabled, same text, so the same width', () => {
    const chip = fork({ slot: 'live', session: RECORD })
    expect(chip.text).toBe('Fork')
    expect(chip.disabled).toBe(false)
    expect(chip.label).toBe('Fork session into a child task')
    expect(chip.title).toMatch(/^Fork this session into a new draft/)
  })
})

describe('SessionHeaderMoreMenu: spacers fold like the rest but are never listed or counted', () => {
  const rowRef = { current: null }
  const menu = (ids: string[], spacerIds?: ReadonlySet<string>) =>
    renderToStaticMarkup(createElement(SessionHeaderMoreMenu, { rowRef, ids, spacerIds }))

  it('lists only live items in its count and its title', () => {
    const html = menu(['board', 'terminal', 'locate'], TASK_SLOT_IDS)
    expect(html).toContain('aria-label="More (1)"')
    expect(html).toContain('title="More: Terminal"')
    expect(html).not.toContain('data-header-spacer')
    expect(menu(['board', 'terminal', 'locate'])).toContain('aria-label="More (3)"')
  })

  it('with only spacers folded, keeps its place as one more spacer, the same chip', () => {
    const html = menu(['board', 'locate'], TASK_SLOT_IDS)
    expect(html).toMatch(/^<button[^>]*class="session-action-chip session-header-more-btn"/)
    expect(html).toContain('data-header-more="true"')
    expect(html).toContain('data-header-spacer="true"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).not.toContain('aria-label')
    expect(html).not.toContain('data-testid')
    expect(html.replace(/<[^>]+>/g, '')).toBe('\u00b7\u00b7\u00b7')
  })

  it('renders nothing when nothing is folded', () => {
    expect(menu([], TASK_SLOT_IDS)).toBe('')
    expect(menu([])).toBe('')
  })
})

describe('headerPlanFacts: Plan from the first frame', () => {
  it('reads the status store before the record, so a known plan is drawn on first paint', () => {
    expect(headerPlanFacts(null, { planCompleted: true, mode: 'default' })).toEqual({ hasPlan: true, isFromPlan: false, planMode: false })
    expect(headerPlanFacts(undefined, { planCompleted: false, mode: 'plan' })).toEqual({ hasPlan: false, isFromPlan: false, planMode: true })
    expect(headerPlanFacts(null, null)).toEqual({ hasPlan: false, isFromPlan: false, planMode: false })
  })

  it('lets the record decide once it is here', () => {
    expect(headerPlanFacts({ planCompleted: false, mode: 'default', fromPlanSessionId: 'src-1' }, { planCompleted: true, mode: 'plan' }))
      .toEqual({ hasPlan: false, isFromPlan: true, planMode: false })
    expect(headerPlanFacts({ planCompleted: true }, null)).toEqual({ hasPlan: true, isFromPlan: false, planMode: false })
  })
})
