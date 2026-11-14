// The reader's inline "Choose area" for one message with no routing record: confirms this message only.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '@/api/client';
import { onMailAreaConfirmed } from './mail-route-live';

// `version`: a reused id's new reply must not show the old delivery's confirmation.
export interface MailRouterSource { account: string; message: string; version?: string }
/** `paused`: no router of the area reads anything now (the line says so instead of "Routing pending"). */
export interface MailRouterAreaRef { id: string; name: string; paused?: boolean }

export const ORG_ROUTER_SETUP_PATH = '/org?router_setup=1';
export const ONLY_THIS_MESSAGE = 'This confirms this message only. It gives the router no access to the rest of the account.';

export const sourceKeyOf = (s: MailRouterSource): string => `${s.account}\n${s.message}\n${s.version ?? ''}`;

/**
 * Under the route line, which already names the area and whether its router is paused: what the
 * confirmation covers. Never says routed: routing comes later.
 */
export const CONFIRMED_NOTE = 'This message only';

/**
 * The areas the server lists, each with an id, a name and whether its routers are all paused (or it
 * has none); anything else is left out.
 */
export function areasOf(body: unknown): MailRouterAreaRef[] {
  const list = (body as { areas?: unknown } | null)?.areas;
  if (!Array.isArray(list)) return [];
  const routers = (body as { routers?: unknown }).routers;
  const reading = new Set((Array.isArray(routers) ? routers : []).flatMap((r) => {
    const one = r as { areaId?: unknown; paused?: unknown };
    return typeof one?.areaId === 'string' && one.paused === false ? [one.areaId] : [];
  }));
  return list.flatMap((a) => {
    const one = a as { id?: unknown; name?: unknown };
    return typeof one?.id === 'string' && one.id
      ? [{ id: one.id, name: typeof one.name === 'string' && one.name ? one.name : one.id, paused: !reading.has(one.id) }]
      : [];
  });
}

type AreasState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'error'; text: string } | { kind: 'ready'; areas: MailRouterAreaRef[] };

// Only keys that act on the form's own controls: the mail app's other shortcuts still work.
const FORM_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Escape']);

