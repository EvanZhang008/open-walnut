/**
 * SuggestAccuracyPanel: how good the draft column's auto-suggestions actually are.
 *
 * The background parse fills a draft's launch pills (project and folder) while
 * you type, which is the one part of a launch nobody sees happen. This panel is
 * the receipt: per field, how often the launch kept the suggestion, replaced it,
 * or cleared it, plus the newest raw diffs, because a percentage tells you there
 * IS a problem and only the values tell you what it is.
 *
 * FIELD_LABELS still names pin tier, priority and the dates: records written
 * before 2026-09-15 carry them (the draft column drew those controls then). New
 * records only ever hold project/folder (see draft-column.ts suggestDiff).
 *
 * Read-only, and fetched only once the card actually SCROLLS INTO VIEW (in pane
 * mode the pane mounts only when opened, so this fires on open; the observer is
 * kept for hosts that still render it inside a long page). No polling either: the ledger only
 * changes when a draft commits, which cannot happen while this is on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSuggestAccuracy,
  type SuggestAccuracySummary,
  type SuggestField,
  type SuggestFieldStats,
} from '@/api/tasks';
import { SettingsGroup, SettingsRow, SettingsNotice, SettingsLoadingRow } from '../SettingsSection';
import { SettingsButton } from '../inputs/SettingsButton';
import { SectionCard } from '../inputs/SectionCard';
import '@/styles/settings-sections-addons.css';
import { usageTime } from './UsageTables';

/** Recent guesses per page. */
export const RECENT_PAGE = 10;

/** Row order + human labels. Fields with no evidence are hidden, so this is an
 *  ordering, not a promise that every row renders. */
const FIELD_LABELS: Array<{ field: SuggestField; label: string }> = [
  { field: 'project', label: 'Project' },
  { field: 'pinTier', label: 'Pin tier' },
  { field: 'priority', label: 'Priority' },
  { field: 'cwd', label: 'Folder' },
  { field: 'dueDate', label: 'Due date' },
  { field: 'startDate', label: 'Start date' },
  { field: 'endDate', label: 'End date' },
];

const VERDICT_LABELS: Record<string, string> = {
  kept: 'kept',
  changed: 'changed',
  dropped: 'cleared',
};

function pct(stats: SuggestFieldStats): string {
  return stats.accuracy === null ? 'n/a' : `${Math.round(stats.accuracy * 100)}%`;
}

/** Local day + time, no seconds — enough to place a diff in the session. */
function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  // One date and time format across settings and engines: "Aug 23, 3:31 PM" (F32).
  return usageTime(new Date(t).toISOString());
}

/**
 * `standalone`: the panel is the whole card (Settings, Diagnostics, Suggestion
 * Accuracy), so the SectionCard already carries the title and description and the
 * inner heading would repeat them.
 */
export const SUGGEST_ACCURACY_BLURB =
  "A new session's draft guesses its project and folder from what you type; this compares " +
  'every guess against what the launch actually carried.';

