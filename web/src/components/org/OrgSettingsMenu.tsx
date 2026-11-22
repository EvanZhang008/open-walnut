/**
 * The Org page's own settings (2026-11-03, the user: "the setting should also be in the org view,
 * some kind of setting right"): a gear beside "Org chart" opens a small panel with the org's one
 * switch (useOrgSwitch.ts, the same value Settings → Org shows),
 * one short line under it (what turning it off stops is its hover, and Settings → Org), and a link
 * to the full Settings page. The gear reads "Off" while the org is off.
 * While the Directors experiment is on it also picks how the Directors are listed (useDirectorSettings.ts),
 * the same values Settings → Org shows.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { ICON_GEAR } from '@/components/common/Icons';
import { log } from '@/utils/log';
import { ORG_OFF_LINE, orgSwitchTitle, useOrgSwitch } from './useOrgSwitch';
import { SegmentedControl } from '@/components/settings/inputs/SegmentedControl';
import { DIRECTORS_LAYOUT_LABEL, DIRECTORS_LAYOUT_OPTIONS, DIRECTORS_PROJECTS_HELP, DIRECTORS_PROJECTS_LABEL, directorsLayoutHelp, useDirectorSettings } from './useDirectorSettings';
import '@/styles/org-rail.css';

export function OrgSettingsMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { on, busy, error, set, clearError } = useOrgSwitch();
  const dir = useDirectorSettings();
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 200, onAnchorLost: () => setOpen(false) });
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { setOpen(false); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  const flip = (next: boolean) => {
    log.info('org-page', 'org switch from the Org page', { on: next });
    set(next);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`btn ${on ? 'btn-icon' : 'btn-sm btn-ghost'} org-settings-btn${on ? '' : ' is-off'}`}
        data-testid="org-settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={on ? 'Org settings' : 'Org settings: the org is off'}
        title="Org settings"
        onClick={() => { if (!open) clearError(); setOpen(!open); }}
      >{ICON_GEAR}{!on && <span className="org-settings-off">Off</span>}</button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu org-settings-menu wn-overlay"
          role="dialog"
          aria-label="Org settings"
          data-testid="org-settings-menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* A settings panel holds settings: one short line under the switch, the why on hover and in
              Settings › Org (2026-11-21, the user on this panel, full of explanation: "the setting is
              shit", "no taste"). */}
          <div className="org-settings-row" title={orgSwitchTitle(on)}>
            <label htmlFor="org-settings-enabled" className="org-settings-label">
              <strong>Org</strong>
              <span className="org-settings-sub" data-testid="org-settings-stops">{on ? 'CEO and the VPs above your projects' : ORG_OFF_LINE}</span>
            </label>
            <ToggleSwitch id="org-settings-enabled" data-testid="org-settings-enabled" checked={on} busy={busy} onChange={flip} />
          </div>
          {error && <div className="org-thread-error" role="alert" data-testid="org-settings-error">{error}</div>}
          {dir.on && (
            <div className="org-settings-directors" data-testid="org-settings-directors">
              <div className="org-settings-row" title={directorsLayoutHelp(dir.layout)}>
                <span className="org-settings-label"><strong>Directors</strong></span>
                <SegmentedControl size="sm" aria-label={DIRECTORS_LAYOUT_LABEL} value={dir.layout} options={DIRECTORS_LAYOUT_OPTIONS} disabled={dir.busy} onChange={dir.setLayout} />
              </div>
              <div className="org-settings-row" title={DIRECTORS_PROJECTS_HELP}>
                <label htmlFor="org-settings-directors-projects" className="org-settings-label">
                  <strong>{DIRECTORS_PROJECTS_LABEL}</strong>
                </label>
                <ToggleSwitch id="org-settings-directors-projects" data-testid="org-settings-directors-projects" checked={dir.showProjects} busy={dir.busy} onChange={dir.setShowProjects} />
              </div>
              {dir.error && <div className="org-thread-error" role="alert">{dir.error}</div>}
            </div>
          )}
          <button type="button" className="btn btn-link org-settings-all" data-testid="org-settings-all"
            title="What each setting does, and every Org setting"
            onClick={() => { setOpen(false); navigate('/settings#org'); }}>Open Org settings ›</button>
        </div>,
        document.body,
      )}
    </>
  );
}