export function MailRouterAssignment({ source, confirmed }: { source: MailRouterSource; confirmed?: MailRouterAreaRef }) {
  const navigate = useNavigate();
  const key = sourceKeyOf(source);
  // Every piece of state names the message it was made for, so a late answer never shows on another.
  const [asking, setAsking] = useState<string | null>(null);
  const [areas, setAreas] = useState<{ key: string; state: AreasState }>({ key, state: { kind: 'idle' } });
  const [choice, setChoice] = useState<{ key: string; areaId: string } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);
  const [done, setDone] = useState<{ key: string; area: MailRouterAreaRef } | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  const areasSeq = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; areasSeq.current++; }; }, []);
  // A response is shown only while this component is mounted and still on the message it was for.
  const live = (forKey: string) => mounted.current && currentKey.current === forKey;

  const shownConfirmed = confirmed ?? (done?.key === key ? done.area : undefined);
  const formOpen = asking === key;
  const areasState: AreasState = areas.key === key ? areas.state : { kind: 'idle' };
  const pick = choice?.key === key ? choice.areaId : '';
  const busy = sending === key;
  const error = failure?.key === key ? failure.text : '';

  const loadAreas = () => {
    const forKey = key;
    const mine = ++areasSeq.current;
    setAreas({ key: forKey, state: { kind: 'loading' } });
    apiGet<unknown>('/api/v1/router/areas')
      .then((body) => { if (mine === areasSeq.current && live(forKey)) setAreas({ key: forKey, state: { kind: 'ready', areas: areasOf(body) } }); })
      .catch((err) => {
        if (mine === areasSeq.current && live(forKey)) {
          setAreas({ key: forKey, state: { kind: 'error', text: err instanceof Error ? err.message : 'Could not read the router areas.' } });
        }
      });
  };

  const openForm = () => { setAsking(key); setFailure(null); loadAreas(); };

  const confirm = async (list: MailRouterAreaRef[]) => {
    const area = list.find((a) => a.id === pick);
    if (!area || busy) return;
    const forKey = key;
    const body = { source: { kind: 'mail', account: source.account, message: source.message, ...(source.version ? { version: source.version } : {}) }, area_id: area.id };
    setSending(forKey);
    setFailure(null);
    try {
      const res = await apiPost<{ areaId?: string; assigned?: boolean }>('/api/v1/router/assign', body);
      const confirmedArea = res?.assigned === true ? { id: res.areaId || area.id, name: area.name, paused: area.paused } : null;
      // Keyed by the message, so a late answer still updates its own row after the reader moved on.
      if (confirmedArea) onMailAreaConfirmed(source, confirmedArea);
      if (!live(forKey)) return;
      if (!confirmedArea) throw new Error('The server did not confirm the area.');
      setDone({ key: forKey, area: confirmedArea });
      setAsking(null);
    } catch (err) {
      if (live(forKey)) setFailure({ key: forKey, text: err instanceof Error ? err.message : 'The area was not confirmed.' });
    } finally {
      if (live(forKey)) setSending(null);
    }
  };

  if (shownConfirmed) {
    return (
      <p className="mail-router-assign is-confirmed" data-testid="mail-router-confirmed" data-area-id={shownConfirmed.id}>
        {CONFIRMED_NOTE}
      </p>
    );
  }

  if (!formOpen) {
    return (
      <div className="mail-router-assign">
        <button type="button" className="mail-router-choose" data-testid="mail-router-choose" onClick={openForm}>Choose area</button>
      </div>
    );
  }

  return (
    <form
      className="mail-router-assign is-open"
      data-testid="mail-router-form"
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Escape' && !busy) { e.preventDefault(); setAsking(null); }
        if (FORM_KEYS.has(e.key)) e.stopPropagation();
      }}
      onSubmit={(e) => { e.preventDefault(); if (areasState.kind === 'ready') void confirm(areasState.areas); }}
    >
      <p className="mail-router-note">{ONLY_THIS_MESSAGE}</p>
      {areasState.kind === 'loading' && <p className="mail-router-note" data-testid="mail-router-loading">Loading areas…</p>}
      {areasState.kind === 'error' && (
        <p className="mail-router-error" role="alert" data-testid="mail-router-areas-error">
          {areasState.text}{' '}
          <button type="button" className="mail-router-link" onClick={loadAreas}>Try again</button>
        </p>
      )}
      {areasState.kind === 'ready' && areasState.areas.length === 0 && (
        <p className="mail-router-note" data-testid="mail-router-no-area">
          No router area yet.{' '}
          <button type="button" className="mail-router-link" data-testid="mail-router-create" onClick={() => navigate(ORG_ROUTER_SETUP_PATH)}>Create router in Org</button>
        </p>
      )}
      {areasState.kind === 'ready' && areasState.areas.length > 0 && (
        <fieldset className="mail-router-areas" data-testid="mail-router-areas" disabled={busy}>
          <legend>Area for this message</legend>
          {areasState.areas.map((a) => (
            <label key={a.id} className="mail-router-area">
              <input type="radio" name={`mail-router-area-${key}`} value={a.id} checked={pick === a.id} onChange={() => setChoice({ key, areaId: a.id })} />
              {a.name}
            </label>
          ))}
        </fieldset>
      )}
      {error && <p className="mail-router-error" role="alert" data-testid="mail-router-error">{error}</p>}
      <div className="mail-router-actions">
        {areasState.kind === 'ready' && areasState.areas.length > 0 && (
          <button type="submit" className="btn btn-sm btn-primary" data-testid="mail-router-confirm" disabled={busy || !pick}>
            {busy ? 'Confirming…' : error ? 'Try again' : 'Confirm for this message'}
          </button>
        )}
        <button type="button" className="btn btn-sm" data-testid="mail-router-cancel" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
      </div>
    </form>
  );
}
