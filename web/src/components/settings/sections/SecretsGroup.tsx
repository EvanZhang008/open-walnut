/**
 * "Secrets" under Remote Hosts > More settings: the secrets the user keeps on this Mac and the
 * hosts each is copied to, so a task there keeps working while the Mac is away
 * (src/core/secrets/fleet-secrets.ts). The value goes up once, in the save, and never comes back:
 * a row shows only where each copy stands. A rotate is a new value; unticking a host removes its
 * copy; Delete removes every copy, after "Delete <name>?" (RemoveConfirmRow, the page's one way
 * of asking). Each host's Details also has its own switch per secret (HostThisPart.tsx); the
 * data is the page's one read (host-settings-data.tsx).
 *
 * The form (2026-11-04 review): Escape is Cancel and gives the focus back to Add; a refused
 * Save scrolls to the first field it refuses, focuses it and says why next to it.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import type { FleetSecret, SecretChange } from '@/api/secrets';
import { SettingsRow } from '../SettingsSection';
import { SettingsFoldGroup } from '../SettingsFoldGroup';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SecretInput } from '../inputs/SecretInput';
import { focusLanded } from '@/utils/focus-landed';
import { RemoveConfirmRow } from './RemoveConfirmRow';
import { useHostSettings } from './host-settings-data';
import { mergeSecretHosts, tickSecretHost } from './secret-hosts';

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
  // A host's part can carry its own commas (an error), so the parts are kept apart by a semicolon.
  if (s.deletedAt) return `Deleted. ${parts.join('; ')}`;
  return parts.length ? parts.join('; ') : 'Kept on this Mac only: tick a host to copy it there';
}

/** Which field a refusal is about: it shows under that field, which takes the focus. */
type Field = 'name' | 'value' | 'env' | 'form';
const FIELD_ID: Record<Exclude<Field, 'form'>, string> = { name: 'secret-name', value: 'secret-value', env: 'secret-env' };

interface Draft {
  name: string;
  value: string;
  description: string;
  /** The ticks under Copy to, and the server's hosts they were made against (secret-hosts.ts). */
  hosts: string[];
  opened: string[];
  env: string;
  sessions: boolean;
}

function draftOf(s: FleetSecret | null): Draft {
  return s
    ? { name: s.name, value: '', description: s.description ?? '', hosts: [...s.hosts], opened: [...s.hosts], env: s.env ?? '', sessions: s.sessions === true }
    : { name: '', value: '', description: '', hosts: [], opened: [], env: '', sessions: false };
}

/** The first refusal a Save meets, in the order the fields stand. */
export function secretRefusal(d: { name: string; value: string; sessions: boolean; env: string }, isNew: boolean, taken: (name: string) => boolean): { field: Exclude<Field, 'form'>; text: string } | null {
  const name = d.name.trim();
  if (isNew && !name) return { field: 'name', text: 'Give it a name, like github-read.' };
  if (!NAME_RE.test(name)) return { field: 'name', text: 'A name is lower case letters, digits, . _ - (like github-read).' };
  if (isNew && taken(name)) return { field: 'name', text: `${name} already exists: use its Edit to rotate it.` };
  if (isNew && !d.value) return { field: 'value', text: 'Paste the value.' };
  if (d.sessions && !d.env.trim()) return { field: 'env', text: 'Sessions get it as an environment variable: give its name (GH_TOKEN).' };
  return null;
}

