/**
 * Walnut's idle compaction row (src/core/sessions/idle-compaction.ts): one line
 * that opens to say why it ran (its tokens, the threshold, where the threshold
 * came from: the session's auto-compaction window or the model's window), and
 * the setting that decides it, the same value Settings -> Sessions edits.
 */
import { DisclosureChevron } from '@/components/controls';
import { useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { fetchConfig, fetchFreshConfig, updateConfig } from '@/api/config';
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
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A read that failed, apart from what the row said about the reader's own input: the next good read clears it.
  const [readError, setReadError] = useState<string | null>(null);
  // The setting as this row shows it, kept beside the state so a config:changed that comes back
  // during a save compares with what the save set.
  const shown = useRef<IdleSetting | null>(null);
  const show = useLeanCallback((s: IdleSetting | null) => { shown.current = s; setSetting(s); }, []);
  const read = useLeanCallback(async (fresh: boolean): Promise<IdleSetting | null> => {
    try {
      const s = settingOf(await (fresh ? fetchFreshConfig() : fetchConfig()));
      setReadError(null);
      return s;
    } catch {
      setReadError('Could not read the setting.');
      return null;
    }
  }, []);
  const load = useCallback((fresh = false) => {
    void read(fresh).then((s) => {
      if (!s) return;
      const was = shown.current;
      // The echo of this row's own save (every save sends config:changed) changes nothing: what the
      // row said about it stays ("set to 99%"), and so does what the reader types. It cleared them
      // when the echo came back late (2026-11-16, nightly compact-context).
      if (was && was.enabled === s.enabled && was.percent === s.percent) return;
      show(s);
      setDraft(String(s.percent));
      // What it says is about the setting as it was: a change made elsewhere clears it.
      setError(null);
      setNote(null);
    });
  }, [read, show]);
  useEffect(() => { load(); }, [load]);
  useEvent('config:changed', useCallback((data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (!key || key === 'session') load(true);
  }, [load]));

  // A save merges into the config as it stands now: a save keeps a key it does not mention.
  const save = async (patch: { enabled?: boolean; limit_percent?: number }) => {
    setBusy(true);
    setError(null);
    // Shown before it is sent: its config:changed can come back before the PUT answers.
    const before = shown.current;
    if (before) show({ enabled: patch.enabled ?? before.enabled, percent: patch.limit_percent ?? before.percent });
    try {
      const c = await fetchFreshConfig();
      await updateConfig({
        session: { ...(c.session ?? {}), idle_compaction: { ...(c.session?.idle_compaction ?? {}), ...patch } },
      } as Partial<Config>);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      // Not saved: the row shows the setting in force now (another place may have changed it
      // meanwhile), then says why.
      const now = (await read(true)) ?? before;
      show(now);
      if (now) setDraft(String(now.percent));
      setNote(null);
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
    // Not a number: said so, and the box shows the share in force again (what it shows is what runs).
    if (!Number.isFinite(n)) {
      setError(`Use a share from ${min}% to ${max}%; it stays at ${setting.percent}%.`);
      setDraft(String(setting.percent));
      return;
    }
    // Out of range: kept to the nearest end, as Settings keeps it, and said so.
    const percent = Math.min(max, Math.max(min, Math.round(n)));
    setNote(percent !== Math.round(n) ? `Shares run from ${min}% to ${max}%: set to ${percent}%.` : null);
    setDraft(String(percent));
    if (percent !== setting.percent) void save({ limit_percent: percent });
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); commitPercent(); }
    if (e.key === 'Escape' && setting) { setDraft(String(setting.percent)); setError(null); }
  };

  const problem = error ?? readError;
  if (!setting) return problem ? <div className="idle-compact-error">{problem}</div> : null;
  return (
    <div className="idle-compact-setting" data-testid="idle-compact-setting">
      <div className="idle-compact-setting-row">
        <ToggleSwitch id="idle-compact-inline" checked={setting.enabled} busy={busy} onChange={(v: boolean) => void save({ enabled: v })} />
        <label htmlFor="idle-compact-inline">Compact idle sessions</label>
        <span className="idle-compact-setting-at">at</span>
        <span className="idle-compact-percent-group">
        <input
          className="idle-compact-percent is-sm"
          data-testid="idle-compact-percent"
          data-no-draft="number"
          aria-label="Share of the auto-compaction limit"
          aria-invalid={error ? true : undefined}
          inputMode="numeric"
          value={draft}
          disabled={!setting.enabled}
          onChange={(e) => { setDraft(e.target.value); setError(null); setNote(null); }}
          onBlur={commitPercent}
          onKeyDown={onKey}
        />
        <span className="idle-compact-setting-unit">% of the limit</span>
        </span>
        {saved && <span className="idle-compact-saved" role="status">Saved</span>}
      </div>
      <div className="idle-compact-setting-help">
        For every session with a one-hour cache; the default is {DEFAULT_IDLE_COMPACT_LIMIT_PERCENT}%. The limit is where
        Claude Code would compact by itself; Walnut compacts before that, and not at all when the limit is unknown.{' '}
        <Link to="/settings#sessions">All session settings</Link>
      </div>
      {problem && <div className="idle-compact-error" role="alert">{problem}</div>}
      {note && !problem && <div className="idle-compact-setting-help" role="status">{note}</div>}
    </div>
  );
}

/** The idle compaction's line in a session's timeline: a click opens it to its reason and its setting. */
export function IdleCompactLine({ message, time, noticeId, inOpenedRun }: {
  message: string; time?: string; noticeId?: string;
  /** Drawn inside a run the reader just opened by a click: that click was for this row, so it shows why at once. */
  inOpenedRun?: boolean;
}) {
  const sessionId = useContext(RowDisclosureScope);
  // Closed until the reader opens it, like every Walnut notice row (2026-11-09, the user: "why ths
  // automaticlaly open after compact, no, auto hide"; tests/web/notice-rows-start-closed.test.ts).
  const [open, setOpen] = useRowDisclosure(noticeId ? `notice-${noticeId}` : disclosureIds.content('sys-idle-compact', message), !!inOpenedRun);
  // The live note already says why; a history row is the bare command line, its reason is on the record.
  const saysWhy = message.startsWith('Compacting this idle session');
  const reason = useIdleCompactReason(open && !saysWhy ? sessionId : null, noticeId);
  return (
    <div className="idle-compact-line" data-testid="idle-compact-line">
      <button
        type="button"
        data-choice-exempt="transcript system line: the whole row is the button, drawn like every notice row"
        className="session-system-line session-system-line--info idle-compact-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="session-system-text">{message}</span>
        {time && <span className="session-system-detail session-system-time">{time}</span>}
        <DisclosureChevron open={open} className="tool-run-chevron" />
      </button>
      {open && (
        <div className="idle-compact-body">
          {!saysWhy && (
            <div className="idle-compact-why" data-testid="idle-compact-why">
              {reason === undefined
                ? 'Reading why it ran…'
                : reason
                  ? <>Why: {idleCompactReasonText(reason)}.</>
                  : 'Why: not recorded for this compaction.'}
            </div>
          )}
          <IdleCompactSetting />
        </div>
      )}
    </div>
  );
}
