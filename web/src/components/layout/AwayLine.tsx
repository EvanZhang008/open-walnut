/**
 * The quiet line a host replica's console shows while the Mac is away
 * (docs/plan/walnut-replica-servers-impl.md, WP7): "Your Mac is away. This is
 * the copy on <host> from 2 min ago." with "Prompts on <host> are not pushed to
 * your phone" beside it. No button, no dismiss: it goes away by itself when the
 * Mac answers again, with no reload. Renders nothing on a console the Mac serves.
 */
import { useAwayLine } from '@/hooks/useLeaderPresence'
import '@/styles/away-line.css'

export function AwayLine() {
  const away = useAwayLine()
  if (!away) return null
  return (
    <div className="away-line" role="status" aria-live="polite" data-testid="away-line">
      <span className="away-line-text">{away.line}</span>
      <span className="away-line-prompts">{away.prompts}</span>
    </div>
  )
}

/**
 * Above a session's composer: a session that runs on the Mac (or another host)
 * cannot be sent to while the Mac is away. The composer under it stays mounted
 * with its send controls hidden (ChatInput `sendBlocked`), so what is typed stays.
 */
export function MacAwayComposer() {
  return (
    <div className="mac-away-composer" role="status" data-testid="mac-away-composer">
      <strong>Your Mac is away.</strong>
      {/* Its conversation is on the Mac too (the history answers session_on_mac): promise nothing more. */}
      <span> This session runs through your Mac, so sending waits until it is back. What you type here is kept.</span>
    </div>
  )
}
