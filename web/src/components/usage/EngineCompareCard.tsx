/**
 * Usage & Costs, "Engines compared": each coding engine and the company whose model it ran,
 * side by side on the work it finished in the period (GET /api/usage/engines,
 * core/usage/engine-compare.ts). Metrics are rows and engines are columns, so two to four
 * engines read in the pane's width; the best value of a row is marked when two or more
 * engines finished work. The engine split that assigns new tasks is named above the table.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsGroup, SettingsLoadingRow, SettingsEmpty, SettingsNotice } from '@/components/settings/SettingsSection';
import { SegmentedControl } from '@/components/settings/inputs/SegmentedControl';
import { fetchEngineCompare, type EngineCompare, type EngineCompareRow, type EngineCompareTask, type ReviewScore } from '@/api/usage';
import { usePageView } from '@/utils/view-memory';
import { openTaskOnHome } from '@/utils/open-session';
import { formatTokens } from '@/utils/format';

function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Fewer finished tasks than this and a column's medians say little. */
const FEW = 5;
const ALL_PROJECTS = '*';
const isProject = (v: unknown): v is string => typeof v === 'string';
/** Which tasks count: every one, or only those the split assigned (a fair test). `auto` picks the split's once it has enough. */
type Which = 'auto' | 'all' | 'split';
const isWhich = (v: unknown): v is Which => v === 'auto' || v === 'all' || v === 'split';

