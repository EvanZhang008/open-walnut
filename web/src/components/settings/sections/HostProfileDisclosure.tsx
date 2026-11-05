/**
 * Settings › Remote Hosts, in a host's Details (HostDetails.tsx): "What Walnut knows" about it.
 *
 * The host's learned profile (server: core/hosts/host-profile.ts): its kind and why, the tools it
 * has, the repositories sessions used there, and what Walnut learned it is used for
 * (core/hosts/host-learning.ts, from the sessions that ran there). The person can name its kind
 * (or hand that back to Walnut) and leave a one-line note. Its system is the Details' one System
 * line (`profileSystemLine`), with Probe again: Probing..., then the new line and its time, or why
 * it could not (2026-11-04 review: the press showed nothing, and the line was said twice). Each
 * opening of Details reads the profile again (and the Details' opening reads the host again).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { fetchHostProfile, updateHostProfile, type HostKind, type HostProfile } from '@/api/transfer';
import { ApiError } from '@/api/client';
import { OptionPickerFlyout, type CursorPoint } from '@/components/tasks/CursorFlyout';
import { hostKindLabel, HOST_KIND_OPTIONS } from '@/components/transfer/transfer-model';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsRow } from '../SettingsSection';
import { ChevronGlyph } from '../settings-glyphs';
import { MicField, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation } from '@/hooks/useSendAfterDictation';
import { focusLanded } from '@/utils/focus-landed';
import '@/styles/settings-mic.css';

const AUTO = 'auto';
const KIND_PICKS = [{ value: AUTO, label: 'Automatic' }, ...HOST_KIND_OPTIONS];

function gb(bytes?: number): string | null {
  return typeof bytes === 'number' && bytes > 0 ? `${Math.round(bytes / 1024 ** 3)} GB` : null;
}

function systemLine(p: HostProfile): string {
  const o = p.probed;
  if (!o) return 'Not probed yet.';
  return [
    o.os?.prettyName ?? [o.os?.platform, o.os?.release].filter(Boolean).join(' '),
    o.arch,
    o.cpus ? `${o.cpus} CPUs` : null,
    gb(o.memBytes) ? `${gb(o.memBytes)} memory` : null,
    gb(o.diskFreeBytes) ? `${gb(o.diskFreeBytes)} free` : null,
  ].filter(Boolean).join(', ') || 'Probed, nothing reported.';
}

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

export interface HostProfileState {
  profile: HostProfile | null;
  error: string | null;
  busy: 'probe' | 'kind' | 'note' | null;
  /** What the last Probe again found: a new reading, nothing new, or why it could not. */
  probe: { kind: 'done' | 'same' | 'failed'; text?: string } | null;
  patch: (kind: 'probe' | 'kind' | 'note', body: Parameters<typeof updateHostProfile>[1]) => Promise<void>;
  apply: (p: HostProfile) => void;
  /** The note as typed, and the saved one it follows while untouched. */
  note: string;
  setNote: (t: string) => void;
}

/** The host's profile, read when Details open; its probe, kind and note writes. */
export function useHostProfile(alias: string): HostProfileState {
  const [profile, setProfile] = useState<HostProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'probe' | 'kind' | 'note' | null>(null);
  const [probe, setProbe] = useState<HostProfileState['probe']>(null);
  const [note, setNote] = useState('');

  // The note field follows the saved note only while the user has not typed in
  // it: a save of another field (the kind) must not wipe a note being written.
  const syncedNote = useRef('');
  const apply = useCallback((p: HostProfile) => {
    setProfile(p);
    const saved = p.userNote ?? '';
    setNote((cur) => (cur === syncedNote.current ? saved : cur));
    syncedNote.current = saved;
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchHostProfile(alias).then((r) => { if (!cancelled) apply(r.profile); })
      .catch((err) => { if (!cancelled) setError(message(err)); });
    return () => { cancelled = true; };
  }, [alias, apply]);

  const patch = useCallback(async (kind: 'probe' | 'kind' | 'note', body: Parameters<typeof updateHostProfile>[1]) => {
    setBusy(kind);
    if (kind === 'probe') setProbe(null);
    const before = profile?.probed?.probedAt;
    try {
      const next = (await updateHostProfile(alias, body)).profile;
      apply(next);
      if (kind === 'probe') setProbe({ kind: next.probed?.probedAt && next.probed.probedAt !== before ? 'done' : 'same' });
      log.info('host-profile', 'updated', { host: alias, change: kind });
    } catch (err) {
      if (kind === 'probe') setProbe({ kind: 'failed', text: message(err).replace(/[.\s]*$/, '') });
      else setError(message(err));
      log.warn('host-profile', 'update failed', { host: alias, change: kind, error: message(err) });
    } finally {
      setBusy(null);
    }
  }, [alias, apply, profile?.probed?.probedAt]);

  return { profile, error, busy, probe, patch, apply, note, setNote };
}

