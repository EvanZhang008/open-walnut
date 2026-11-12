/**
 * Ask me before agents act (config `approvals.ask_me`, src/core/approvals/ask-me.ts; 2026-11-12, the
 * user: "I want it to be off by default don't need my approval for anything"). Off (absent): an
 * agent's post, mail, browser step, `walnut approve` and first command on another host go ahead
 * with no card or letter. On: each waits for the person's yes.
 *
 * Under the switch, while it is off: the steps that went ahead without asking, newest first (the
 * approved records marked `unasked`), so the person can read afterwards what the switch let through.
 */
import { useEffect, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { listApprovals, type Approval } from '@/api/approvals';
import { timeAgo } from '@/utils/time';
import { log } from '@/utils/log';
import '@/styles/approvals-ask-row.css';

type Save = (patch: (c: Config) => Partial<Config>, opts: { rowKey: string }) => Promise<unknown>;

/** How many show before "Show all". */
const FIRST = 5;

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
        label="Ask me before agents act"
        help="Off: agents post, send mail and run steps without asking you; each is listed below. On: each one waits for your OK."
        htmlFor="settings-approvals-ask-me"
        error={setting.error}
        data-testid="settings-approvals-ask-me-row"
        control={<ToggleSwitch id="settings-approvals-ask-me" checked={setting.value} busy={setting.busy} onChange={setting.set} />}
      />
      {!setting.value && <UnaskedList />}
    </>
  );
}

function UnaskedList() {
  const [items, setItems] = useState<Approval[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    const read = () => listApprovals('all').then((r) => {
      if (!live) return;
      setItems(r.approvals.filter((a) => a.unasked).sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)));
    }).catch((err: unknown) => {
      log.warn('settings', 'reading the steps that went ahead unasked failed', { error: err instanceof Error ? err.message : String(err) });
      if (live) setItems([]);
    });
    void read();
    const onFocus = () => { void read(); };
    window.addEventListener('focus', onFocus);
    return () => { live = false; window.removeEventListener('focus', onFocus); };
  }, []);
  if (!items) return null;
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <SettingsRow indent label="Went ahead without asking" data-testid="settings-approvals-unasked">
      {items.length === 0
        ? <p className="settings-row-help">Nothing yet.</p>
        : (
          <ul className="approvals-unasked-list">
            {shown.map((a) => (
              <li key={a.id} data-testid="settings-approvals-unasked-item">
                <span className="approvals-unasked-what">{a.what}</span>
                <span className="approvals-unasked-meta">
                  {a.requester.taskTitle ? `${a.requester.taskTitle} · ` : ''}{timeAgo(a.answer?.at ?? a.createdAt, { long: true })}
                </span>
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
