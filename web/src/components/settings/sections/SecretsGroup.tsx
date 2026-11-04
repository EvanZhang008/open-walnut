/**
 * "Secrets" in Remote Hosts: the secrets the user keeps on this Mac and the
 * hosts each is copied to, so a task there keeps working while the Mac is away
 * (src/core/secrets/fleet-secrets.ts). The value goes up once, in the save, and
 * never comes back: a row shows only where each copy stands. A rotate is a new
 * value; unticking a host removes its copy; Delete removes every copy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteSecret, fetchSecrets, saveSecret, type FleetSecret, type SecretChange } from '@/api/secrets';
import { log } from '@/utils/log';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SecretInput } from '../inputs/SecretInput';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { focusLanded } from '@/utils/focus-landed';
import { useFoldAttention } from '../SettingsFold';

const REFRESH_MS = 30_000;
const LOCAL = '__local__';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Where each copy stands, one clause per host. */
export function copiesLine(s: FleetSecret, label: (host: string) => string): string {
  const hosts = [...new Set([...s.hosts, ...Object.keys(s.copies)])];
  const parts = hosts.flatMap((h) => {
    const c = s.copies[h];
    const shared = s.hosts.includes(h);
    if (shared && c && c.version === s.version && !c.error) return [`${label(h)}: copied`];
    if (shared) return [`${label(h)}: ${c?.error ? `not copied yet (${c.error})` : 'sending'}`];
    if (c && c.version !== null) return [`${label(h)}: ${c.error ? `still there, removed when it connects (${c.error})` : 'removing'}`];
    return [];
  });
  if (s.deletedAt) return `Deleted. ${parts.join(' · ')}`;
  return parts.length ? parts.join(' · ') : 'Kept on this Mac only: tick a host to copy it there';
}

/** Which field a refusal is about: it shows under that field, which takes the focus. */
type Field = 'name' | 'value' | 'env' | 'form';
const FIELD_ID: Record<Exclude<Field, 'form'>, string> = { name: 'secret-name', value: 'secret-value', env: 'secret-env' };

interface Draft {
  name: string;
  value: string;
  description: string;
  hosts: string[];
  env: string;
  sessions: boolean;
}

function draftOf(s: FleetSecret | null): Draft {
  return s
    ? { name: s.name, value: '', description: s.description ?? '', hosts: [...s.hosts], env: s.env ?? '', sessions: s.sessions === true }
    : { name: '', value: '', description: '', hosts: [], env: '', sessions: false };
}