/** The Details' System line from the probe, with Probe again and what it found. */
export function profileSystemLine(hp: HostProfileState, fallback: string): { text: string; meta: ReactNode; action: ReactNode } {
  const { profile, busy, probe } = hp;
  const at = profile?.probed?.probedAt;
  const meta = probe?.kind === 'failed'
    ? <span className="hf-probe-note" data-tone="bad" role="status" data-testid="host-probe-note">Could not probe it: {probe.text}.{at ? ` This is what it said ${timeAgo(at)}.` : ''}</span>
    : probe?.kind === 'same'
      ? <span className="hf-probe-note" role="status" data-testid="host-probe-note">The host did not answer the probe; this is what it said {at ? timeAgo(at) : 'before'}.</span>
      : at ? <span className="hf-probe-note" role={probe ? 'status' : undefined} data-testid="host-probe-note">Probed {timeAgo(at)}.</span> : null;
  return {
    text: profile?.probed ? systemLine(profile) : fallback,
    meta,
    action: (
      <SettingsButton
        variant="text"
        holdFocus
        busy={busy === 'probe'}
        busyLabel="Probing..."
        reserve={['Probe again', 'Probe now', 'Probing...']}
        onClick={() => void hp.patch('probe', { refresh: true })}
        data-testid="host-probe"
      >
        {profile?.probed ? 'Probe again' : 'Probe now'}
      </SettingsButton>
    ),
  };
}