export function SecretsGroup({ hostLabels }: { hostLabels: Record<string, string> }) {
  const ctx = useHostSettings();
  const data = ctx?.secrets;
  const state = data?.state ?? null;
  // null = closed; '' = adding a new one; a name = editing that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<{ field: Field; text: string } | null>(null);
  const [deleting, setDeleting] = useState<{ name: string; busy: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const group = useRef<HTMLDivElement>(null);
  // 2026-11-04 review: a refused Save put its reason above the group, off screen, and focus stayed on Save.
  const [focusField, setFocusField] = useState<Field | 'name-new' | 'add' | { edit: string } | null>(null);
  const setError = (text: string | null, field: Field = 'form') => {
    setErrorState(text === null ? null : { field, text });
    if (text !== null && field !== 'form') setFocusField(field);
  };
  useEffect(() => {
    if (!focusField) return;
    const raf = requestAnimationFrame(() => {
      setFocusField(null);
      if (focusField === 'add') { focusLanded(group.current?.querySelector<HTMLElement>('[data-testid="secret-add"]')); return; }
      if (typeof focusField === 'object') { focusLanded(group.current?.querySelector<HTMLElement>(`[data-secret-name="${CSS.escape(focusField.edit)}"] [data-secret-edit]`)); return; }
      const id = focusField === 'name-new' ? 'secret-name' : focusField === 'form' ? null : FIELD_ID[focusField];
      const el = id ? root.current?.querySelector<HTMLElement>(`[data-testid="${id}"]`) : null;
      // The field may sit under the sticky header or below the fold: its row comes into view first.
      if (focusField !== 'name-new') (el?.closest('.settings-row') ?? el)?.scrollIntoView({ block: 'center' });
      focusLanded(el);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusField]);

  if (!data || state === null) return null;
  // A host's name, as its row says it (This Mac is a name here, like the others).
  const label = (host: string) => (host === LOCAL ? 'This Mac' : hostLabels[host] || host);
  // What Copy to shows ticked: the ticks made here over the server's hosts now, so a host's own
  // copy switch flipped while this is open is not undone by its Save (review).
  const isNew = editing === '';
  const serverHosts = isNew ? [] : state.secrets.find((s) => s.name === editing && !s.deletedAt)?.hosts ?? draft.opened;
  const shownHosts = isNew ? draft.hosts : mergeSecretHosts(serverHosts, draft.opened, draft.hosts);
  const tick = (h: string, on: boolean) => setDraft({ ...draft, hosts: tickSecretHost(shownHosts, h, on), opened: [...serverHosts] });
  // A host no longer configured but still ticked stays in the list, so it can be unticked.
  const hostKeys = [...new Set([LOCAL, ...Object.keys(hostLabels), ...shownHosts])];
  const open = (s: FleetSecret | null) => {
    setEditing(s ? s.name : '');
    setDraft(draftOf(s));
    setError(null);
    setDeleting(null);
    // Add: straight into the Name field.
    if (!s) setFocusField('name-new');
  };
  // Cancel ends the edit and what it was refused for (2026-11-04 review: the refusal stayed on top
  // of the group after Cancel); the focus goes back to where the edit began.
  const close = (back = true) => {
    const was = editing;
    setEditing(null);
    setDraft(draftOf(null));
    setError(null);
    if (back) setFocusField(was ? { edit: was } : 'add');
  };

  const save = async () => {
    const refusal = secretRefusal(draft, isNew, (n) => state.secrets.some((s) => s.name === n && !s.deletedAt));
    if (refusal) { setError(refusal.text, refusal.field); return; }
    const name = draft.name.trim();
    const change: SecretChange = {
      hosts: shownHosts,
      env: draft.env.trim() || null,
      sessions: draft.sessions,
      description: draft.description.trim(),
      ...(draft.value ? { value: draft.value } : {}),
      ...(isNew ? { create: true } : {}),
    };
    setBusy(true);
    setError(null);
    try {
      await data.save(name, change);
      close();
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setError(null);
    setDeleting({ name, busy: true });
    try {
      await data.remove(name);
      if (editing === name) close(false);
      setDeleting(null);
      setFocusField('add');
    } catch (err) {
      setDeleting(null);
      setError(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const live = state.secrets.filter((s) => !s.deletedAt).length;
  const secretsSummary = !state.active ? 'Off on a test server' : live ? `${live} ${live === 1 ? 'secret' : 'secrets'}` : 'None yet';
  const footer = state.active
    ? 'Kept on this Mac and copied only to the hosts you tick, readable only by your account there, so a task there keeps working while the Mac is away. A value is never shown again, logged or synced. A session already running keeps the environment it started with: restart it after a rotate or revoke.'
    : 'This Walnut is a test or throwaway server: secrets live with your own Walnut.';
  const invalid = (f: Field) => (error?.field === f ? true : undefined);

  return (
    <SettingsFoldGroup id="rh-more-secrets" heading="Secrets" data-testid="fleet-secrets" footer={footer} summary={secretsSummary}>
      <div ref={group} className="settings-rows-contents">
        {error && editing === null && <p className="hf-error" role="status">{error.text}</p>}
        {state.active && state.secrets.length === 0 && editing === null && (
          <SettingsRow label="No secret yet" help="Add one (a read-only GitHub token, say) and pick the hosts that may use it." />
        )}
        {state.secrets.map((s) => (
          <Fragment key={s.name}>
            <SettingsRow
              data-secret-name={s.name}
              label={s.description ? `${s.name}: ${s.description}` : s.name}
              help={`${copiesLine(s, label)}${s.env && s.sessions && s.hosts.length ? `; sessions there get $${s.env}` : ''}`}
              control={
                <>
                  {!s.deletedAt && (
                    <SettingsButton variant="text" disabled={busy} onClick={() => open(s)} aria-label={`Edit ${s.name}`} data-secret-edit="">Edit</SettingsButton>
                  )}
                  <SettingsButton variant="text" disabled={busy || !!deleting} onClick={() => setDeleting({ name: s.name, busy: false })} aria-label={`Delete ${s.name}`} data-secret-delete="">Delete</SettingsButton>
                </>
              }
            />
            {deleting?.name === s.name && (
              <RemoveConfirmRow
                question={`Delete ${s.name}?`}
                note={s.hosts.length ? 'Its copy on every host is removed too.' : 'It is on this Mac only.'}
                action="Delete"
                busy={deleting.busy}
                testId="secret-delete-confirm"
                onCancel={() => { setDeleting(null); requestAnimationFrame(() => focusLanded(group.current?.querySelector<HTMLElement>(`[data-secret-name="${CSS.escape(s.name)}"] [data-secret-delete]`))); }}
                onConfirm={() => void remove(s.name)}
              />
            )}
          </Fragment>
        ))}
        {state.active && editing === null && (
          <SettingsRow label="Add a secret" control={<SettingsButton onClick={() => open(null)} data-testid="secret-add">Add</SettingsButton>} />
        )}
        {editing !== null && (
          <div
            className="fleet-secret-editor"
            data-testid="secret-editor"
            ref={root}
            onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } }}
          >
            {isNew && (
              <SettingsRow label="Name" htmlFor="secret-name" help="Lower case, like github-read: sessions find it at $WALNUT_SECRETS_DIR/<name>." error={error?.field === 'name' ? error.text : undefined} control={
                <input id="secret-name" type="text" data-no-draft="secret" className="settings-input settings-input--short settings-input--mono" spellCheck={false}
                  aria-invalid={invalid('name')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="secret-name" />
              } />
            )}
            <SettingsRow label={isNew ? 'Value' : `Value of ${editing}`} help={isNew ? 'Pasted once; Walnut never shows it again.' : 'Replace to rotate: every host gets the new value.'} error={error?.field === 'value' ? error.text : undefined} control={
              <SecretInput value={draft.value} onChange={(v) => setDraft({ ...draft, value: v })} saved={!isNew} aria-label="Secret value" aria-invalid={invalid('value')} data-testid="secret-value" />
            } />
            <SettingsRow label="What it is" htmlFor="secret-description" help="Sessions read this to know when to use it." control={
              <input id="secret-description" type="text" data-no-draft="secret" className="settings-input settings-input--short" value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="GitHub, read only" data-testid="secret-description" />
            } />
            <SettingsRow label="Copy to" help="Only these hosts get a copy; unticking one removes it there." />
            {hostKeys.map((h) => (
              <SettingsCheckbox key={h} checked={shownHosts.includes(h)} label={label(h)} data-testid={`secret-host-${h}`}
                onChange={(on) => tick(h, on)} />
            ))}
            <SettingsRow label="Environment name" htmlFor="secret-env" help="Optional: the variable a session on those hosts gets it as." error={error?.field === 'env' ? error.text : undefined} control={
              <input id="secret-env" type="text" data-no-draft="secret" className="settings-input settings-input--short settings-input--mono" spellCheck={false}
                aria-invalid={invalid('env')} value={draft.env} onChange={(e) => setDraft({ ...draft, env: e.target.value.toUpperCase() })} placeholder="GH_TOKEN" data-testid="secret-env" />
            } />
            <SettingsCheckbox checked={draft.sessions} label="Give it to every new session on those hosts" data-testid="secret-sessions"
              onChange={(on) => setDraft({ ...draft, sessions: on })} />
            <SettingsRow error={error?.field === 'form' ? error.text : undefined} control={
              <>
                <SettingsButton variant="text" onClick={() => close()} disabled={busy} data-testid="secret-cancel">Cancel</SettingsButton>
                <SettingsButton variant="primary" holdFocus busy={busy} busyLabel="Saving..." onClick={() => void save()} data-testid="secret-save">Save</SettingsButton>
              </>
            } />
          </div>
        )}
      </div>
    </SettingsFoldGroup>
  );
}
