/**
 * Settings > Focus: enter a saved focus space, make or change one, leave the one you are in
 * (web/src/focus-spaces/FocusPanel.tsx). Here and not on the side bar since 2026-11-23 (the user:
 * the rail entry took too much room). Shown only while experiment `focus_workspace` is on
 * (settings-pane-gates.ts); a focus the person is in also shows on Home's banner.
 */
import { SettingsGroup, SettingsSection } from '../SettingsSection'
import { UnavailableState } from '@/components/common/EmptyState'
import { FocusPanel } from '@/focus-spaces/FocusPanel'
import { useFocusOn } from '@/focus-spaces/useFocusView'
import '@/styles/focus-spaces.css'

export function FocusSpacesSection() {
  // The nav hides this pane while the experiment is off; an old #focus-spaces link still lands here.
  if (!useFocusOn()) {
    return (
      <SettingsSection id="focus-spaces" title="Focus">
        <SettingsGroup>
          <UnavailableState size="row" title="Focus is off" hint="Turn it on in Settings, Experimental." />
        </SettingsGroup>
      </SettingsSection>
    )
  }
  return (
    <SettingsSection id="focus-spaces" title="Focus">
      <SettingsGroup>
        <div className="focus-settings-card" data-testid="settings-focus">
          <FocusPanel />
        </div>
      </SettingsGroup>
    </SettingsSection>
  )
}
