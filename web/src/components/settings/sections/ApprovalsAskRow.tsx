/**
 * Ask me before agents act (config `approvals.ask_me`, src/core/approvals/ask-me.ts; 2026-11-12, the
 * user: "I want it to be off by default don't need my approval for anything"). Off (absent): an
 * agent's post, mail, browser step, `walnut approve` and first command on another host go ahead
 * with no card or letter. On: each waits for the person's yes.
 *
 * Under the switch, while it is off: the steps that went ahead without asking, newest first (the
 * approved records marked `unasked`), so the person can read afterwards what the switch let through.
 *
 * Turning it off while a device signs approvals is itself an approval (Face ID or Touch ID): the
 * switch stays on, its dialog opens, and the server turns the switch off once it is signed.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { listApprovals, type Approval } from '@/api/approvals';
import { askApprovalsOff, useApprovals } from '@/components/approvals/approvals-store';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
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
  // Off while a device signs: the "Turn approvals off" approval this row opened, until it settles.
  const [offAsk, setOffAsk] = useState<string | null>(null);
  const [offBusy, setOffBusy] = useState(false);
  const [offError, setOffError] = useState<string | null>(null);
  const approvals = useApprovals();
  const offWaiting = offAsk !== null && setting.value && approvals.items.has(offAsk);
  const onChange = (v: boolean) => {
    setOffError(null);
    if (v) { setOffAsk(null); setting.set(true); return; }
    setOffBusy(true);
    void askApprovalsOff().then((out) => {
      if ('approvalId' in out) setOffAsk(out.approvalId);
      else setting.set(false);
    }).catch((err: unknown) => {
      setOffError(`Couldn't turn approvals off: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => setOffBusy(false));
  };
  return (
    <>
      <SettingsRow
        label="Ask me before agents act"
        help={offWaiting
          ? 'Approve “Turn approvals off” with Face ID or Touch ID to finish. Until then agents still ask you.'
          : 'Off: agents post, send mail and run steps without asking you; each is listed below. On: each one waits for your OK.'}
        htmlFor="settings-approvals-ask-me"
        error={setting.error ?? offError}
        data-testid="settings-approvals-ask-me-row"
        control={<ToggleSwitch id="settings-approvals-ask-me" checked={setting.value} busy={setting.busy || offBusy} onChange={onChange} />}
      />
      <UnaskedList off={!setting.value} />
    </>
  );
}

function UnaskedList({ off }: { off: boolean }) {
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
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <SettingsRow indent label="Went ahead without asking" help={off ? undefined : 'While approvals were off. Each one asks you now.'} data-testid="settings-approvals-unasked">
      {items.length === 0
        ? <p className="settings-row-help">Nothing yet.</p>
        : (
          <ul className="approvals-unasked-list">
            {shown.map((a) => (
              <li key={a.id} data-testid="settings-approvals-unasked-item">
                <details>
                  <summary>
                    <span className="approvals-unasked-what">{a.what}</span>
                    <span className="approvals-unasked-meta">
                      {a.requester.taskTitle ? `${a.requester.taskTitle} · ` : ''}{timeAgo(a.answer?.at ?? a.createdAt, { long: true })}
                    </span>
                  </summary>
                  <dl className="approvals-unasked-more-info">
                    {a.requester.command && (<><dt>Command</dt><dd><code>{a.requester.command}</code></dd></>)}
                    <dt>From</dt><dd>{fromText(a)}</dd>
                    <dt>When</dt><dd>{new Date(a.answer?.at ?? a.createdAt).toLocaleString()}</dd>
                    {a.detail && (<><dt>Detail</dt><dd><pre>{a.detail}</pre></dd></>)}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        )}
      {items.length > FIRST && (
        <button type="button" className="approvals-unasked-more" data-testid="settings-approvals-unasked-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </SettingsRow>
  );
}

/** Who asked, in a few words: the task, the process, the machine. */
function fromText(a: Approval): string {
  const r = a.requester;
  const who = r.taskTitle ? `“${r.taskTitle}”` : r.process ? r.process : 'a script';
  return `${who} ${r.local ? 'on this computer' : `on ${r.host}`}`;
}
