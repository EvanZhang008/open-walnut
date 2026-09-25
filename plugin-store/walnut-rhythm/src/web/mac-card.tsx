/**
 * The macOS card: whether Walnut follows the Mac's Focus, and whether the two
 * shortcuts that drive Do Not Disturb are installed, with the one-click install.
 */
import type { RhythmPublicState } from './store'

export interface MacCardProps {
  state: RhythmPublicState
  run(localOp: string, args?: Record<string, unknown>): void
  refresh(): void
  busy: boolean
}

function mirrorText(mirror: RhythmPublicState['macos']['mirror']): string {
  if (!mirror.enabled) return 'Off. Turn on "Follow macOS Focus" in Settings to use it.'
  switch (mirror.phase) {
    case 'active': return `${mirror.focusName ?? 'A Focus'} is on, so Walnut is quiet.`
    case 'inactive': return 'No macOS Focus is on.'
    case 'unavailable': return mirror.error ?? 'macOS did not allow reading the Focus state.'
    default: return 'Starting…'
  }
}

function shortcutsText(shortcuts: RhythmPublicState['macos']['shortcuts']): string {
  if (!shortcuts.checked) return 'Not checked yet.'
  if (shortcuts.installed === null) return shortcuts.error ?? 'Could not list your Shortcuts.'
  if (shortcuts.missing.length === 0) return 'Both shortcuts are installed.'
  return `Missing: ${shortcuts.missing.join(', ')}.`
}

export function MacCard({ state, run, refresh, busy }: MacCardProps) {
  const { macos } = state
  if (!macos.available) {
    return (
      <section className="rhythm-card" data-testid="rhythm-mac-card">
        <header className="rhythm-card-head"><h2>macOS</h2></header>
        <p className="rhythm-muted">Focus mirroring and Do Not Disturb shortcuts work when Walnut runs on a Mac.</p>
      </section>
    )
  }
  const { mirror, shortcuts } = macos
  const lastRun = shortcuts.lastRun
  const installFailed = shortcuts.lastInstall?.steps.filter((step) => !step.ok) ?? []
  return (
    <section className="rhythm-card" data-testid="rhythm-mac-card">
      <header className="rhythm-card-head"><h2>macOS</h2></header>
      <dl className="rhythm-rows">
        <dt>Follow macOS Focus</dt>
        <dd data-testid="rhythm-mac-mirror" data-phase={mirror.phase}>{mirrorText(mirror)}</dd>
        <dt>Do Not Disturb shortcuts</dt>
        <dd data-testid="rhythm-mac-shortcuts">
          {shortcutsText(shortcuts)}
          {!shortcuts.enabled && ' Blocks drive Do Not Disturb only when "Drive macOS Do Not Disturb" is on in Settings.'}
        </dd>
        {lastRun && !lastRun.ok && (
          <>
            <dt>Last run</dt>
            <dd className="rhythm-error">{lastRun.name} failed: {lastRun.error ?? 'unknown error'}</dd>
          </>
        )}
        {installFailed.length > 0 && (
          <>
            <dt>Install</dt>
            <dd className="rhythm-error">{installFailed.map((step) => `${step.name}: ${step.step} failed`).join('; ')}</dd>
          </>
        )}
      </dl>
      <p className="rhythm-muted">
        Install opens each shortcut in the Shortcuts app, which asks you to add it. Click Add Shortcut once for each.
      </p>
      <div className="rhythm-actions">
        {shortcuts.missing.length > 0 && (
          <button type="button" className="rhythm-button rhythm-primary" disabled={busy} data-testid="rhythm-shortcuts-install" onClick={() => run('macos_shortcuts_install')}>
            Install shortcuts
          </button>
        )}
        <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-shortcuts-check" onClick={refresh}>Check again</button>
      </div>
    </section>
  )
}
