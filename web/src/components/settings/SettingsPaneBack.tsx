/**
 * The way back from a sub-page to the entry it sits under ("< Phones & Cloud"),
 * above the pane title, as System Settings and iOS Settings draw it. A plain
 * same-page `#<parent>` link: SettingsPage turns it into a hash replace, so it
 * works the same on a phone, where the pane layer stays open on the parent.
 */
import { parentPane } from './settings-routing'
import type { SettingsPaneMeta } from './settings-pane-context'

/** Focus `<pane>-title` once that pane has mounted (a few frames at most). */
function focusTitleSoon(paneId: string, tries = 20): void {
  requestAnimationFrame(() => {
    const title = document.getElementById(`${paneId}-title`)
    if (title) title.focus({ preventScroll: true })
    else if (tries > 0) focusTitleSoon(paneId, tries - 1)
  })
}

export function SettingsPaneBack({ paneId, metaFor }: { paneId: string; metaFor: (id: string) => SettingsPaneMeta | undefined }) {
  const parent = parentPane(paneId)
  if (!parent) return null
  const label = metaFor(parent)?.label ?? parent
  return (
    <a
      className="settings-pane-back"
      href={`#${parent}`}
      data-testid="settings-pane-back"
      aria-label={`Back to ${label}`}
      // Enter on the link: the pane it leaves unmounts, so focus moves to the parent's title.
      onClick={(e) => { if (e.detail === 0) focusTitleSoon(parent) }}
    >
      <span className="settings-pane-back-chevron" aria-hidden="true">‹</span>
      {label}
    </a>
  )
}
