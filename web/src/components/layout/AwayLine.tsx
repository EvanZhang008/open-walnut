/**
 * The quiet line a host replica's console shows while the Mac is away
 * (docs/plan/walnut-replica-servers-impl.md, WP7): "Your Mac is away. This is
 * the copy on <host> from 2 min ago." with "Prompts on <host> are not pushed to
 * your phone" beside it. No other button: it goes away by itself when the Mac
 * answers again, with no reload. Its × (NoticeClose) hides it until that state
 * changes: closed, it stays hidden while the Mac stays away, and the next time
 * the Mac goes away it shows again. Renders nothing on a console the Mac serves.
 */
import { useAwayLine, useLeaderPresence } from '@/hooks/useLeaderPresence'
import type { LeaderPresenceState } from '@/api/leader-presence'
import { NoticeClose } from '@/components/common/NoticeClose'
import { useNoticeDismiss } from '@/utils/notice-dismiss'
import '@/styles/away-line.css'

export const AWAY_LINE_SCOPE = 'away-line'
export const MAC_AWAY_COMPOSER_SCOPE = 'mac-away-composer'

/**
 * What a closed away notice is keyed by: by whom it is away (the Mac or another leader) and on which
 * host; null while the Mac answers, which forgets the close (in every window: the store is synced) so
 * the next away shows again; undefined before the console has heard anything (a reload keeps what was
 * closed). Never the copies' age (`asOf`): it goes to null and back within one away, which would
 * bring a closed line back.
 */
export function awaySignature(p: LeaderPresenceState): string | null | undefined {
  if (p.answers) return p.source === 'none' ? undefined : null
  return `${p.console ? 'leader' : 'mac'}:${p.host ?? ''}`
}

export function AwayLine() {
  const away = useAwayLine()
  const signature = awaySignature(useLeaderPresence())
  const { hidden, dismiss } = useNoticeDismiss(AWAY_LINE_SCOPE, signature)
  // AwayLine is mounted on every console (AppShell), the composer's notice only while away: this
  // drops the composer's close when the Mac answers, so its next away shows it again.
  useNoticeDismiss(MAC_AWAY_COMPOSER_SCOPE, signature)
  if (!away || hidden) return null
  return (
    <div className="away-line" role="status" aria-live="polite" data-testid="away-line">
      <span className="away-line-text">{away.line}</span>
      <span className="away-line-prompts">{away.prompts}</span>
      <NoticeClose onClose={dismiss} label="Hide this line while the Mac is away" testId="away-line-close" className="away-line-close" />
    </div>
  )
}

/**
 * Above a session's composer: a session that runs on the Mac (or another host)
 * cannot be sent to while the Mac is away. The composer under it stays mounted
 * with its send controls hidden (ChatInput `sendBlocked`), so what is typed stays.
 * Its × folds the words to one line for this away only: the send controls stay
 * hidden, so the line still says why there is no send.
 */
export function MacAwayComposer() {
  const { hidden, dismiss } = useNoticeDismiss(MAC_AWAY_COMPOSER_SCOPE, awaySignature(useLeaderPresence()))
  if (hidden) {
    return (
      <div className="mac-away-composer is-folded" role="status" data-testid="mac-away-composer" data-folded="true">
        <strong>Your Mac is away:</strong><span> sending waits until it is back.</span>
      </div>
    )
  }
  return (
    <div className="mac-away-composer" role="status" data-testid="mac-away-composer">
      <NoticeClose onClose={dismiss} label="Hide this notice while the Mac is away" testId="mac-away-composer-close" className="mac-away-composer-close" />
      <strong>Your Mac is away.</strong>
      {/* Its conversation is on the Mac too (the history answers session_on_mac): promise nothing more. */}
      <span> This session runs through your Mac, so sending waits until it is back. What you type here is kept.</span>
    </div>
  )
}