function hours(h: number | null): string {
  if (h === null) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

const ratio = (n: number | null) => (n === null ? '-' : n.toFixed(n < 10 ? 1 : 0));
const share = (n: number | null) => (n === null ? '-' : `${Math.round(n * 100)}%`);
const SCORE_DIMS = ['function', 'ux', 'ui'] as const;
/** "8 · 7.5 · 9" (function · UX · UI); "-" for none, and for a dimension no reviewer scored. */
const scoreText = (s: ReviewScore | null | undefined) => (s ? SCORE_DIMS.map((d) => (s[d] === undefined ? '-' : String(s[d]))).join(' · ') : '-');
/** "function 9 · UX 8 · UI 9.5", for one task's line. */
const scoreNamed = (s: ReviewScore) => SCORE_DIMS.filter((d) => s[d] !== undefined).map((d) => `${d === 'function' ? 'function' : d.toUpperCase()} ${s[d]}`).join(' · ');
/** "by Claude + GPT": which companies' reviewers a task's score comes from. */
const scoredByText = (families: string[] | undefined) => {
  if (!families?.length) return '';
  const unknown = families.filter((f) => f === 'unknown').length;
  const named = [...new Set(families.filter((f) => f !== 'unknown')), ...(unknown ? [unknown === 1 ? 'an unknown model' : `${unknown} unknown models`] : [])];
  return ` by ${named.join(' + ')}`;
};

interface Metric {
  id: string;
  label: string;
  help?: string;
  value: (r: EngineCompareRow) => number | null;
  show: (n: number | null, r: EngineCompareRow) => string;
  /** Lower is better (time, cost, rework); absent = not ranked. */
  lower?: boolean;
  /** Higher is better (a reviewer score). */
  higher?: boolean;
  /** A small second line under the value (what it rests on). */
  sub?: (r: EngineCompareRow) => string | null;
  /** How many of the tasks behind the value leave something out (it is a floor and is not ranked). */
  partial?: (r: EngineCompareRow) => number;
  /** The tooltip of such a value, given that count. */
  partialNote?: (n: number) => string;
  /** For a median: what it leaves out entirely (finished tasks with no usage recorded), as a tooltip. */
  excluded?: (r: EngineCompareRow) => string | undefined;
  /** Shown only when some column has it (a row that is all zeros says nothing). */
  onlyWhenAny?: boolean;
  /** How many tasks the value rests on (ranked only with FEW or more); default the finished tasks. */
  samples?: (r: EngineCompareRow) => number;
}

// The medians' own samples: a cost median of one known task among five finished is not five samples.
const knownDone = (r: EngineCompareRow) => r.done - (r.noUsageDone ?? 0);
const timedDone = (r: EngineCompareRow) => r.timedDone ?? r.done;

const leftOutOfMedian = (r: EngineCompareRow) => (r.noUsageDone ?? 0) > 0
  ? `${finishedWord(r.noUsageDone ?? 0)} with no usage recorded ${(r.noUsageDone ?? 0) === 1 ? 'is' : 'are'} left out of this median` : undefined;

const noUsage = (r: EngineCompareRow) => r.noUsage ?? 0;
/** None of a column's tasks has usage recorded: its cost is unknown, not $0. */
const allUnknown = (r: EngineCompareRow) => r.done + r.open > 0 && noUsage(r) >= r.done + r.open;
const tasksWord = (n: number) => `${n} task${n === 1 ? '' : 's'}`;
const finishedWord = (n: number) => `${n} finished task${n === 1 ? '' : 's'}`;
const LEFT_OUT = 'requests to a model with no price, or usage that was not recorded';
// The medians and the per-task review cost are of finished tasks; the total is of every task (an older server sends only the totals).
const totalPartial = (r: EngineCompareRow) => r.partialCost;
const medianCostPartial = (r: EngineCompareRow) => r.partialCostDone ?? r.partialCost;
const medianTokensPartial = (r: EngineCompareRow) => r.partialTokensDone ?? r.partialTokens ?? noUsage(r);
const reviewPartial = (r: EngineCompareRow) => r.reviewPartialCost ?? 0;
/** The tooltip of one task's cost: why it is unknown or a floor. */
function taskCostNote(t: EngineCompareTask): string | undefined {
  if (t.noUsage) return 'No usage of this task was recorded (an engine Walnut does not read usage from)';
  if (t.partialCost || t.reviewPartialCost) return 'Some requests (its own or a reviewer\'s) used a model with no price: left out of this cost';
  return undefined;
}

const METRICS: Metric[] = [
  { id: 'done', label: 'Tasks finished', help: 'Completed in the period, counted under the engine and model that carried most of their cost (only the split\'s tasks: the engine it assigned).', value: (r) => r.done, show: (n) => String(n ?? 0) },
  { id: 'open', label: 'Still open', value: (r) => r.open, show: (n) => String(n ?? 0) },
  { id: 'notstarted', label: 'Never started', help: 'Closed after a start that failed before its first turn ran: counted as an error, not as finished work.', value: (r) => r.notStarted ?? 0, show: (n) => String(n ?? 0), onlyWhenAny: true },
  { id: 'split', label: 'Assigned by the split', help: 'Of its tasks, how many the engine split gave it (the rest named their engine or came before the split).', value: (r) => r.split, show: (n) => String(n ?? 0) },
  { id: 'time', label: 'Median time to done', help: 'From its first session starting to its first completion.', value: (r) => r.medianHours, show: hours, lower: true, samples: timedDone },
  { id: 'cost', label: 'Median cost per task', value: (r) => r.medianCostUsd, show: (n) => (n === null ? '-' : money(n)), lower: true, partial: medianCostPartial,
    partialNote: (n) => `${finishedWord(n)} leave out ${LEFT_OUT}: the median is a floor`, excluded: leftOutOfMedian, samples: knownDone },
  { id: 'total', label: 'Total cost', help: 'Every task counted here, open ones included; reviewer tasks are not in it.', value: (r) => (allUnknown(r) ? null : r.costUsd), show: (n) => (n === null ? '-' : money(n)), partial: totalPartial,
    partialNote: (n) => `${tasksWord(n)} leave out ${LEFT_OUT}: the total is a floor` },
  { id: 'tokens', label: 'Median tokens per task', value: (r) => r.medianTokens, show: (n) => (n === null ? '-' : formatTokens(n)), lower: true, partial: medianTokensPartial,
    partialNote: (n) => `${finishedWord(n)} had requests with no token counts recorded: the median leaves those out`, excluded: leftOutOfMedian, samples: knownDone },
  { id: 'reviews', label: 'Review tasks per task', help: 'Reviewer subtasks (a subtask whose title starts with "Review", "Reviewer", "Verifier", "Verify:" or "Verification:", maybe after a word like Code, UI or Final). A count, never a contest: more rounds can mean more fixes, and it can mean more care.', value: (r) => r.reviewsPerTask, show: ratio },
  { id: 'reviewcost', label: 'Review cost per task', help: 'What its reviewer subtasks cost, on top of the task itself. Not ranked: a cheaper review is often just a review that was not done.',
    // Every finished task's reviewers unknown: no per-task cost, as Total cost reads with none known.
    // No reviews: nothing to show, as a cost with no usage recorded reads.
    // Of the finished tasks that had reviewers (an older server sends no count: all finished).
    value: (r) => (r.reviewsPerTask === 0 || (r.reviewCostPerTask === 0 && (r.reviewedDone ?? r.done) > 0 && reviewPartial(r) >= (r.reviewedDone ?? r.done)) ? null : r.reviewCostPerTask),
    show: (n) => (n === null ? '-' : money(n)), partial: reviewPartial,
    partialNote: (n) => `${finishedWord(n)} had reviewers whose cost leaves out ${LEFT_OUT}` },
  { id: 'crossreview', label: 'Checked by another company', help: 'Of the tasks it finished whose reviewers\' model is known, the share that a reviewer on another company\'s model checked and gave a verdict on (Claude work reviewed by a GPT model, or the other way round). "-" when no reviewer\'s model is known.',
    // No reviews, or none of a known company: nothing to show, never a 0%.
    value: (r) => (r.reviewsPerTask === 0 ? null : r.crossReviewedShare ?? null), show: share,
    sub: (r) => (r.crossReviewedShare != null && r.crossKnownDone !== undefined && r.crossKnownDone < r.done ? `of ${r.crossKnownDone} with a known reviewer` : null) },
  { id: 'score', label: 'Reviewer score (function · UX · UI)', help: 'Function · UX · UI, out of 10. Per finished task, its reviewers\' latest verdict (each company\'s latest, the lower of them on each), then the median. Ranked by the lowest of the three. Reviewers give it as `score` on their reply.',
    // Ranked only on all three: a missing UI score is unknown, never a 10.
    value: (r) => (r.reviewScore && SCORE_DIMS.every((d) => r.reviewScore![d] !== undefined) ? Math.min(...SCORE_DIMS.map((d) => r.reviewScore![d]!)) : null),
    show: (_n, r) => scoreText(r.reviewScore), higher: true, samples: (r) => r.scoredDone ?? 0,
    sub: (r) => (r.reviewScore ? `${r.scoredDone ?? 0} of ${r.done} scored` : null) },
  { id: 'followups', label: 'Your messages per task', help: 'What you typed into the task: corrections and follow-ups.', value: (r) => r.followUpsPerTask, show: ratio, lower: true },
  { id: 'reopens', label: 'Reopened after done', help: 'Share of the tasks it finished that were reopened, those being worked on again included.', value: (r) => r.reopenedShare, show: share, lower: true },
  { id: 'errored', label: 'Had a session error', help: 'Share of its tasks whose session hit an error.', value: (r) => r.erroredShare, show: share, lower: true },
  { id: 'switched', label: 'Moved to another engine', help: 'The split assigned it one engine, but most of its cost ran on another (a switch or a rescue). Counted in the column it was assigned, in either view. A Claude Code task whose subagents ran mostly on another company\'s model counts as moved as well.', value: (r) => r.switched ?? 0, show: (n) => String(n ?? 0), onlyWhenAny: true },
];

/** The rows the table shows: a row only some engines have is shown when one has it. */
const shownMetrics = (rows: EngineCompareRow[]) => METRICS.filter((m) => !m.onlyWhenAny || rows.some((r) => (m.value(r) ?? 0) > 0));

/** How the one-line verdict names the best of a row. */
const VERDICT: Record<string, string> = {
  time: 'Fastest', cost: 'Cheapest', tokens: 'Fewest tokens',
  followups: 'Fewest of your messages', score: 'Best reviewed', reopens: 'Reopened least', errored: 'Fewest errors',
};

/** One sentence on who is ahead where, from the rows' best marks; or why no one is yet. */
function verdictOf(rows: EngineCompareRow[], best: Map<string, string | null>, label: (key: string) => string): string | null {
  if (rows.length < 2) return null;
  const wins = METRICS.filter((m) => VERDICT[m.id] && best.get(m.id)).map((m) => `${VERDICT[m.id]}: ${label(best.get(m.id)!)}`);
  // Scores shown but not ranked yet: say so, rather than leave them out of the verdict without a word.
  const scored = rows.filter((r) => r.reviewScore);
  const scoreNote = !best.get('score') && scored.length && rows.some((r) => (r.scoredDone ?? 0) < FEW)
    ? ` Reviewer score: too few scored yet (${rows.map((r) => `${label(r.key)} ${r.scoredDone ?? 0}`).join(', ')}; ${FEW} each needed).` : '';
  if (wins.length) return `${wins.join('. ')}.${scoreNote}`;
  const short = rows.filter((r) => r.done < FEW).length;
  return (short ? `Too few finished tasks to call a winner yet: each engine needs ${FEW} finished tasks behind a value.` : 'No engine is clearly ahead on any row yet.') + scoreNote;
}

/** The column holding a row's best value, when there is a contest: two engines with enough finished work. */
function bestOf(rows: EngineCompareRow[], m: Metric): string | null {
  if (!m.lower && !m.higher) return null;
  const judged = rows.filter((r) => (m.samples ?? ((x: EngineCompareRow) => x.done))(r) >= FEW && m.value(r) !== null && !(m.partial && m.partial(r) > 0));
  if (judged.length < 2) return null;
  const sign = m.higher ? -1 : 1;
  const sorted = [...judged].sort((a, b) => sign * ((m.value(a) as number) - (m.value(b) as number)));
  // A best the eye can see: two values that read the same ("1 min" and "1 min") mark neither.
  const [a, b] = sorted;
  if (m.show(m.value(a), a) === m.show(m.value(b), b)) return null;
  return sign * (m.value(a) as number) < sign * (m.value(b) as number) ? a.key : null;
}

/**
 * `refreshKey`: read again when it changes (the page's Update now, a collection that finished).
 * `ready`: false while past usage is still being added up; nothing is ranked until it is.
 */
export function EngineCompareCard({ range, refreshKey = '', ready = true }: { range: { start?: string; end?: string }; refreshKey?: string; ready?: boolean }) {
  const navigate = useNavigate();
  const [project, setProject] = usePageView<string>('usage', 'engines-project', ALL_PROJECTS, isProject);
  const [which, setWhich] = usePageView<Which>('usage', 'engines-which', 'auto', isWhich);
  const [data, setData] = useState<EngineCompare | null>(null);
  // Auto: the server counts the split's own tasks once it is on and assigned enough of them, else every task.
  const splitOnly = !!data?.splitOnly;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchEngineCompare(range, project === ALL_PROJECTS ? undefined : project, which)
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.start, range.end, project, which, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => new Map(METRICS.map((m) => [m.id, data && ready ? bestOf(data.rows, m) : null])), [data, ready]);
  const label = (key: string) => data?.rows.find((r) => r.key === key)?.label ?? key;

  const split = data?.split;
  const sameWeights = !!split && split.entries.every((e) => e.weight === split.entries[0]?.weight);
  const names = split?.entries.map((e) => e.label) ?? [];
  const splitLine = !split ? null : split.on
    ? sameWeights
      ? `New tasks take turns between ${names.slice(0, -1).join(', ')} and ${names.at(-1)}. A task that names its own engine keeps it.`
      : `New tasks are shared ${split.entries.map((e) => `${e.label} ${e.weight}`).join(' : ')}. A task that names its own engine keeps it.`
    : 'New tasks all run on the default engine. Turn on "Share new tasks" in Settings, Sessions to spread them.';

  return (
    <SettingsGroup className="usage-ec" heading="Engines compared" data-testid="usage-engines">
      <div className="settings-row settings-row-stacked usage-ec-body" data-wide="true" aria-busy={loading || undefined}>
        <div className="usage-ec-toolbar">
          <p className="usage-ec-split" data-testid="usage-engines-split" data-on={split?.on || undefined}>
            {splitLine}{split && !split.on && <> <a href="#sessions">Open Sessions</a></>}
          </p>
          {/* Shown whenever the choice changes anything: a split since turned off still has its tasks to count. */}
          {(split?.on || splitOnly || (data?.splitTasks ?? 0) > 0) && (
            <span className="usage-ec-which">
              {/* Picking what 'auto' gives now keeps 'auto', so the card follows the split again once it has enough. */}
              <SegmentedControl<'all' | 'split'> aria-label="Which tasks" value={splitOnly ? 'split' : 'all'}
                onChange={(v) => setWhich(data?.auto !== undefined && (v === 'split') === data.auto ? 'auto' : v)}
                options={[{ value: 'all', label: 'All tasks', testId: 'usage-engines-all' }, { value: 'split', label: 'Assigned by the split', testId: 'usage-engines-split-only' }]} />
            </span>
          )}
          {/* Kept while a project is chosen, even when the period holds one project or none: it is the way back to all. */}
          {data && (data.projects.length > 1 || project !== ALL_PROJECTS) && (
            <label className="usage-ec-project">
              <span>Project</span>
              <select className="settings-select" value={project} onChange={(e) => setProject(e.target.value)} data-testid="usage-engines-project">
                <option value={ALL_PROJECTS}>All projects</option>
                {data.projects.map((p) => <option key={p.project} value={p.project}>{`${p.project || 'Inbox'} (${p.tasks})`}</option>)}
                {project !== ALL_PROJECTS && !data.projects.some((p) => p.project === project) && <option value={project}>{project || 'Inbox'}</option>}
              </select>
            </label>
          )}
        </div>
        {error && <SettingsNotice kind="error" role="alert">{`Couldn't compare engines: ${error}`}</SettingsNotice>}
        {!data ? (!error && <SettingsLoadingRow>Comparing engines...</SettingsLoadingRow>) : !data.rows.length ? (
          <SettingsEmpty>No task finished or started in this period.</SettingsEmpty>
        ) : (
          <>
            {(() => {
              const v = ready ? verdictOf(data.rows, best, label) : null;
              return v ? <p className="usage-ec-verdict" data-testid="usage-engines-verdict">{v}</p> : null;
            })()}
            <div className="usage-ec-scroll">
              <table className="usage-bd-table usage-ec-table" data-testid="usage-engines-table">
                <thead>
                  <tr>
                    <th />
                    {data.rows.map((r) => (
                      <th key={r.key} className="num" data-key={r.key} title={r.done < FEW ? `Only ${r.done} finished: too few to judge yet` : undefined}>
                        {r.label}{r.done < FEW && <span className="usage-ec-few">few</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shownMetrics(data.rows).map((m) => (
                    <tr key={m.id} data-metric={m.id}>
                      <td title={m.help}>{m.label}</td>
                      {data.rows.map((r) => (
                        <td key={r.key} className="num" data-best={best.get(m.id) === r.key || undefined}
                          data-partial={(m.partial && m.partial(r) > 0) || undefined} title={(m.partial && m.partial(r) > 0 ? m.partialNote?.(m.partial(r)) : undefined) ?? m.excluded?.(r)}>
                          <span className="usage-ec-val">{m.show(m.value(r), r)}</span>{m.partial && m.partial(r) > 0 && m.value(r) !== null && <span className="usage-ec-partial">+?</span>}
                          {m.sub?.(r) && <span className="usage-ec-cellsub">{m.sub(r)}</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="usage-bd-foot">
              {`${data.splitOnly ? 'Each task counts under the engine the split assigned it.' : 'Each task counts under the engine and model that carried most of its cost.'} The best value of a row is in bold. "-" means nothing to show yet (no usage recorded, no finished task or no reviews); "+?" marks a value that leaves some usage out.`}
            </p>
            {!data.splitOnly && split?.on && (
              <p className="usage-bd-foot" data-testid="usage-engines-bias">Counting every task: a lead may have picked an engine by hand for some of them, so this is not a fair test. "Assigned by the split" is.</p>
            )}
            <details className="usage-more" data-testid="usage-engines-defs">
              <summary>How these are counted</summary>
              <p className="usage-bd-foot">{`A task counts by the day it first finished (a reopened one too), or the day it started if it never finished. Main, leads, asks and routine runs are left out. A row's best is marked only among engines with ${FEW} or more tasks behind that value (finished, and with a known cost or time where the row needs one). Usage is read from each engine's own records, so a task's cost can show up some minutes after it ran; an engine Walnut reads no usage from shows "-".`}</p>
              <dl className="usage-ec-defs">
                {shownMetrics(data.rows).filter((m) => m.help).map((m) => <div key={m.id}><dt>{m.label}</dt><dd>{m.help}</dd></div>)}
              </dl>
            </details>
            <details className="usage-more" data-testid="usage-engines-tasks">
              <summary>{(data.taskCount ?? data.tasks.length) > data.tasks.length
                ? `The latest ${data.tasks.length} of the ${data.taskCount} tasks behind these numbers`
                : `The ${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} behind these numbers`}</summary>
              <table className="usage-bd-table usage-ec-tasks">
                <tbody>
                  {data.tasks.map((t) => (
                    <tr key={t.taskId} className="usage-line" data-task={t.taskId}>
                      <td><button type="button" className="usage-ec-open" title={t.title} onClick={() => openTaskOnHome(t.taskId, navigate)}>{t.title}</button>
                        <span className="usage-ec-sub">{[label(t.key), t.project || 'Inbox', t.done ? hours(t.hours) : t.notStarted ? 'never started' : 'open', t.split ? 'split' : '',
                          t.reviews ? `${t.reviews} review${t.reviews === 1 ? '' : 's'}${t.reviewCostUsd ? ` (${money(t.reviewCostUsd)})` : ''}` : '',
                          t.score ? `scored ${scoreNamed(t.score)}${scoredByText(t.scoredFamilies)}${t.scorePartial ? ' (partial, not in the median)' : ''}` : '', t.followUps ? `${t.followUps} of your messages` : '',
                          t.reopens ? `reopened ${t.reopens}x` : '', t.errored ? 'error' : ''].filter(Boolean).join(' · ')}</span></td>
                      <td className="num usage-line-cost" title={taskCostNote(t)}>
                        {t.noUsage ? 'unknown' : money(t.costUsd)}{!t.noUsage && (t.partialCost || t.reviewPartialCost) && <span className="usage-ec-partial">+?</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </div>
    </SettingsGroup>
  );
}