export function HostProfileDisclosure({ hp, alias, name }: { hp: HostProfileState; alias: string; name: string }) {
  const { profile, error, busy, note, setNote, patch } = hp;
  const noteRef = useRef<HTMLInputElement | null>(null);
  const noteMic = useRef<BoxMicHandle | null>(null);
  const [picker, setPicker] = useState<CursorPoint | null>(null);
  const kindBtn = useRef<HTMLSpanElement>(null);

  // The kind picker closes on a press outside it or Escape; Escape and a pick give focus back
  // to the Kind button (it fell to the page).
  // At once, while the list still holds the focus (2026-11-05 review: once, WebKit left it on the
  // page), and again a frame later for a focus that fell meanwhile.
  const backToKind = useCallback(() => {
    const kind = kindBtn.current?.querySelector('button');
    focusLanded(kind);
    setPicker(null);
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) focusLanded(kindBtn.current?.querySelector('button'));
    });
  }, []);
  useEffect(() => {
    if (!picker) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.('.task-kebab-project-flyout')) setPicker(null); };
    // Escape here is the list's own: it does not also close the Details around it.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backToKind(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey, true); };
  }, [picker, backToKind]);
  // A pick disables the button while it saves (a disabled button takes no focus), so the
  // focus comes back once the save rendered, unless the person moved it since.
  const refocusKind = useRef(false);
  useEffect(() => {
    if (busy === 'kind' || !refocusKind.current) return;
    refocusKind.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) focusLanded(kindBtn.current?.querySelector('button'));
  }, [busy]);

  const noteInFlight = useRef<string | null>(null);
  const tools = Object.entries(profile?.probed?.tools ?? {});
  const found = tools.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  const missing = tools.filter(([, v]) => !v).map(([k]) => k);
  const repos = Object.entries(profile?.observed?.repoPaths ?? {});
  const currentPick = profile?.kindSetByUser ? profile.kind : AUTO;
  // Enter saves, and the save disables the field, which blurs it (WebKit fires the
  // blur): the note already on its way is not sent a second time.
  const commitNote = () => {
    if (!profile || note.trim() === (profile.userNote ?? '') || noteInFlight.current === note) return;
    noteInFlight.current = note;
    void patch('note', { user_note: note }).finally(() => { noteInFlight.current = null; });
  };
  // Enter while the mic records waits for the final words, then saves.
  const noteGate = useSendAfterDictation([noteMic], () => { noteMic.current?.clear(); commitNote(); });

  return (
    <>
      <div className="settings-disclosure-content" data-testid={`host-profile-${alias}`}>
          {error && <SettingsRow indent label="Could not read this host" help={error} />}
          {!profile && !error && <SettingsRow indent label="Reading..." />}
          {profile && (
            <>
              <SettingsRow
                indent
                label="Kind"
                help={(profile.kindReasons ?? []).join('; ') || undefined}
                control={
                  <span ref={kindBtn}>
                  <SettingsButton
                    variant="text"
                    aria-haspopup="listbox"
                    aria-label={`Kind of ${name}`}
                    disabled={busy === 'kind'}
                    holdFocus
                    onClick={() => {
                      const r = kindBtn.current?.getBoundingClientRect();
                      if (r) setPicker({ x: r.left, y: r.bottom + 2 });
                    }}
                  >
                    {hostKindLabel(profile.kind)}{profile.kindSetByUser ? '' : ' (automatic)'}
                    <ChevronGlyph size={10} className="rh-kind-chevron" />
                  </SettingsButton>
                  </span>
                }
              />
              {tools.length > 0 && (
                <SettingsRow indent label="Tools">
                  <p className="settings-row-help settings-addons-mono">{found.join(', ') || 'None found.'}</p>
                  {missing.length > 0 && <p className="settings-row-help">Not found: {missing.join(', ')}</p>}
                </SettingsRow>
              )}
              <SettingsRow indent label="Repositories" help={repos.length ? undefined : 'None seen yet.'}>
                {repos.map(([key, r]) => (
                  <p key={key} className="settings-row-help settings-addons-mono" title={`${key}, seen ${timeAgo(r.at)}`}>{r.path}</p>
                ))}
              </SettingsRow>
              <SettingsRow indent label="Used for" help={profile.learned ? undefined : 'Walnut has not learned this yet: it writes this once sessions have run here.'}>
                {profile.learned && (
                  <>
                    <p className="settings-row-help" data-testid="host-profile-learned">{profile.learned.summary}</p>
                    <p className="settings-row-help settings-addons-muted">From {profile.learned.sessionCount} session{profile.learned.sessionCount === 1 ? '' : 's'}, {timeAgo(profile.learned.at)}</p>
                  </>
                )}
              </SettingsRow>
              <SettingsRow
                indent
                label="Your note"
                htmlFor={`host-note-${alias}`}
                help="Walnut uses it to describe this host."
                control={
                  <MicField
                    inline
                    fieldClassName="settings-mic-field settings-mic-field-long"
                    boxRef={noteRef}
                    text={note}
                    setText={(t) => setNote(t.slice(0, 600))}
                    handleRef={noteMic}
                    disabled={busy === 'note'}
                  >
                    <input
                      ref={noteRef}
                      id={`host-note-${alias}`}
                      data-no-draft="autosave"
                      className="settings-input settings-input--long"
                      value={note}
                      maxLength={600}
                      placeholder="e.g. Use the build cache in /data"
                      disabled={busy === 'note'}
                      onChange={(e) => setNote(e.target.value)}
                      onBlur={commitNote}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); noteGate.send(); } }}
                    />
                  </MicField>
                }
              />
            </>
          )}
      </div>
      {picker && profile && (
        <OptionPickerFlyout
          anchorPoint={picker}
          anchorRef={kindBtn}
          options={KIND_PICKS}
          current={currentPick}
          ariaLabel={`Kind of ${name}`}
          onPick={(v) => { refocusKind.current = true; void patch('kind', { kind: v === AUTO ? null : (v as HostKind) }); }}
          onClose={backToKind}
        />
      )}
    </>
  );
}
