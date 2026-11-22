/**
 * Walnut's own asks (config `approvals.ask_me`, src/core/approvals/ask-me.ts; 2026-11-12, the user:
 * "I want it to be off by default don't need my approval for anything"). Off (absent): an agent's
 * post, mail, browser step, saved password and first command on another host go ahead with no card
 * or letter. On: each waits for the person's yes. A `walnut approve` the person put in a script
 * always asks, whatever this says (routes/approvals-v1.ts), and the row says so.
 *
 * Under the switch, while it is off: the steps that went ahead without asking, newest first (the
 * approved records marked `unasked`), so the person can read afterwards what the switch let through;
 * the same step from the same task is one entry with its count (groupSame).
 *
 * Only the person's own window moves it (routes/config.ts refuses an agent), on any device they are
 * signed in on: no extra ask to turn it off.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { listApprovals, type Approval } from '@/api/approvals';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import '@/styles/approvals-ask-row.css';

type Save = (patch: (c: Config) => Partial<Config>, opts: { rowKey: string }) => Promise<unknown>;

/** How many show before "Show all". */
const FIRST = 5;
/** How often the list reads again while the page shows. */
const REREAD_MS = 10_000;

export function ApprovalsAskRow({ config, save }: { config: Config; save: Save }) {
  const rowKey = 'general.approvals-ask-me';
  // Nothing stored: the server's own default (off for a person; a test server may default to on).
  const stored = config.approvals?.ask_me;
  const [effective, setEffective] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof stored === 'boolean') return;
    let live = true;
    void listApprovals('pending').then((r) => { if (live && typeof r.askMe === 'boolean') setEffective(r.askMe); }).catch(() => undefined);
    return () => { live = false; };
  }, [stored]);
  const setting = useOptimisticSetting<boolean>(
    typeof stored === 'boolean' ? stored : effective === true,
    (v) => save(() => ({ approvals: { ask_me: v } }), { rowKey }),
    { rowKey },
  );
  return (
    <>
      <SettingsRow
        label="Ask me before Walnut's own steps"
        help="Posts, mail, browser steps and uploads, passwords, a first command on a host. Off: they go ahead, listed below. A walnut approve in your own script always asks you."
        htmlFor="settings-approvals-ask-me"
        error={setting.error}
        data-testid="settings-approvals-ask-me-row"
        control={<ToggleSwitch id="settings-approvals-ask-me" checked={setting.value} busy={setting.busy} onChange={(v) => setting.set(v)} />}
      />
      <UnaskedList off={!setting.value} />
    </>
  );
}

function UnaskedList({ off }: { off: boolean }) {
  const hostLabel = useHostDisplayLabels();
  const [items, setItems] = useState<Approval[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => listApprovals('all').then((r) => {
      if (!live) return;
      setItems(r.approvals.filter((a) => a.unasked).sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)));
    }).catch((err: unknown) => {
      // What it showed stays: the next read (focus, the timer) tries again.
      log.warn('settings', 'reading the steps that went ahead unasked failed', { error: err instanceof Error ? err.message : String(err) });
    });
    void read();
    // Nothing announces a step that went ahead (it asks no one), so the list reads again while in
    // sight: on focus and every REREAD_MS while the page shows.
    const onFocus = () => { void read(); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void read(); }, REREAD_MS);
    return () => { live = false; window.removeEventListener('focus', onFocus); clearInterval(timer); };
  }, []);
  if (!items) return null;
  // On, with nothing that ever went ahead: nothing to show. Once some did, the record stays.
  if (!off && items.length === 0) return null;
  const groups = groupSame(items);
  const shown = all ? groups : groups.slice(0, FIRST);
  return (
    <SettingsRow indent label="Went ahead without asking" help={off ? undefined : 'While approvals were off. Each one asks you now.'} data-testid="settings-approvals-unasked">
      {items.length === 0
        ? <p className="settings-row-help">Nothing yet.</p>
        : (
          <ul className="approvals-unasked-list">
            {shown.map(({ lead: a, all: same }) => (
              <li key={a.id} data-testid="settings-approvals-unasked-item" data-count={same.length}>
                <details>
                  <summary>
                    <span className="approvals-unasked-what">{a.what}</span>
                    <span className="approvals-unasked-meta">
                      {a.requester.taskTitle ? `${a.requester.taskTitle} · ` : ''}
                      {same.length > 1 ? `${same.length} times, last ` : ''}{timeAgo(whenOf(a), { long: true })}
                    </span>
                  </summary>
                  <dl className="approvals-unasked-more-info">
                    {a.requester.command && (<><dt>Command</dt><dd><code>{a.requester.command}</code></dd></>)}
                    <dt>From</dt><dd>{fromText(a, hostLabel)}</dd>
                    <dt>When</dt><dd>{same.map((x) => new Date(whenOf(x)).toLocaleString()).join(', ')}</dd>
                    {a.detail && (<><dt>Detail</dt><dd><pre>{a.detail}</pre></dd></>)}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      {groups.length > FIRST && (
        <button type="button" className="approvals-unasked-more" data-testid="settings-approvals-unasked-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${groups.length}`}
        </button>
      )}
    </SettingsRow>
  );
}

function whenOf(a: Approval): string {
  return a.answer?.at ?? a.createdAt;
}

/**
 * The same step from the same task, several times (an agent retrying a sign-in), is one entry with
 * its count, at the place of its newest: five near-identical lines read as a wall (2026-11-22 audit).
 * `items` is newest first, so each group's lead is its newest.
 */
export function groupSame(items: Approval[]): Array<{ lead: Approval; all: Approval[] }> {
  const byKey = new Map<string, { lead: Approval; all: Approval[] }>();
  for (const a of items) {
    const key = `${a.requester.taskId ?? a.requester.taskTitle ?? ''}\u0000${a.what}`;
    const group = byKey.get(key);
    if (group) group.all.push(a);
    else byKey.set(key, { lead: a, all: [a] });
  }
  return [...byKey.values()];
}

/** Who asked, in a few words: the task, the process, the machine (by its label). */
function fromText(a: Approval, hostLabel: (alias: string) => string): string {
  const r = a.requester;
  const who = r.taskTitle ? `“${r.taskTitle}”` : r.process ? r.process : 'a script';
  return `${who} ${r.local ? 'on this computer' : `on ${hostLabel(r.host)}`}`;
}
