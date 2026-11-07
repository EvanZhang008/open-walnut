/**
 * The browser relay on the extension's first page (spec items 3 and 5 of design option A): the
 * header's pill (Relay on, Relay off, Agent in tab), the small panel it opens (agents on or off,
 * the tab an agent uses now with Stop, the tabs shared earlier with Unshare, Stop all), and the
 * strip under the composer while an agent acts in the tab the person is on. The extension owns
 * the state (agent.ts) and every change: this only says what the person pressed (ext-relay-model.ts).
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Task } from '@open-walnut/core';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { ownerWord, relayGroups, relayTabName, taskOfOwner, type RelayPillKind, type RelayState, type RelayTab } from './ext-relay-model';
import { taskHead } from './ext-tasks-model';
import { taskPageTitle } from './ext-home-model';
import { firstQuestionOf } from './ext-panel-model';
import { toParent } from './ext-frame';

export function RelayPill({ kind, label, open, onToggle, pillRef }: { kind: RelayPillKind; label: string; open: boolean; onToggle: () => void; pillRef: RefObject<HTMLButtonElement | null> }) {
  return (
    <button ref={pillRef} type="button" className={`ext-relay-pill is-${kind}${open ? ' is-open' : ''}`} data-testid="ext-relay-pill" data-kind={kind}
      aria-haspopup="dialog" aria-expanded={open} title="Browser relay: what Walnut agents may do in this browser" onClick={onToggle}>
      <span className="ext-relay-dot" aria-hidden="true" />{label}
    </button>
  );
}

/**
 * Who acts and what it does: the task's name (its first question while it wears Walnut's
 * placeholder title, as on its page) and its state line; else the extension's word for who.
 */
export function whatOf(task: Task | undefined, who: string | undefined): string {
  const head = task ? taskHead(task) : null;
  const name = task ? taskPageTitle(task.title, firstQuestionOf(task.id)) : who ?? '';
  return [name, head?.line ?? ''].filter(Boolean).join(' · ');
}

/** A task's name and line for a relay row, its Stop or Unshare after it. */
export function RelayRow({ t, here, task, action, onAction }: { t: RelayTab; here: number | undefined; task?: Task; action: 'Stop' | 'Unshare'; onAction: () => void }) {
  const what = whatOf(task, t.who ?? ownerWord(t.owner));
  const site = (t.url ? (() => { try { return new URL(t.url).host; } catch { return ''; } })() : '') || 'tab';
  const letter = (site.replace(/^www\./, '').match(/[a-z0-9]/i)?.[0] ?? '?').toUpperCase();
  return (
    <div className={`ext-relay-row${t.tab === here ? ' is-here' : ''}`} data-testid="ext-relay-row" data-tab={t.tab}>
      <span className="ext-chip-fav" aria-hidden="true">{letter}</span>
      <span className="ext-relay-row-text">
        <span className="ext-relay-row-name">{relayTabName(t, here)}</span>
        {what && <span className="ext-relay-row-what">{what}</span>}
      </span>
      <button type="button" className={`ext-relay-row-btn${action === 'Stop' ? ' is-stop' : ''}`} data-testid={action === 'Stop' ? 'ext-relay-stop' : 'ext-relay-unshare'} onClick={onAction}>{action}</button>
    </div>
  );
}

/**
 * The relay panel under the pill. `relay` null: an extension that does not say its relay (older
 * than this page): the switch is in its Settings.
 */
export function RelayPanel({ relay, here, tasks, anchorRef, onClose, settings }: {
  relay: RelayState | null; here: number | undefined; tasks: readonly Task[]; anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void; settings: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const place = useMenuPlacement(true, anchorRef, ref, { align: 'start', gap: 6, minHeight: 160, onAnchorLost: onClose });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const working = (id: string) => { const t = byId.get(id); return !!t && taskHead(t).state === 'working'; };
  const { now, earlier } = relayGroups(relay, here, working);
  // The switch shows the person's last flip at once; the extension's word follows.
  const [want, setWant] = useState<boolean | null>(null);
  useEffect(() => { if (relay && want === relay.on) setWant(null); }, [relay, want]);
  const on = want ?? relay?.on ?? false;
  // A press outside the panel or its pill closes it, as Escape does.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el && (ref.current?.contains(el) || anchorRef.current?.contains(el))) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); anchorRef.current?.focus(); } };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key, true); };
  }, [onClose, anchorRef]);
  const stop = (t: RelayTab) => toParent({ type: 'relay-release', tab: t.tab });
  return (
    <div ref={ref} className="ext-relay-panel" role="dialog" aria-label="Browser relay" data-testid="ext-relay-panel"
      style={place ? { top: place.top, right: place.right, maxHeight: place.maxHeight } : { visibility: 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}>
      <div className="ext-relay-head">
        <span className="ext-relay-title">Browser relay</span>
        {relay && (
          <label className="ext-relay-switch">
            <ToggleSwitch checked={on} data-testid="ext-relay-agents" aria-label="Let Walnut agents use this browser"
              onChange={(v) => { setWant(v); toParent({ type: 'relay-set', on: v }); }} />
            <span>{on ? 'Agents on' : 'Agents off'}</span>
          </label>
        )}
      </div>
      {relay ? (
        <>
          <p className="ext-relay-note">{on ? 'Agents can act in tabs you share with them, and open their own in a window of their own.' : 'Agents act only in a tab you share with them (Act in this tab).'}</p>
          {now.length > 0 && <div className="ext-relay-label">In use now</div>}
          {now.map((t) => <RelayRow key={t.tab} t={t} here={here} task={byId.get(taskOfOwner(t.owner))} action="Stop" onAction={() => stop(t)} />)}
          {earlier.length > 0 && <div className="ext-relay-label">Shared earlier</div>}
          {earlier.map((t) => <RelayRow key={t.tab} t={t} here={here} task={byId.get(taskOfOwner(t.owner))} action="Unshare" onAction={() => stop(t)} />)}
          {now.length + earlier.length === 0 && <p className="ext-relay-note" data-testid="ext-relay-none">No agent is using a tab now.</p>}
          {now.length + earlier.length > 0 && (
            <div className="ext-relay-foot">
              <span>Stop all agents</span>
              <button type="button" className="ext-relay-row-btn is-stop" data-testid="ext-relay-stop-all" onClick={() => toParent({ type: 'relay-stop-all' })}>Stop all</button>
            </div>
          )}
        </>
      ) : (
        <p className="ext-relay-note">Turn agents on or off in the extension&apos;s Settings.{' '}
          {settings && <button type="button" className="ext-panel-link" onClick={() => { onClose(); toParent({ type: 'open-view', view: 'settings' }); }}>Settings</button>}
        </p>
      )}
    </div>
  );
}

/** The strip under the composer while an agent acts in this tab: who, what it does, and Stop. */
export function RelayStrip({ task, who, onStop }: { task?: Task; who?: string; onStop: () => void }) {
  const what = whatOf(task, who);
  return (
    <div className="ext-relay-strip" data-testid="ext-relay-strip" role="status">
      <span className="ext-relay-strip-dot" aria-hidden="true" />
      <span className="ext-relay-strip-text">
        <span className="ext-relay-strip-title">Walnut agent is using this tab</span>
        {what && <span className="ext-relay-strip-what">{what}</span>}
      </span>
      <button type="button" className="ext-relay-row-btn is-stop" data-testid="ext-relay-strip-stop" onClick={onStop}>Stop</button>
    </div>
  );
}
