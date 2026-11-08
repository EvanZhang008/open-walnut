/**
 * When the Sidebar keeps asking the server about this machine's Claude Code
 * (web/src/utils/local-claude-recheck.ts). 2026-11-08: the card read "not
 * installed", Claude Code then appeared on the machine (installed by hand with
 * the card's command), and the card never noticed, because only the sign-in
 * state was re-checked.
 */
import { describe, expect, it } from 'vitest'
import { localRecheckWanted } from '../../web/src/utils/local-claude-recheck'
import { claudeBannerView, localAnswerUnsettled, localNoticeShows } from '../../web/src/utils/local-claude-banner'
import { readFileSync } from 'node:fs'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'
import type { LocalClaudeStatus } from '../../web/src/api/local-claude'

const claude = { found: true, version: '2.1.258', auth: 'ok' } as LocalClaudeStatus['claude']
const withLocal = (problems: LocalClaudeStatus['problems'], extra: Partial<SystemHealth> = {}): SystemHealth =>
  ({ hasReadyProvider: true, claudeCliAvailable: true, localClaude: { checkedAt: 1, claude, problems } as LocalClaudeStatus, ...extra }) as SystemHealth
const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }
const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: ['install'] }
const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code is old.', commands: ['claude update'] }
const INSTALLING = { ...MISSING, fix: { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' } }

describe('localRecheckWanted', () => {
  it('re-checks while the sign-in or the install notice shows', () => {
    expect(localRecheckWanted(withLocal([SIGN_IN]), [])).toBe(true)
    expect(localRecheckWanted(withLocal([MISSING], { claudeCliAvailable: false }), [])).toBe(true)
  })

  it('not while Walnut\'s own fix runs, once ready, while loading, or once dismissed', () => {
    expect(localRecheckWanted(withLocal([INSTALLING as never], { claudeCliAvailable: false }), [])).toBe(false)
    expect(localRecheckWanted(withLocal([]), [])).toBe(false)
    expect(localRecheckWanted(withLocal([SIGN_IN]), [], true)).toBe(false)
    expect(localRecheckWanted(withLocal([SIGN_IN]), ['sign-in'])).toBe(false)
    expect(localRecheckWanted(undefined, [])).toBe(false)
  })

  // The class: every notice the card can show for Claude Code on this machine
  // is one a terminal can clear, so each one that shows is re-checked.
  it('every Claude Code notice that shows is re-checked unless a fix runs', () => {
    for (const problems of [[SIGN_IN], [MISSING], [OUTDATED], []]) {
      for (const extra of [{}, { claudeCliAvailable: false }, { hasReadyProvider: false }]) {
        const health = withLocal(problems, extra)
        const kind = localNoticeShows(health, [])
        const shows = kind === 'sign-in' || kind === 'install'
        expect(localRecheckWanted(health, []), `${problems.map((p) => p.kind)} ${JSON.stringify(extra)}`).toBe(shows && !claudeBannerView(health)?.running)
      }
    }
  })

  // 2026-11-08: right after the one-click install, `claude auth status` gave no
  // answer; the card read "could not confirm" and nothing asked again.
  it('re-checks while the last answer settled nothing, and stops once it does', () => {
    const local = (c: Partial<LocalClaudeStatus['claude']>, extra: Partial<LocalClaudeStatus> = {}): SystemHealth =>
      ({ hasReadyProvider: true, claudeCliAvailable: true, claudeCodeNeeded: true, localClaude: { checkedAt: 1, claude: { ...claude, ...c }, problems: [], ...extra } as LocalClaudeStatus }) as SystemHealth
    expect(localRecheckWanted(local({ auth: 'unknown', authDetail: 'claude auth status gave no answer' } as never), [])).toBe(true)
    expect(localRecheckWanted(local({}, { checkError: 'daemon timed out' } as never), [])).toBe(true)
    expect(localRecheckWanted(local({ unknown: 'could not run claude' } as never), [])).toBe(true)
    expect(localRecheckWanted(local({}), [])).toBe(false)
    expect(localRecheckWanted(local({ auth: 'unknown' } as never), [], true)).toBe(false)
    const off = { ...local({ auth: 'unknown' } as never), claudeCodeNeeded: false } as SystemHealth
    expect(localRecheckWanted(off, [])).toBe(false)
  })

  // The class: whatever the first-use card shows as unsettled is the same rule the
  // Sidebar re-checks on, so a new unsettled state cannot sit there unasked.
  it('the first-use card decides "unsettled" with the rule the re-check reads', () => {
    const card = readFileSync('web/src/components/common/FirstUseSetup.tsx', 'utf8')
    expect(card).toContain(': localAnswerUnsettled(health)')
    expect(card).not.toMatch(/claude\.auth !== 'ok' && !health\.localClaude/)
    for (const c of [{ auth: 'unknown' }, { auth: 'none' }, { auth: 'ok' }, { found: false, auth: 'unknown' }]) {
      const health = { hasReadyProvider: true, claudeCliAvailable: true, localClaude: { checkedAt: 1, claude: { ...claude, ...c }, problems: [] } } as unknown as SystemHealth
      if (localAnswerUnsettled(health)) expect(localRecheckWanted(health, []), JSON.stringify(c)).toBe(true)
    }
  })
})
