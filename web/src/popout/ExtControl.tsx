/**
 * Browser control, the side bar's third entry (design C, 2026-11-07; the user: "browser control
 * (some setting for browser control but mainly want to show we can do this)"): what Walnut agents
 * do in this browser, shown first, then its few settings.
 *
 * - The status, big: agents on or off, or an agent using the tab the person is on.
 * - The tabs agents use now, each with who acts there, what it is doing and the pages it went to,
 *   with Stop; the tabs the person shared earlier, with Unshare.
 * - Its settings: let agents use this browser (the extension's switch), ask before an agent uses a
 *   new site (Walnut's site setting, PUT /api/v1/browser/settings), and Stop all.
 *
 * The state is the extension's relay word (ext-relay-model.ts), the same one the header's pill, its
 * panel and the strip read: none of them can say something else (review round 5, Sol #2).
 */
import { useCallback, useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { apiGet, apiPut } from '@/api/client';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { log } from '@/utils/log';
import { KeyButton } from './ExtAskChrome';
import { RelayRow } from './ExtRelay';
import { controlStatus, relayGroups, taskOfOwner, type RelayState } from './ext-relay-model';
import { taskHead } from './ext-tasks-model';
import { toParent } from './ext-frame';
import type { VaultState } from './ext-panel-model';

type SitesMode = 'ask' | 'any';

/** Walnut's site setting: whether an agent asks the person before it uses a site the first time. */
function useSitesMode(): { mode: SitesMode | null; set: (m: SitesMode) => void; error: string } {
  const [mode, setMode] = useState<SitesMode | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet<{ mode?: SitesMode }>('/api/v1/browser/status').then((r) => setMode(r.mode === 'ask' ? 'ask' : 'any')).catch(() => setMode(null));
  }, []);
  const set = useCallback((m: SitesMode) => {
    setMode(m);
    setError('');
    apiPut<{ mode?: SitesMode }>('/api/v1/browser/settings', { mode: m })
      .then((r) => setMode(r.mode === 'ask' ? 'ask' : 'any'))
      .catch((err) => { setError(err instanceof Error ? err.message : String(err)); log.warn('ext-control', 'site setting not saved', { error: String(err) }); });
  }, []);
  return { mode, set, error };
}

export function ExtControl({ relay, here, tasks, owner, agents, keyed, vault, keyPressed, settings }: {
  relay: RelayState | null; here: number | undefined; tasks: readonly Task[]; owner?: string; agents: boolean;
  keyed: boolean; vault: VaultState | null; keyPressed: boolean; settings: boolean;
}) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const working = (id: string) => { const t = byId.get(id); return !!t && taskHead(t).state === 'working'; };
  const { now, earlier } = relayGroups(relay, here, working);
  const status = controlStatus(relay, here, owner, agents);
  // The switch shows the person's last flip at once; the extension's word follows.
  const [want, setWant] = useState<boolean | null>(null);
  useEffect(() => { if (relay && want === relay.on) setWant(null); }, [relay, want]);
  const on = want ?? relay?.on ?? agents;
  const flip = (v: boolean) => { setWant(v); toParent({ type: 'relay-set', on: v }); };
  const sites = useSitesMode();
  const stop = (tab: number) => toParent({ type: 'relay-release', tab });
  return (
    <div className="ext-control" data-testid="ext-control">
      <header className="ext-ask-head ext-control-head" data-testid="ext-control-head">
        <span className="ext-control-title">Browser control</span>
        {keyed && <KeyButton vault={vault} pressed={keyPressed} />}
      </header>
      <div className="ext-control-body">
        <section className={`ext-control-status is-${status.kind}`} data-testid="ext-control-status" data-kind={status.kind} role="status">
          <span className="ext-control-status-dot" aria-hidden="true" />
          <span className="ext-control-status-text">
            <span className="ext-control-status-title">{status.title}</span>
            <span className="ext-control-status-line">{status.line}</span>
          </span>
        </section>

        <section className="ext-control-group" aria-label="Tabs agents use">
          <div className="ext-relay-label">In use now</div>
          {now.length === 0 && <p className="ext-relay-note" data-testid="ext-control-none">No agent is using a tab now.</p>}
          {now.map((t) => (
            <div key={t.tab} className="ext-control-tab">
              <RelayRow t={t} here={here} task={byId.get(taskOfOwner(t.owner))} action="Stop" onAction={() => stop(t.tab)} />
              {t.recent && t.recent.length > 0 && (
                <ol className="ext-control-recent" data-testid="ext-control-recent" aria-label="Pages it went to, newest first">
                  {t.recent.map((u, i) => <li key={`${i}:${u}`} title={u}>{pageWord(u)}</li>)}
                </ol>
              )}
            </div>
          ))}
          {earlier.length > 0 && <div className="ext-relay-label">Shared earlier</div>}
          {earlier.map((t) => <RelayRow key={t.tab} t={t} here={here} task={byId.get(taskOfOwner(t.owner))} action="Unshare" onAction={() => stop(t.tab)} />)}
        </section>

        <section className="ext-control-group ext-control-settings" aria-label="Browser control settings">
          <div className="ext-relay-label">Settings</div>
          <label className="ext-control-setting">
            <span className="ext-control-setting-text">
              <span className="ext-control-setting-name">Let Walnut agents use this browser</span>
              <span className="ext-control-setting-line">Off: they act only in a tab you share.</span>
            </span>
            <ToggleSwitch checked={on} onChange={flip} data-testid="ext-control-agents" aria-label="Let Walnut agents use this browser" />
          </label>
          {sites.mode && (
            <label className="ext-control-setting">
              <span className="ext-control-setting-text">
                <span className="ext-control-setting-name">Ask before a new site</span>
                <span className="ext-control-setting-line">An agent uses a site only after you approve it once.</span>
              </span>
              <ToggleSwitch checked={sites.mode === 'ask'} onChange={(v) => sites.set(v ? 'ask' : 'any')} data-testid="ext-control-ask-sites" aria-label="Ask before a new site" />
            </label>
          )}
          {sites.error && <p className="ext-relay-note ext-panel-error" role="alert">{sites.error}</p>}
          <div className="ext-control-setting">
            <span className="ext-control-setting-text">
              <span className="ext-control-setting-name">Stop all agents</span>
              <span className="ext-control-setting-line">Every tab an agent holds goes back.</span>
            </span>
            <button type="button" className="ext-relay-row-btn is-stop" data-testid="ext-control-stop-all" disabled={!relay || relay.tabs.length === 0}
              onClick={() => toParent({ type: 'relay-stop-all' })}>Stop all</button>
          </div>
          {settings && (
            <button type="button" className="ext-panel-link ext-control-more" data-testid="ext-control-settings" onClick={() => toParent({ type: 'open-view', view: 'settings' })}>
              All of the extension&apos;s settings
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

/** A page an agent went to, as a short line: its site and its path. */
function pageWord(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}`.slice(0, 120);
  } catch { return u.slice(0, 120); }
}
