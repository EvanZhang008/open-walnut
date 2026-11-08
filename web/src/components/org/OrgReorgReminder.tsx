/**
 * One line above the Org page's list once there are many VPs (org-reorg-reminder.ts): open the
 * chart to merge some, close it for this load, or never see it again.
 */
import { useState } from 'react';
import { log } from '@/utils/log';
import {
  REORG_NEVER_KEY, REORG_NEVER_VALUE, closeReorgReminder, reorgClosedAt, reorgLine, reorgNeverFrom, showReorgReminder,
} from './org-reorg-reminder';

function storedNever(): boolean {
  try { return reorgNeverFrom(localStorage.getItem(REORG_NEVER_KEY)); } catch { return false; }
}

export function OrgReorgReminder({ vps, onOpenChart }: { vps: number; onOpenChart: () => void }) {
  const [never, setNever] = useState(storedNever);
  const [closedAt, setClosedAt] = useState(reorgClosedAt);
  if (!showReorgReminder(vps, never, closedAt)) return null;
  const close = () => {
    log.info('org-page', 'reorg reminder closed for this load', { vps });
    setClosedAt(closeReorgReminder(vps));
  };
  const neverAgain = () => {
    log.info('org-page', 'reorg reminder turned off', { vps });
    // An `open-walnut-` key: ui-prefs-sync mirrors it to the server, so it holds on every device.
    try { localStorage.setItem(REORG_NEVER_KEY, REORG_NEVER_VALUE); } catch { /* storage off: off for this load */ }
    setNever(true);
  };
  return (
    <div className="org-reorg-note" role="note" data-testid="org-reorg-reminder">
      <span className="org-reorg-text">{reorgLine(vps)}</span>
      <span className="org-reorg-actions">
        <button type="button" className="org-reorg-btn is-primary" data-testid="org-reorg-chart" onClick={onOpenChart}>Org chart</button>
        <button type="button" className="org-reorg-btn" data-testid="org-reorg-close" onClick={close}>Close</button>
        <button type="button" className="org-reorg-btn" data-testid="org-reorg-never" onClick={neverAgain}>Never remind me</button>
      </span>
    </div>
  );
}
