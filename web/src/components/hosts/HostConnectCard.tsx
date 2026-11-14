/**
 * HostConnectCard: a host's first connect, in the corner, while it runs in the background.
 *
 * 2026-11-13, the user: "why isn't there some progress bar? ... make it clear, close & run
 * background that make it clear that it will still running ... make it maybe collapse into an
 * always on notification like this" (Walnut's approval card). So it is the approval card's
 * shape, in the same corner stack (CornerSlot: the two never overlap), one row per host with
 * the step in words and a measured bar, the line saying it keeps going, and a "–" that puts it
 * down to one line ("Connecting to build-box · 34%") that stays until the connect ends; a click
 * on that line opens the card again.
 *
 * Which hosts (background-connect.ts): a host whose FIRST connect runs, never an established
 * host's reconnect. Connected, a host reads "<name> is connected" for a few seconds, then goes;
 * a failure lets it go at once (the Notifications panel says why). Everything is read from the
 * live host status, so a reload shows a running first connect again.
 *
 * It opens by itself, so it never takes the focus or a key from the page: nothing here focuses
 * itself, and its buttons keep a mouse click's focus where it was.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { CORNER_ORDER, CornerSlot, useCornerState } from '@/components/common/corner-stack';
import { SetupProgress } from '@/components/common/SetupProgress';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import {
  commitBackgroundConnectMemory, pillParts, pillText, stepBackgroundConnects, useBackgroundConnectMemory, type BackgroundConnectRow,
} from './background-connect';
import '@/components/approvals/approvals.css';
import './host-connect-card.css';

/** The card's line about closing: the connect runs in Walnut's server, not in this page. */
export const BACKGROUND_NOTE = 'Keeps going in the background. You can close this window.';

/** A mouse click on the card's buttons leaves the focus where the person had it. */
const keepFocus = (e: MouseEvent) => e.preventDefault();

function Row({ row }: { row: BackgroundConnectRow }) {
  if (row.state === 'connected') {
    return (
      <li className="hcc-row hcc-row-done" data-testid={`host-connect-row-${row.host}`} data-state="connected" role="status">
        <span className="hcc-ok" aria-hidden="true">✓</span>
        <span>{`${row.label} is connected`}</span>
      </li>
    );
  }
  return (
    <li className="hcc-row" data-testid={`host-connect-row-${row.host}`} data-state="connecting">
      <div className="hcc-title">{`Connecting to ${row.label}`}</div>
      <SetupProgress label={row.stepWords} ariaLabel={`Connecting to ${row.label}`} percent={row.percent} valueText={row.valueText} />
    </li>
  );
}

export function HostConnectCard() {
  const statuses = useAllHostStatus();
  const memory = useBackgroundConnectMemory();
  // Re-read when a connected line's hold runs out; the step itself always reads the clock now.
  const [, setTick] = useState(0);
  const { memory: next, rows, wakeAt } = stepBackgroundConnects(memory, statuses, Date.now());
  useEffect(() => { commitBackgroundConnectMemory(next); });
  useEffect(() => {
    if (wakeAt === undefined) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), Math.max(0, wakeAt - Date.now()) + 50);
    return () => window.clearTimeout(t);
  }, [wakeAt]);

  const phone = usePhoneLayout();
  const { compact } = useCornerState();
  // 'auto': whole, or one line where the corner has no room (a phone, over a chat). The person's
  // "–" and the line's click choose for as long as anything shows.
  const [form, setForm] = useState<'auto' | 'card' | 'pill'>('auto');
  if (rows.length === 0 && form !== 'auto') setForm('auto');
  const asPill = form === 'pill' || (form === 'auto' && (phone || compact));

  // A keyboard press of "–" (or of the line) took the focus with it: it moves to what replaced it.
  const handoff = useRef(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!handoff.current) return;
    handoff.current = false;
    (asPill ? pillRef.current : minimizeRef.current)?.focus();
  }, [asPill]);
  const choose = (e: MouseEvent<HTMLButtonElement>, to: 'card' | 'pill') => {
    handoff.current = document.activeElement === e.currentTarget;
    setForm(to);
  };

  if (rows.length === 0) return null;
  const connecting = rows.some((r) => r.state === 'connecting');
  const { words, percent } = pillParts(rows);
  const line = pillText(rows);

  return (
    <CornerSlot order={CORNER_ORDER.hostConnect} className="corner-slot-host-connect">
      {asPill ? (
        <button
          type="button"
          ref={pillRef}
          className="approval-aside hcc-pill"
          data-testid="host-connect-pill"
          aria-label={line}
          title={`${line}: show the details`}
          onMouseDown={keepFocus}
          onClick={(e) => choose(e, 'card')}
        >
          {connecting ? <span className="hcc-pill-spinner" aria-hidden="true" /> : <span className="hcc-ok" aria-hidden="true">✓</span>}
          <span>{words}</span>
          {percent !== undefined && <span className="hcc-pill-percent">{`· ${percent}%`}</span>}
        </button>
      ) : (
        <section className="hcc-card" role="region" aria-label="Connecting in the background" data-testid="host-connect-card">
          <div className="approval-head hcc-head">
            <span className="approval-kicker">{connecting ? 'Setting up in the background' : 'Done'}</span>
            <span className="approval-head-end">
              <button
                type="button"
                ref={minimizeRef}
                className="approval-minimize"
                aria-label="Make it smaller"
                title="Make it smaller: one line until it is done"
                data-testid="host-connect-minimize"
                onMouseDown={keepFocus}
                onClick={(e) => choose(e, 'pill')}
              >
                <span aria-hidden="true">–</span>
              </button>
            </span>
          </div>
          <ul className="hcc-rows">
            {rows.map((row) => <Row key={row.host} row={row} />)}
          </ul>
          {connecting && <div className="hcc-note" data-testid="host-connect-note">{BACKGROUND_NOTE}</div>}
        </section>
      )}
    </CornerSlot>
  );
}
