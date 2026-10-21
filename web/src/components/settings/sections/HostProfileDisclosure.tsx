/**
 * Settings › Remote Hosts, under each host: "What Walnut knows" about it.
 *
 * One collapsed row that expands into the host's learned profile (server:
 * core/hosts/host-profile.ts): its kind and why, the system, the tools it has,
 * the repositories sessions used there, and the notes sessions left about it,
 * newest first. The person can probe it again, name its kind (or hand that back
 * to Walnut) and leave a one-line note. The profile loads on the first open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchHostProfile, updateHostProfile, type HostKind, type HostProfile } from '@/api/transfer';
import { ApiError } from '@/api/client';
import { OptionPickerFlyout, type CursorPoint } from '@/components/tasks/CursorFlyout';
import { hostKindLabel, HOST_KIND_OPTIONS } from '@/components/transfer/transfer-model';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsRow } from '../SettingsSection';
import { ChevronGlyph } from '../settings-glyphs';

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
  ].filter(Boolean).join(' · ') || 'Probed, nothing reported.';
}

const message = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

export function HostProfileDisclosure({ alias, name }: { alias: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<HostProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'probe' | 'kind' | 'note' | null>(null);
  const [note, setNote] = useState('');
  const [picker, setPicker] = useState<CursorPoint | null>(null);
  const kindBtn = useRef<HTMLSpanElement>(null);

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
    if (!open || profile) return;
    let cancelled = false;
    fetchHostProfile(alias).then((r) => { if (!cancelled) apply(r.profile); })
      .catch((err) => { if (!cancelled) setError(message(err)); });
    return () => { cancelled = true; };
  }, [open, profile, alias, apply]);

  // The kind picker closes on a press outside it or Escape.
  useEffect(() => {
    if (!picker) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.('.task-kebab-project-flyout')) setPicker(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicker(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [picker]);

  const noteInFlight = useRef<string | null>(null);
  const patch = useCallback(async (kind: 'probe' | 'kind' | 'note', body: Parameters<typeof updateHostProfile>[1]) => {
    setBusy(kind);
    try {
      apply((await updateHostProfile(alias, body)).profile);
      log.info('host-profile', 'updated', { host: alias, change: kind });
    } catch (err) {
      setError(message(err));
      log.warn('host-profile', 'update failed', { host: alias, change: kind, error: message(err) });
    } finally {
      setBusy(null);
    }
  }, [alias, apply]);

  const tools = Object.entries(profile?.probed?.tools ?? {});
  const found = tools.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`);
  const missing = tools.filter(([, v]) => !v).map(([k]) => k);
  const repos = Object.entries(profile?.observed?.repoPaths ?? {});
  const notes = [...(profile?.notes ?? [])].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const currentPick = profile?.kindSetByUser ? profile.kind : AUTO;
  // Enter saves, and the save disables the field, which blurs it (WebKit fires the
  // blur): the note already on its way is not sent a second time.
  const commitNote = () => {
    if (!profile || note.trim() === (profile.userNote ?? '') || noteInFlight.current === note) return;
    noteInFlight.current = note;
    void patch('note', { user_note: note }).finally(() => { noteInFlight.current = null; });
  };

  return (
    <>
      <button
        type="button"
        className="settings-row settings-disclosure-row settings-row-indent"
        aria-expanded={open}
        data-open={open ? 'true' : 'false'}
        data-testid={`host-profile-toggle-${alias}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="settings-row-copy"><span className="settings-row-label">What Walnut knows</span></span>
        <span className="settings-row-actions">
          {profile && <span className="settings-disclosure-summary">{hostKindLabel(profile.kind)}</span>}
          <ChevronGlyph size={12} className="settings-disclosure-chevron" />
        </span>
      </button>
      {open && (
        <div className="settings-disclosure-content" data-testid={`host-profile-${alias}`}>
          {error && <SettingsRow indent label="Could not read this host" help={error} />}
          {!profile && !error && <SettingsRow indent label="Reading…" />}
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
                    onClick={() => {
                      const r = kindBtn.current?.getBoundingClientRect();
                      if (r) setPicker({ x: r.left, y: r.bottom + 2 });
                    }}
                  >
                    {hostKindLabel(profile.kind)}{profile.kindSetByUser ? '' : ' (automatic)'} ▾
                  </SettingsButton>
                  </span>
                }
              />
              <SettingsRow
                indent
                label="System"
                control={
                  <SettingsButton variant="text" disabled={busy === 'probe'} reserve={['Probe again', 'Probe now', 'Probing...']} onClick={() => void patch('probe', { refresh: true })}>
                    {busy === 'probe' ? 'Probing...' : profile?.probed ? 'Probe again' : 'Probe now'}
                  </SettingsButton>
                }
              >
                <p className="settings-row-help" data-testid="host-profile-system">{systemLine(profile)}</p>
                {profile.probed?.probedAt && <p className="settings-row-help settings-addons-muted">Probed {timeAgo(profile.probed.probedAt)}</p>}
              </SettingsRow>
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
              <SettingsRow indent label="Notes" help={notes.length ? undefined : 'Sessions have not left notes about this host.'}>
                {notes.map((n) => (
                  <p key={`${n.key}:${n.at}`} className="settings-row-help" title={n.evidence ?? n.key}>
                    {n.fact} <span className="settings-addons-muted">{timeAgo(n.at)}</span>
                  </p>
                ))}
              </SettingsRow>
              <SettingsRow
                indent
                label="Your note"
                htmlFor={`host-note-${alias}`}
                help="Sessions on this host read it."
                control={
                  <input
                    id={`host-note-${alias}`}
                    className="settings-input settings-input--long"
                    value={note}
                    maxLength={600}
                    placeholder="e.g. Use the build cache in /data"
                    disabled={busy === 'note'}
                    onChange={(e) => setNote(e.target.value)}
                    onBlur={commitNote}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitNote(); } }}
                  />
                }
              />
            </>
          )}
        </div>
      )}
      {picker && profile && (
        <OptionPickerFlyout
          anchorPoint={picker}
          anchorRef={kindBtn}
          options={KIND_PICKS}
          current={currentPick}
          ariaLabel={`Kind of ${name}`}
          onPick={(v) => void patch('kind', { kind: v === AUTO ? null : (v as HostKind) })}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );
}
