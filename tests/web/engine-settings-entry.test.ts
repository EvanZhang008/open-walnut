/**
 * useEngineSettingsEntry: the three-state gate behind the composer's
 * "Engine settings" row. Rendered through renderToStaticMarkup with the
 * catalog hydration mocked, so each state is pinned without a browser:
 * - pending -> a disabled row that says the engine list is still being read
 * - failed -> a disabled row that points at Settings
 * - hydrated -> a live row (engine has settings) or no row at all (it has not)
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { PlusMenuAction } from '../../web/src/components/chat/plus-menu-actions'

let hydration: 'pending' | 'hydrated' | 'failed' = 'pending'
vi.mock('../../web/src/hooks/useEngineCatalog', () => ({
  useEngineCatalogHydration: () => hydration,
}))

const { useEngineSettingsEntry, ENGINE_SETTINGS_FAILED_TITLE, ENGINE_SETTINGS_PENDING_TITLE } =
  await import('../../web/src/components/sessions/useEngineSettingsEntry')

const session = { engine: 'claude', host: '__local__', cwd: '/home/dev/work/repo-a' }
const engineUi = { id: 'claude' as const, displayName: 'Claude Code', ownSettings: true }

/** Runs the hook inside a throwaway component and hands back what it returned. */
function run(input: Parameters<typeof useEngineSettingsEntry>[0]) {
  let out: ReturnType<typeof useEngineSettingsEntry> | undefined
  const Probe = () => { out = useEngineSettingsEntry(input); return null }
  renderToStaticMarkup(createElement(Probe))
  return out!
}

const only = (actions: PlusMenuAction[] | undefined): PlusMenuAction => {
  expect(actions).toHaveLength(1)
  return actions![0]!
}

describe('useEngineSettingsEntry gate', () => {
  it('pending catalog: one disabled row, no popover', () => {
    hydration = 'pending'
    const { plusMenuActions, popover } = run({ sessionId: 's1', session, engineUi })
    const row = only(plusMenuActions)
    expect(row).toMatchObject({ id: 'engine-settings', label: 'Engine settings', disabled: true, title: ENGINE_SETTINGS_PENDING_TITLE })
    expect(popover).toBeNull()
  })

  it('failed catalog: one disabled row that points at Settings', () => {
    hydration = 'failed'
    const row = only(run({ sessionId: 's1', session, engineUi }).plusMenuActions)
    expect(row.disabled).toBe(true)
    expect(row.title).toBe(ENGINE_SETTINGS_FAILED_TITLE)
  })

  it('hydrated + settings: a live row titled for this session, local host reads "This Mac"', () => {
    hydration = 'hydrated'
    const row = only(run({ sessionId: 's1', session, engineUi }).plusMenuActions)
    expect(row.disabled).toBeUndefined()
    expect(row.title).toBe('Claude Code settings for sessions in /home/dev/work/repo-a on This Mac')
  })

  it('hydrated + remote host: the title names the host', () => {
    hydration = 'hydrated'
    const row = only(run({ sessionId: 's1', session: { ...session, host: 'devbox' }, engineUi }).plusMenuActions)
    expect(row.title).toBe('Claude Code settings for sessions in /home/dev/work/repo-a on devbox')
  })

  it('hydrated + no settings surface: undefined, so ChatInput draws neither row nor divider', () => {
    hydration = 'hydrated'
    const { plusMenuActions } = run({ sessionId: 's1', session, engineUi: { ...engineUi, ownSettings: false } })
    expect(plusMenuActions).toBeUndefined()
  })

  it('a long cwd is shortened in the title the same way the popover subtitle is', () => {
    hydration = 'hydrated'
    const cwd = '/home/dev/work/repo-a/services/api/internal/handlers'
    const row = only(run({ sessionId: 's1', session: { ...session, cwd }, engineUi }).plusMenuActions)
    expect(row.title).toBe('Claude Code settings for sessions in /home/dev/work/repo-a/services/api/…/handlers on This Mac')
  })
})

describe('useEngineSettingsEntry title without a cwd', () => {
  it('a session with no working directory gets a title with no empty "in" clause and no double space', () => {
    hydration = 'hydrated'
    for (const cwd of [undefined, '']) {
      const row = only(run({ sessionId: 's1', session: { engine: 'claude', host: '__local__', cwd }, engineUi }).plusMenuActions)
      expect(row.title).toBe('Claude Code settings for sessions on This Mac')
    }
  })
})