export function SecretsGroup({ hostLabels }: { hostLabels: Record<string, string> }) {
  const [state, setState] = useState<{ active: boolean; secrets: FleetSecret[] } | null>(null);
  // null = closed; '' = adding a new one; a name = editing that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<{ field: Field; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // 2026-11-04 review: a refused Save put its reason above the group, off screen, and focus stayed on Save.
  const [focusField, setFocusField] = useState<Field | 'name-new' | null>(null);
  const setError = (text: string | null, field: Field = 'form') => {
    setErrorState(text === null ? null : { field, text });
    if (text !== null && field !== 'form') setFocusField(field);
  };
  useEffect(() => {
    if (!focusField) return;
    const raf = requestAnimationFrame(() => {
      const id = focusField === 'name-new' ? 'secret-name' : focusField === 'form' ? null : FIELD_ID[focusField];
      focusLanded(id ? root.current?.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null);
      setFocusField(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusField]);
  // A copy that could not go to a host needs a look (More settings says how many).
  const needs = (state?.secrets ?? []).filter((s) => !s.deletedAt && Object.values(s.copies).some((c) => !!c.error)).length;
  useFoldAttention('secrets', needs);

  const load = useCallback(async () => {
    try {
      setState(await fetchSecrets());
    } catch (err) {
      log.warn('settings', 'secrets read failed', { error: String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (state === null) return null;
  const label = (host: string) => (host === LOCAL ? 'this Mac' : hostLabels[host] || host);
  // A host no longer configured but still ticked stays in the list, so it can be unticked.
  const hostKeys = [...new Set([LOCAL, ...Object.keys(hostLabels), ...draft.hosts])];
  const open = (s: FleetSecret | null) => {
    setEditing(s ? s.name : '');
    setDraft(draftOf(s));
    setError(null);
    // Add: straight into the Name field.
    if (!s) setFocusField('name-new');
  };
  const close = () => { setEditing(null); setDraft(draftOf(null)); };
  const isNew = editing === '';

  const save = async () => {
    const name = draft.name.trim();
    if (!NAME_RE.test(name)) { setError('A name is lower case letters, digits, . _ - (like github-read).', 'name'); return; }
    if (isNew && !draft.value) { setError('Paste the value.', 'value'); return; }
    if (isNew && state.secrets.some((s) => s.name === name && !s.deletedAt)) { setError(`${name} already exists: use its Edit to rotate it.`, 'name'); return; }
    if (draft.sessions && !draft.env.trim()) { setError('Sessions get it as an environment variable: give its name (GH_TOKEN).', 'env'); return; }
    const change: SecretChange = {
      hosts: draft.hosts,
      env: draft.env.trim() || null,
      sessions: draft.sessions,
      description: draft.description.trim(),
      ...(draft.value ? { value: draft.value } : {}),
      ...(isNew ? { create: true } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await saveSecret(name, change);
      log.info('settings', 'secret saved', { name, hosts: draft.hosts, rotated: !!draft.value });
      close();
      await load();
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: FleetSecret) => {
    setError(null);
    try {
      const r = await deleteSecret(s.name);
      log.info('settings', 'secret deleted', { name: s.name, pending: r.pending });
      if (editing === s.name) close();
      await load();
    } catch (err) {
      setError(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const footer = state.active
    ? 'Kept on this Mac and copied only to the hosts you tick, readable only by your account there, so a task there keeps working while the Mac is away. A value is never shown again, logged or synced. A session already running keeps the environment it started with: restart it after a rotate or revoke.'
    : 'This Walnut is a test or throwaway server: secrets live with your own Walnut.';

  return (
    <SettingsGroup heading="Secrets" data-testid="fleet-secrets" footer={footer}>
      {error && editing === null && <p className="hf-error" role="status">{error.text}</p>}
      {state.active && state.secrets.length === 0 && editing === null && (
        <SettingsRow label="No secret yet" help="Add one (a read-only GitHub token, say) and pick the hosts that may use it." />
      )}
      {state.secrets.map((s) => (
        <SettingsRow
          key={s.name}
          data-secret-name={s.name}
          label={s.description ? `${s.name} · ${s.description}` : s.name}
          help={`${copiesLine(s, label)}${s.env && s.sessions && s.hosts.length ? ` · sessions there get $${s.env}` : ''}`}
          control={
            <>
              {!s.deletedAt && (
                <SettingsButton variant="text" disabled={busy} onClick={() => open(s)} aria-label={`Edit ${s.name}`}>Edit</SettingsButton>
              )}
              <InlineConfirmButton onConfirm={() => remove(s)} label="Delete" confirmLabel="Confirm delete" aria-label={`Delete ${s.name}`} disabled={busy} />
            </>
          }
        />
      ))}
      {state.active && editing === null && (
        <SettingsRow label="Add a secret" control={<SettingsButton onClick={() => open(null)} data-testid="secret-add">Add…</SettingsButton>} />
      )}
      {editing !== null && (
        <div className="fleet-secret-editor" data-testid="secret-editor" ref={root}>
          {isNew && (
            <SettingsRow label="Name" htmlFor="secret-name" help="Lower case, like github-read: sessions find it at $WALNUT_SECRETS_DIR/<name>." error={error?.field === 'name' ? error.text : undefined} control={
              <input id="secret-name" type="text" data-no-draft="secret" className="settings-input settings-input--short settings-input--mono" spellCheck={false}
                value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="secret-name" />
            } />
          )}
          <SettingsRow label={isNew ? 'Value' : `Value of ${editing}`} help={isNew ? 'Pasted once; Walnut never shows it again.' : 'Replace to rotate: every host gets the new value.'} error={error?.field === 'value' ? error.text : undefined} control={
            <SecretInput value={draft.value} onChange={(v) => setDraft({ ...draft, value: v })} saved={!isNew} aria-label="Secret value" data-testid="secret-value" />
          } />
          <SettingsRow label="What it is" htmlFor="secret-description" help="Sessions read this to know when to use it." control={
            <input id="secret-description" type="text" data-no-draft="secret" className="settings-input settings-input--short" value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="GitHub, read only" data-testid="secret-description" />
          } />
          <SettingsRow label="Copy to" help="Only these hosts get a copy; unticking one removes it there." />
          {hostKeys.map((h) => (
            <SettingsCheckbox key={h} checked={draft.hosts.includes(h)} label={label(h)} data-testid={`secret-host-${h}`}
              onChange={(on) => setDraft({ ...draft, hosts: on ? [...draft.hosts, h] : draft.hosts.filter((x) => x !== h) })} />
          ))}
          <SettingsRow label="Environment name" htmlFor="secret-env" help="Optional: the variable a session on those hosts gets it as." error={error?.field === 'env' ? error.text : undefined} control={
            <input id="secret-env" type="text" data-no-draft="secret" className="settings-input settings-input--short settings-input--mono" spellCheck={false}
              value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value.toUpperCase() })} placeholder="GH_TOKEN" data-testid="secret-env" />
          } />
          <SettingsCheckbox checked={draft.sessions} label="Give it to every new session on those hosts" data-testid="secret-sessions"
            onChange={(on) => setDraft({ ...draft, sessions: on })} />
          <SettingsRow error={error?.field === 'form' ? error.text : undefined} control={
            <>
              <SettingsButton variant="text" onClick={close} disabled={busy}>Cancel</SettingsButton>
              <SettingsButton variant="primary" onClick={() => void save()} disabled={busy} data-testid="secret-save">{busy ? 'Saving…' : 'Save'}</SettingsButton>
            </>
          } />
        </div>
      )}
    </SettingsGroup>
  );
}
