/**
 * The macOS block: whether Walnut follows the Mac's Focus, and the "Mac Do Not Disturb
 * during focus blocks" setting with its one-time setup (the two shortcuts, one click
 * each, and Full Disk Access when Rhythm cannot see the Focus state).
 *
 * Install opens the Shortcuts app's Add dialogs; the server then re-lists Shortcuts
 * every few seconds (`watching`), so the row flips to "installed" on its own once the
 * person has clicked Add. Check again stays as the manual path.
 */
import { dndSetupText } from './dnd-model'
import type { RhythmPublicState } from './store'

export interface MacCardProps {
  state: RhythmPublicState
  onInstall(): void
  onOpenPrivacy(): void
  /** Turn the "Mac Do Not Disturb during focus blocks" setting on or off. */
  onDndSetting(on: boolean): void
  refresh(): void
  busy: boolean
}

type Tone = 'warn' | 'error' | undefined

function mirrorText(mirror: RhythmPublicState['macos']['mirror']): { text: string; tone: Tone } {
  if (!mirror.enabled) return { text: 'Off. Turn on "Follow macOS Focus" below to use it.', tone: undefined }
  switch (mirror.phase) {
    case 'active': return { text: `${mirror.focusName ?? 'A Focus'} is on, so Walnut is quiet.`, tone: undefined }
    case 'inactive': return { text: 'No macOS Focus is on. Walnut goes quiet when one starts.', tone: undefined }
    case 'unavailable':
      if (mirror.needsAccess) {
        return {
          text: `macOS keeps the Focus state private. Give ${grantName(mirror.grantTarget)} Full Disk Access, then click Check again. Or turn off "Follow macOS Focus" below.`,
          tone: 'warn',
        }
      }
      return { text: mirror.error ?? 'macOS did not allow reading the Focus state.', tone: 'warn' }
    default: return { text: 'Checking…', tone: undefined }
  }
}

/** "Walnut (/Applications/Walnut.app)" for the app, the bare path for anything else. */
function grantName(target: string | undefined): string {
  if (!target || target === 'Walnut') return 'Walnut'
  return /\/Walnut\.app\/?$/.test(target) ? `Walnut (${target})` : target
}

export function MacCard({ state, onInstall, onOpenPrivacy, onDndSetting, refresh, busy }: MacCardProps) {
  const { macos } = state
  if (!macos.available) {
    return (
      <section className="rhythm-block" data-testid="rhythm-mac-card">
        <div className="rhythm-block-head"><h2>macOS</h2></div>
        <div className="rhythm-group">
          <div className="rhythm-row">
            <div className="rhythm-row-copy">
              <span>Focus and Do Not Disturb</span>
              <span className="rhythm-row-help">Available when Walnut runs on a Mac.</span>
            </div>
          </div>
        </div>
      </section>
    )
  }
  const { mirror, shortcuts } = macos
  const mirrorLine = mirrorText(mirror)
  const setup = dndSetupText(state)
  const dndOn = state.config.macosFocusShortcuts
  const installFailed = shortcuts.lastInstall?.steps.filter((step) => !step.ok) ?? []
  return (
    <section className="rhythm-block" data-testid="rhythm-mac-card">
      <div className="rhythm-block-head"><h2>macOS</h2></div>
      <div className="rhythm-group">
        <div className="rhythm-row">
          <div className="rhythm-row-copy">
            <span>Mac Do Not Disturb during focus blocks</span>
            <span className="rhythm-row-help" data-tone={setup.tone} data-testid="rhythm-mac-shortcuts" data-watching={shortcuts.watching ? 'true' : undefined}>
              {setup.text}
            </span>
            {shortcuts.legacy && (
              <span className="rhythm-row-help" data-testid="rhythm-mac-legacy">The older "Walnut Focus On" shortcut is no longer used; you can delete it in Shortcuts.</span>
            )}
          </div>
          <div className="rhythm-row-actions">
            <label className="rhythm-dnd-toggle">
              <input type="checkbox" checked={dndOn} disabled={busy} data-testid="rhythm-dnd-setting" onChange={(event) => onDndSetting(event.currentTarget.checked)} />
              <span>{dndOn ? 'On' : 'Off'}</span>
            </label>
            {setup.step === 'add' && (
              // Stays clickable while watching: a dialog closed by mistake opens again at once.
              <button type="button" className="rhythm-button rhythm-primary" disabled={busy} data-testid="rhythm-shortcuts-install" onClick={onInstall}>
                {shortcuts.watching ? 'Open again' : 'Add shortcuts'}
              </button>
            )}
            {setup.step === 'access' && (
              <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-dnd-privacy-open" onClick={onOpenPrivacy}>Open Privacy settings</button>
            )}
            <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-shortcuts-check" onClick={refresh}>Check again</button>
          </div>
        </div>
        <div className="rhythm-row">
          <div className="rhythm-row-copy">
            <span>Follow macOS Focus</span>
            <span className="rhythm-row-help" data-tone={mirrorLine.tone} data-testid="rhythm-mac-mirror" data-phase={mirror.phase}>{mirrorLine.text}</span>
          </div>
          {mirror.phase === 'unavailable' && mirror.needsAccess && (
            <div className="rhythm-row-actions">
              <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-privacy-open" onClick={onOpenPrivacy}>Open Privacy settings</button>
              <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-mirror-check" onClick={refresh}>Check again</button>
            </div>
          )}
        </div>
        {installFailed.length > 0 && (
          <div className="rhythm-row">
            <div className="rhythm-row-copy">
              <span>Install</span>
              <span className="rhythm-row-help" data-tone="error">{installFailed.map((step) => `${step.name}: ${step.step} failed`).join('; ')}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
