/**
 * The Org page's own settings (2026-11-03, the user: "the setting should also be in the org view,
 * some kind of setting right"): a gear beside "Org chart" opens a small panel with the org's one
 * switch (useOrgSwitch.ts, the same value Settings → Org shows),
 * what turning the org off stops, and a link to the full Settings page. The gear reads "Off" while the org is off.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { ICON_GEAR } from '@/components/common/Icons';
import { log } from '@/utils/log';
import { ORG_OFF_STILL, ORG_OFF_STOPS, orgSwitchFooter, useOrgSwitch } from './useOrgSwitch';
import '@/styles/org-rail.css';

export function OrgSettingsMenu() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { on, busy, error, set, clearError } = useOrgSwitch();
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
        className={`btn btn-sm org-settings-btn${on ? '' : ' is-off'}`}
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
          className="org-answer-menu org-settings-menu"
          role="dialog"
          aria-label="Org settings"
          data-testid="org-settings-menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="org-settings-row">
            <label htmlFor="org-settings-enabled" className="org-settings-label">
              <strong>Org</strong>
              <span className="org-answer-q">Main and the VPs above your projects, and their updates.</span>
            </label>
            <ToggleSwitch id="org-settings-enabled" data-testid="org-settings-enabled" checked={on} busy={busy} onChange={flip} />
          </div>
          {error && <div className="org-thread-error" role="alert" data-testid="org-settings-error">{error}</div>}
          <div className="org-answer-q">{orgSwitchFooter(on)}</div>
          <div className="org-settings-stops" data-testid="org-settings-stops">
            <div className="org-settings-stops-head">{on ? 'Turning it off stops' : 'Off now'}</div>
            <ul>{ORG_OFF_STOPS.map((line) => <li key={line}>{line}.</li>)}</ul>
            <div className="org-answer-q">{ORG_OFF_STILL}</div>
          </div>
          <button type="button" className="btn btn-sm org-settings-all" data-testid="org-settings-all"
            onClick={() => { setOpen(false); navigate('/settings#org'); }}>All Org settings</button>
        </div>,
        document.body,
      )}
    </>
  );
}
