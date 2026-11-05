/**
 * "This host", the part of a host's Details that holds the settings of that one host (2026-11-04
 * review: one host's settings sat in its row, its menu, its Details and four groups under More
 * settings, and two buttons named "Retry" meant different things). In order: how many sessions it
 * works on at once (config.yaml's session_limits, saved with the hosts), whether tasks on other
 * hosts may use it (its switch, the tasks that did and a Revoke for each, the ones declined and
 * an Allow), Walnut on it (HostServersGroup.tsx: Update to this build, Restart tunnel), and which
 * secrets are copied to it. The data is the page's one read (host-settings-data.tsx).
 */
import { useState } from 'react';
import type { ExecGrant } from '@/api/host-exec';
import { SettingsRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { NumberInput } from '../inputs/NumberInput';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { HostServerPart } from './HostServersGroup';
import { useHostSettings } from './host-settings-data';

/** The limit a host has when config.yaml names none (src/core/session-tracker.ts). */
export const DEFAULT_LIMIT = { local: 7, remote: 20, cloudBox: 2 } as const;
/** The cloud companion's box (src/core/hosts/cloud-box-host.ts CLOUD_BOX_HOST_ALIAS). */
const CLOUD_BOX = '__cloudbox__';

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** A grant's second line: since when, and what it ran. */
export function grantSummary(g: ExecGrant): string {
  const parts = [`${g.via === 'own-host' ? 'Allowed (it runs on one of your hosts)' : 'Allowed'} ${when(g.grantedAt)}`];
  parts.push(g.runs ? `${g.runs} use${g.runs === 1 ? '' : 's'}, last ${when(g.lastRunAt ?? g.grantedAt)}: ${g.lastCommand ?? ''}` : 'not used yet');
  // Each part has its own commas (dates), so the parts are kept apart by a semicolon.
  return parts.join('; ');
}

/** Where one secret's copy on this host stands. */
function copyLine(copy: { version: number | null; error?: string } | undefined, version: number, on: boolean): string {
  if (on && copy && copy.version === version && !copy.error) return 'Copied here.';
  if (on) return copy?.error ? `Not copied yet: ${copy.error}` : 'Sending it here...';
  if (copy && copy.version !== null) return copy.error ? `Still here: removed once it connects (${copy.error}).` : 'Removing it here...';
  return 'Not copied here.';
}

export function HostThisPart({ host, name, limitKey, server = false, secrets = true }: {
  /** The host's key: '__local__' for this Mac, else its alias. */
  host: string;
  name: string;
  /** Its key in session_limits ('local' for this Mac); none for a host this page does not save. */
  limitKey?: string;
  /** Walnut can run on it (a remote host saved here). */
  server?: boolean;
  /** Secrets can be copied to it (this Mac, or a host saved here). */
  secrets?: boolean;
}) {
  const ctx = useHostSettings();
  // A copy change the server refused, said under that secret's row.
  const [copyError, setCopyError] = useState<{ name: string; text: string } | null>(null);
  if (!ctx) return null;
  const { exec, limits } = ctx;
  const id = host.replace(/[^A-Za-z0-9_-]/g, '-');
  const limit = limitKey ? limits.values[limitKey] : undefined;
  const limitValue = limit === undefined || limit === '' ? undefined : typeof limit === 'number' ? limit : parseInt(String(limit), 10) || undefined;
  const fallback = limitKey === 'local' ? DEFAULT_LIMIT.local : limitKey === CLOUD_BOX ? DEFAULT_LIMIT.cloudBox : DEFAULT_LIMIT.remote;
  // An older page saved a cleared limit as 0; the server runs at least 1 (session-tracker.ts).
  const zero = limitValue === 0;
  const open = !exec.closed.includes(host);
  const grants = (exec.grants ?? []).filter((g) => g.host === host);
  const denied = exec.denied.filter((d) => d.host === host);
  const live = (ctx.secrets.state?.secrets ?? []).filter((s) => !s.deletedAt);

  return (
    <section className="rh-this-host-part" data-testid={`rh-this-host-${host}`} aria-label={`Settings of ${name}`}>
      <h4 className="rh-this-host-heading">This host</h4>
      {limitKey && (
        <SettingsRow
          label="Session limit"
          htmlFor={`rh-limit-${id}`}
          help={zero
            ? `Most sessions it works on at once. Saved as 0, which counts as 1. Empty: ${fallback}, the default.`
            : `Most sessions it works on at once. Empty: ${fallback}, the default.`}
          data-testid="rh-host-limit"
          control={
            <NumberInput
              id={`rh-limit-${id}`}
              data-testid={`rh-limit-${id}`}
              value={limitValue}
              placeholder={String(fallback)}
              min={1}
              unit="sessions"
              onChange={(v) => limits.set((prev) => {
                const next = { ...prev };
                if (v === undefined) delete next[limitKey]; else next[limitKey] = v;
                return next;
              })}
            />
          }
        />
      )}
      {exec.grants !== null && (
        <>
          <SettingsRow
            label="Tasks on other hosts may use it"
            help={open
              ? 'A task on another of your hosts runs commands, calls MCP servers and reaches web services here without asking you. Each one shows below.'
              : 'Off: nothing new starts here from another host.'}
            error={exec.error?.host === host ? exec.error.text : undefined}
            data-testid="rh-host-exec"
            data-exec-host={host}
            control={
              <ToggleSwitch
                checked={open}
                aria-label={`Tasks on other hosts may use ${name}`}
                data-testid={`rh-host-exec-switch-${id}`}
                onChange={(v) => void exec.toggleHost(host, v)}
              />
            }
          />
          {grants.map((g) => (
            <SettingsRow
              key={g.id}
              indent
              data-grant-id={g.id}
              label={g.taskTitle || g.taskId}
              help={grantSummary(g)}
              control={
                <SettingsButton
                  variant="text"
                  holdFocus
                  busy={exec.busy === g.id}
                  busyLabel="Revoking..."
                  reserve={['Revoke', 'Revoking...']}
                  aria-label={`Revoke ${g.taskTitle || g.taskId} on ${name}`}
                  onClick={() => void exec.revoke(g)}
                >
                  Revoke
                </SettingsButton>
              }
            />
          ))}
          {denied.map((d) => {
            const key = `${d.taskId}:${d.host}`;
            return (
              <SettingsRow
                key={`denied-${key}`}
                indent
                data-denied={key}
                label={d.taskTitle || d.taskId}
                help={`You declined it ${when(d.answeredAt ?? d.askedAt)}.`}
                control={
                  <SettingsButton
                    variant="text"
                    holdFocus
                    busy={exec.busy === key}
                    busyLabel="Allowing..."
                    reserve={['Allow', 'Allowing...']}
                    aria-label={`Allow ${d.taskTitle || d.taskId} on ${name}`}
                    onClick={() => void exec.allow(d)}
                  >
                    Allow
                  </SettingsButton>
                }
              />
            );
          })}
          {open && grants.length === 0 && denied.length === 0 && (
            <SettingsRow indent label="No task from another host has used it yet." />
          )}
        </>
      )}
      {server && <HostServerPart hostKey={host} />}
      {secrets && ctx.secrets.state?.active && (
        live.length === 0
          ? <SettingsRow label="Secrets" help="No secret yet: add one under More settings, Secrets, and copy it here." data-testid="rh-host-secrets" />
          : (
            <>
              <SettingsRow label="Secrets copied here" help="A task here reads them while your Mac is away." data-testid="rh-host-secrets" />
              {live.map((s) => {
                const on = s.hosts.includes(host);
                const key = `${s.name}:${host}`;
                return (
                  <SettingsRow
                    key={s.name}
                    indent
                    data-secret-copy={s.name}
                    label={s.name}
                    help={copyLine(s.copies[host], s.version, on)}
                    error={copyError?.name === s.name ? copyError.text : undefined}
                    control={
                      <ToggleSwitch
                        checked={on}
                        busy={ctx.secrets.busy === key}
                        aria-label={`Copy ${s.name} to ${name}`}
                        data-testid={`rh-secret-copy-${s.name}-${id}`}
                        onChange={(v) => {
                          ctx.secrets.setBusy(key);
                          setCopyError(null);
                          void ctx.secrets
                            .save(s.name, { hosts: v ? [...s.hosts, host] : s.hosts.filter((h) => h !== host) })
                            .catch((err: unknown) => setCopyError({ name: s.name, text: `Could not change it: ${err instanceof Error ? err.message : String(err)}` }))
                            .finally(() => ctx.secrets.setBusy(null));
                        }}
                      />
                    }
                  />
                );
              })}
            </>
          )
      )}
    </section>
  );
}