export function SuggestAccuracyPanel({ standalone = false }: { standalone?: boolean } = {}) {
  const [summary, setSummary] = useState<SuggestAccuracySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Recent guesses draw in pages: a long ledger must not make a 3000px pane (N08).
  const [recentShown, setRecentShown] = useState(RECENT_PAGE);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await fetchSuggestAccuracy(20));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once the user is LOOKING at the card, then stop observing.
  //
  // The observed element is the whole settings CARD, not this panel: the panel is
  // the last thing in a long card, so watching it meant the settings nav could
  // scroll the card into view with the panel still a screen below the
  // fold — it then sat there unfetched, and (worse) claimed to be reading. Watching
  // the card fires as soon as the section is on screen, while a settings visit that
  // never comes near it still costs no request.
  //
  // No IntersectionObserver (jsdom, ancient browser) degrades to fetching on mount,
  // which is the old behavior rather than an empty panel.
  const loadedRef = useRef(false);
  useEffect(() => {
    const once = () => {
      if (loadedRef.current) return;
      loadedRef.current = true;
      void load();
    };
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver !== 'function') { once(); return; }
    const watched = el.closest('.settings-section') ?? el;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { once(); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(watched);
    return () => io.disconnect();
  }, [load]);

  const rows = FIELD_LABELS
    .map((f) => ({ ...f, stats: summary?.fields?.[f.field] }))
    .filter((r): r is typeof r & { stats: SuggestFieldStats } => !!r.stats && r.stats.total > 0);

  const refresh = (
    <SettingsButton onClick={() => void load()} busy={loading} busyLabel="Refreshing...">
      Refresh
    </SettingsButton>
  );

  const body = (
    <div className="settings-addons-contents suggest-accuracy" ref={rootRef}>
      <SettingsGroup
        heading={standalone ? undefined : 'Suggestion accuracy'}
        footer={summary && !error && rows.length > 0
          ? `${summary.commits} launch${summary.commits === 1 ? '' : 'es'} carried a suggestion${summary.since ? `, since ${when(summary.since)}` : ''}.`
          : undefined}
      >
        <SettingsRow
          label="Recorded guesses"
          help={standalone ? 'Only field names and values are recorded, never the text you typed.' : SUGGEST_ACCURACY_BLURB}
          // Standalone, Refresh sits in the pane header like every diagnostics pane (N26).
          control={standalone ? undefined : refresh}
        />
        {/* Only while a read is actually in flight. Before that the panel shows
            just its row: "Reading..." while nothing is being read is a lie, and
            "nothing recorded" before the read is a different lie. */}
        {loading && !summary && <SettingsLoadingRow>Reading the recorded guesses...</SettingsLoadingRow>}
        {error && (
          <SettingsNotice kind="error" role="alert">{`Couldn't read it: ${error}`}</SettingsNotice>
        )}
        {summary && !error && rows.length === 0 && (
          <SettingsRow
            label="Nothing recorded yet."
            help="Start a session from a draft with something typed in it and the first guesses land here."
          />
        )}
        {summary && !error && rows.length > 0 && (
          <div className="settings-row settings-row-stacked" data-wide="true">
            <table className="suggest-accuracy-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Kept</th>
                  <th>Changed</th>
                  <th>Cleared</th>
                  <th>Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.field}>
                    <td>{r.label}</td>
                    <td>{r.stats.kept}</td>
                    <td>{r.stats.changed}</td>
                    <td>{r.stats.dropped}</td>
                    <td className="suggest-accuracy-pct">{pct(r.stats)}</td>
                  </tr>
                ))}
                <tr className="suggest-accuracy-total">
                  <td>All fields</td>
                  <td>{summary.overall.kept}</td>
                  <td>{summary.overall.changed}</td>
                  <td>{summary.overall.dropped}</td>
                  <td className="suggest-accuracy-pct">{pct(summary.overall)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </SettingsGroup>

      {/* The raw diffs. A percentage says there is a problem; only these say what
          it is (for example every project guess landing one project off). */}
      {summary && !error && summary.recent.length > 0 && (
        <SettingsGroup heading="Recent guesses" className="suggest-accuracy-recent">
          {summary.recent.slice(0, recentShown).map((rec, i) => (
            <SettingsRow
              key={`${rec.at}-${i}`}
              className="suggest-accuracy-record"
              label={<span className="suggest-accuracy-when">{when(rec.at)}</span>}
              help={
                <span className="settings-addons-inline">
                  {rec.entries.map((e, j) => (
                    <span key={`${e.field}-${j}`} className={`suggest-accuracy-entry verdict-${e.verdict}`}>
                      <span className="suggest-accuracy-field">
                        {FIELD_LABELS.find((f) => f.field === e.field)?.label ?? e.field}
                      </span>{' '}
                      <span className="suggest-accuracy-values settings-addons-mono"
                        title={e.verdict === 'kept' ? e.suggested : `${e.suggested} to ${e.chosen ?? '(none)'}`}>
                        {e.verdict === 'kept' ? e.suggested : `${e.suggested} to ${e.chosen ?? '(none)'}`}
                      </span>{' '}
                      <span className="suggest-accuracy-verdict">{VERDICT_LABELS[e.verdict] ?? e.verdict}</span>
                    </span>
                  ))}
                </span>
              }
            />
          ))}
          {summary.recent.length > recentShown && (
            <SettingsRow
              data-testid="suggest-accuracy-more"
              label={`${recentShown} of ${summary.recent.length} shown`}
              control={
                <SettingsButton onClick={() => setRecentShown((n) => n + RECENT_PAGE)}>Show more</SettingsButton>
              }
            />
          )}
        </SettingsGroup>
      )}
    </div>
  );
  if (!standalone) return body;
  return (
    <SectionCard id="suggest-accuracy" title="Suggestion Accuracy" description={SUGGEST_ACCURACY_BLURB} actions={refresh}>
      {body}
    </SectionCard>
  );
}
