/**
 * SuggestAccuracyPanel — how good the draft column's auto-suggestions actually are.
 *
 * The background parse fills a draft's launch pills (project, folder, pin tier,
 * priority, dates) while you type, which is the one part of a launch nobody sees
 * happen. This panel is the receipt: per field, how often the launch kept the
 * suggestion, replaced it, or cleared it — plus the newest raw diffs, because a
 * percentage tells you there IS a problem and only the values tell you what it is.
 *
 * Read-only, and fetched only once the card actually SCROLLS INTO VIEW. The
 * Settings page renders every section at once (one long anchored page), so a
 * fetch-on-mount here would cost a request on every settings visit for a
 * diagnostic panel most visits never scroll to. No polling either: the ledger only
 * changes when a draft commits, which cannot happen while this is on screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchSuggestAccuracy,
  type SuggestAccuracySummary,
  type SuggestField,
  type SuggestFieldStats,
} from '@/api/tasks';

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
  return stats.accuracy === null ? '—' : `${Math.round(stats.accuracy * 100)}%`;
}

/** Local day + time, no seconds — enough to place a diff in the session. */
function when(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * `standalone`: the panel is the whole card (Settings → Diagnostics → Suggestion
 * Accuracy), so the SectionCard already carries the title and description and the
 * inner heading would repeat them.
 */
export const SUGGEST_ACCURACY_BLURB =
  'A new session\u2019s draft guesses its project, folder and pin tier from what you type. ' +
  'This compares every guess against what the launch actually carried. Only the field names ' +
  'and values are recorded \u2014 never the text you typed.';

export function SuggestAccuracyPanel({ standalone = false }: { standalone?: boolean } = {}) {
  const [summary, setSummary] = useState<SuggestAccuracySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  return (
    <div className="form-group" ref={rootRef}>
      {!standalone && (
        <>
          <label style={{ fontWeight: 600 }}>Suggestion Accuracy</label>
          <p className="text-sm text-muted" style={{ margin: '2px 0 8px' }}>
            {SUGGEST_ACCURACY_BLURB}
          </p>
        </>
      )}

      {/* Only while a read is actually in flight. Before that (never scrolled here)
          the panel shows just its description: "Reading the ledger…" while nothing
          is being read is a lie, and "nothing recorded" before the read is a
          different lie. */}
      {loading && !summary && <p className="text-sm text-muted">Reading the ledger&hellip;</p>}
      {error && <p className="text-sm" style={{ color: 'var(--error)' }}>Couldn&rsquo;t read it: {error}</p>}

      {summary && !error && rows.length === 0 && (
        <p className="text-sm text-muted">
          Nothing recorded yet. Start a session from a draft with something typed in it and the
          first guesses land here.
        </p>
      )}

      {summary && !error && rows.length > 0 && (
        <>
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
          <p className="text-sm text-muted" style={{ marginTop: 4 }}>
            {summary.commits} launch{summary.commits === 1 ? '' : 'es'} carried a suggestion
            {summary.since ? `, since ${when(summary.since)}` : ''}.
          </p>

          {/* The raw diffs. A percentage says there is a problem; only these say what
              it is (e.g. every project guess landing one project off). */}
          <div className="suggest-accuracy-recent">
            {summary.recent.map((rec, i) => (
              <div key={`${rec.at}-${i}`} className="suggest-accuracy-record">
                <span className="suggest-accuracy-when">{when(rec.at)}</span>
                {rec.entries.map((e, j) => (
                  <span key={`${e.field}-${j}`} className={`suggest-accuracy-entry verdict-${e.verdict}`}>
                    <span className="suggest-accuracy-field">
                      {FIELD_LABELS.find((f) => f.field === e.field)?.label ?? e.field}
                    </span>
                    <span className="suggest-accuracy-values">
                      {e.verdict === 'kept'
                        ? e.suggested
                        : `${e.suggested} → ${e.chosen ?? '(none)'}`}
                    </span>
                    <span className="suggest-accuracy-verdict">{VERDICT_LABELS[e.verdict] ?? e.verdict}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {/* `width: fit-content`: .btn is a block inside a form-group, so without it the
          Refresh button stretched the full card width and read like a primary action. */}
      <button
        type="button"
        className="btn btn-sm"
        style={{ marginTop: 8, width: 'fit-content' }}
        disabled={loading}
        onClick={() => void load()}
      >
        Refresh
      </button>
    </div>
  );
}
