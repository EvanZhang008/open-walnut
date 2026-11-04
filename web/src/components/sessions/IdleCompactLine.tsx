/**
 * Walnut's idle compaction row (src/core/sessions/idle-compaction.ts): one line
 * that opens to say why it ran (its tokens, the threshold, where the threshold
 * came from: the session's auto-compaction window or the model's window), and
 * the setting that decides it, the same value Settings -> Sessions edits.
 */
import { useCallback, useContext, useEffect, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { fetchConfig, updateConfig } from '@/api/config';
import { fetchSession } from '@/api/sessions';
import { useEvent } from '@/hooks/useWebSocket';
import type { Config } from '@open-walnut/core';
import {
  DEFAULT_IDLE_COMPACT_LIMIT_PERCENT, IDLE_COMPACT_LIMIT_PERCENT_RANGE, idleCompactReasonText, resolveIdleCompactLimitPercent,
  type IdleCompactReason,
} from '../../../../src/core/sessions/prompt-cache';
import { disclosureIds, RowDisclosureScope, useRowDisclosure } from './row-disclosure';
import { ToggleSwitch } from '../settings/inputs/ToggleSwitch';
import '@/styles/compact-context.css';

/** The reason recorded for the compaction whose command line is `lineUuid`: undefined while it loads, null when none was kept. */
function useIdleCompactReason(sessionId: string | null, lineUuid: string | undefined): IdleCompactReason | null | undefined {
  const [reason, setReason] = useState<IdleCompactReason | null | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || !lineUuid) { setReason(null); return; }
    let live = true;
    setReason(undefined);
    fetchSession(sessionId)
      .then((rec) => {
        if (!live) return;
        const entry = rec?.idleCompactionLog?.find((e) => e.lineUuid === lineUuid);
        setReason(entry ?? null);
      })
      .catch(() => { if (live) setReason(null); });
    return () => { live = false; };
  }, [sessionId, lineUuid]);
  return reason;
}

type IdleSetting = { enabled: boolean; percent: number };
function settingOf(c: Config | null | undefined): IdleSetting {
  const ic = c?.session?.idle_compaction;
  return { enabled: ic?.enabled !== false, percent: resolveIdleCompactLimitPercent(ic?.limit_percent) };
}

/** The idle compaction's switch and threshold, written where Settings writes them. */
export function IdleCompactSetting() {
  const [setting, setSetting] = useState<IdleSetting | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetchConfig().then((c) => {
      const s = settingOf(c);
      setSetting(s);
      setDraft(String(s.percent));
    }).catch(() => setError('Could not read the setting.'));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEvent('config:changed', useCallback((data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (!key || key === 'session') load();
  }, [load]));

  // A save merges into the config as it stands now: a save keeps a key it does not mention.
  const save = async (patch: { enabled?: boolean; limit_percent?: number }) => {
    setBusy(true);
    setError(null);
    try {
      const c = await fetchConfig();
      await updateConfig({
        session: { ...(c.session ?? {}), idle_compaction: { ...(c.session?.idle_compaction ?? {}), ...patch } },
      } as Partial<Config>);
      setSetting((s) => (s ? { enabled: patch.enabled ?? s.enabled, percent: patch.limit_percent ?? s.percent } : s));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const commitPercent = () => {
    if (!setting) return;
    const n = Number(draft.trim());
    const { min, max } = IDLE_COMPACT_LIMIT_PERCENT_RANGE;
    if (draft.trim() === '') { setDraft(String(setting.percent)); return; }
    if (!Number.isFinite(n) || n < min || n > max) { setError(`Use a share from ${min}% to ${max}%.`); return; }
    const percent = Math.round(n);
    setDraft(String(percent));
    if (percent !== setting.percent) void save({ limit_percent: percent });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitPercent(); }
    if (e.key === 'Escape' && setting) { setDraft(String(setting.percent)); setError(null); }
  };

  if (!setting) return error ? <div className="idle-compact-error">{error}</div> : null;
  return (
    <div className="idle-compact-setting" data-testid="idle-compact-setting">
      <div className="idle-compact-setting-row">
        <ToggleSwitch id="idle-compact-inline" checked={setting.enabled} busy={busy} onChange={(v: boolean) => void save({ enabled: v })} />
        <label htmlFor="idle-compact-inline">Compact idle sessions</label>
        <span className="idle-compact-setting-at">at</span>
        <input
          className="idle-compact-percent"
          data-testid="idle-compact-percent"
          aria-label="Share of the auto-compaction limit"
          aria-invalid={error ? true : undefined}
          inputMode="numeric"
          value={draft}
          disabled={!setting.enabled}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          onBlur={commitPercent}
          onKeyDown={onKey}
        />
        <span className="idle-compact-setting-unit">% of the auto-compaction limit</span>
        {saved && <span className="idle-compact-saved" role="status">Saved</span>}
      </div>
      <div className="idle-compact-setting-help">
        For every session; the default is {DEFAULT_IDLE_COMPACT_LIMIT_PERCENT}%. The limit is the session's auto-compaction
        window, else its model's context window; when neither is known Walnut does not compact.{' '}
        <Link to="/settings#sessions">All session settings</Link>
      </div>
      {error && <div className="idle-compact-error" role="alert">{error}</div>}
    </div>
  );
}

/** The idle compaction's line in a session's timeline: opens to its reason and its setting. */
export function IdleCompactLine({ message, time, noticeId }: { message: string; time?: string; noticeId?: string }) {
  const sessionId = useContext(RowDisclosureScope);
  const [open, setOpen] = useRowDisclosure(noticeId ? `notice-${noticeId}` : disclosureIds.content('sys-idle-compact', message), false);
  // The live note already says why; a history row is the bare command line, its reason is on the record.
  const saysWhy = message.startsWith('Compacting this idle session');
  const reason = useIdleCompactReason(open && !saysWhy ? sessionId : null, noticeId);
  return (
    <div className="idle-compact-line" data-testid="idle-compact-line">
      <button
        type="button"
        className="session-system-line session-system-line--info idle-compact-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="session-system-text">{message}</span>
        {time && <span className="session-system-detail session-system-time">{time}</span>}
        <span className={`tool-run-chevron${open ? ' tool-run-chevron--open' : ''}`} aria-hidden="true">{'›'}</span>
      </button>
      {open && (
        <div className="idle-compact-body">
          {!saysWhy && (
            <div className="idle-compact-why" data-testid="idle-compact-why">
              {reason === undefined
                ? 'Reading why it ran…'
                : reason
                  ? <>Why: {idleCompactReasonText(reason)}.</>
                  : 'Why: not recorded for this compaction (an earlier version of Walnut ran it).'}
            </div>
          )}
          <IdleCompactSetting />
        </div>
      )}
    </div>
  );
}
