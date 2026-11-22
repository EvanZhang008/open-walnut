/**
 * The Apps page's way back to an app (experiment `apps_stay_open`): the apps pinned here,
 * then the recently used ones, most recent first. Closing an app on the Sidebar keeps it
 * under Recently used, so nothing opened is ever lost. Pinning here is this page's own
 * list; it never moves a Sidebar row (that is the Sidebar switch, apps/preferences.ts).
 * Draws nothing while the experiment is off or both lists are empty.
 */
import { useNavigate } from 'react-router-dom'
import type { ResolvedAppActivity } from '@/apps/preferences'
import type { RegisteredApp } from '@/apps/registry'
import { markAppOpened, updateAppPinned } from '@/apps/store'
import { linkTargetFor } from '@/utils/last-location'
import { AppBadge, AppGlyph } from './app-bits'

function QuickTile({ app, pinned, onOpen }: { app: RegisteredApp; pinned: boolean; onOpen: (app: RegisteredApp) => void }) {
  const action = pinned ? 'Unpin' : 'Pin'
  return (
    <div className="apps-quick-tile" data-testid={`apps-quick-${pinned ? 'pinned' : 'recent'}-${app.key}`}>
      <button type="button" className="apps-quick-open" onClick={() => onOpen(app)} aria-label={`Open ${app.title}`}>
        <span className="apps-quick-icon" aria-hidden="true"><AppGlyph app={app} size={18} /></span>
        <span className="apps-quick-name wn-title">{app.title}</span>
        <AppBadge app={app} />
      </button>
      <button
        type="button"
        className={`apps-quick-pin${pinned ? ' is-on' : ''}`}
        onClick={() => updateAppPinned(app.key, !pinned)}
        aria-pressed={pinned}
        aria-label={`${action} ${app.title}`}
        title={pinned ? 'Unpin from this page' : 'Pin on this page'}
        data-testid={`apps-quick-pin-${app.key}`}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 3h6l-1 6 4 3v2H6v-2l4-3z" />
          <path d="M12 14v7" fill="none" />
        </svg>
      </button>
    </div>
  )
}

function QuickSection({ id, title, apps, pinned, onOpen }: { id: string; title: string; apps: RegisteredApp[]; pinned: boolean; onOpen: (app: RegisteredApp) => void }) {
  if (apps.length === 0) return null
  return (
    <section className="apps-section apps-quick" data-testid={`apps-${id}`} aria-labelledby={`apps-${id}-title`}>
      <h2 className="apps-section-title" id={`apps-${id}-title`}>{title}</h2>
      <div className="apps-quick-grid">
        {apps.map((app) => <QuickTile key={app.key} app={app} pinned={pinned} onOpen={onOpen} />)}
      </div>
    </section>
  )
}

export function AppQuickOpen({ activity }: { activity: ResolvedAppActivity }) {
  const navigate = useNavigate()
  // Same target as the app's Sidebar row: where the person last was inside it. Recorded
  // here too, not only by the route: this way in never depends on the route changing.
  const open = (app: RegisteredApp) => {
    markAppOpened(app.key)
    navigate(linkTargetFor(app.path))
  }
  return (
    <>
      <QuickSection id="pinned" title="Pinned" apps={activity.pinned} pinned onOpen={open} />
      <QuickSection id="recent" title="Recently used" apps={activity.recent} pinned={false} onOpen={open} />
    </>
  )
}
