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
import { fetchEngineCompare, type EngineCompare, type EngineCompareRow } from '@/api/usage';
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

interface Metric {
  id: string;
  label: string;
  help?: string;
  value: (r: EngineCompareRow) => number | null;
  show: (n: number | null, r: EngineCompareRow) => string;
  /** Lower is better (time, cost, rework); absent = not ranked. */
  lower?: boolean;
  /** A cost: how many of a column's tasks hold requests with no price (its value is a floor and is not ranked). */
  partial?: (r: EngineCompareRow) => number;
}

const ownPartial = (r: EngineCompareRow) => r.partialCost;
const reviewPartial = (r: EngineCompareRow) => r.reviewPartialCost ?? 0;
const partialNote = (n: number) => `${n} task${n === 1 ? '' : 's'} used a model with no price: the cost leaves those requests out`;

const METRICS: Metric[] = [
  { id: 'done', label: 'Tasks finished', help: 'Completed in the period, counted under the engine and model that carried most of their cost.', value: (r) => r.done, show: (n) => String(n ?? 0) },
  { id: 'open', label: 'Still open', value: (r) => r.open, show: (n) => String(n ?? 0) },
  { id: 'split', label: 'Assigned by the split', help: 'Of its tasks, how many the engine split gave it (the rest named their engine or came before the split).', value: (r) => r.split, show: (n) => String(n ?? 0) },
  { id: 'time', label: 'Median time to done', help: 'From its first session starting to its first completion.', value: (r) => r.medianHours, show: hours, lower: true },
  { id: 'cost', label: 'Median cost per task', value: (r) => r.medianCostUsd, show: (n) => (n === null ? '-' : money(n)), lower: true, partial: ownPartial },
  { id: 'total', label: 'Total cost', help: 'Every task counted here, open ones included; reviewer tasks are not in it.', value: (r) => r.costUsd, show: (n) => money(n ?? 0), partial: ownPartial },
  { id: 'tokens', label: 'Median tokens per task', value: (r) => r.medianTokens, show: (n) => (n === null ? '-' : formatTokens(n)), lower: true },
  { id: 'reviews', label: 'Review tasks per task', help: 'Reviewer subtasks (a title starting with "Review" or naming a reviewer): more means more rounds before it passed.', value: (r) => r.reviewsPerTask, show: ratio, lower: true },
  { id: 'reviewcost', label: 'Review cost per task', help: 'What its reviewer subtasks cost, on top of the task itself.', value: (r) => r.reviewCostPerTask, show: (n) => (n === null ? '-' : money(n)), lower: true, partial: reviewPartial },
  { id: 'followups', label: 'Your messages per task', help: 'What you typed into the task: corrections and follow-ups.', value: (r) => r.followUpsPerTask, show: ratio, lower: true },
  { id: 'reopens', label: 'Reopened after done', help: 'Share of its finished tasks that were reopened.', value: (r) => r.reopenedShare, show: share, lower: true },
  { id: 'errored', label: 'Had a session error', help: 'Share of its tasks whose session hit an error.', value: (r) => r.erroredShare, show: share, lower: true },
];

/** The column holding a row's best value, when there is a contest: two engines with enough finished work. */
function bestOf(rows: EngineCompareRow[], m: Metric): string | null {
  if (!m.lower) return null;
  const judged = rows.filter((r) => r.done >= FEW && m.value(r) !== null && !(m.partial && m.partial(r) > 0));
  if (judged.length < 2) return null;
  const sorted = [...judged].sort((a, b) => (m.value(a) as number) - (m.value(b) as number));
  return (m.value(sorted[0]) as number) < (m.value(sorted[1]) as number) ? sorted[0].key : null;
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
  // Auto: the split's own tasks once it assigned enough of them to compare, else every task.
  const [splitHas, setSplitHas] = useState<number | null>(null);
  const splitOnly = which === 'split' || (which === 'auto' && (splitHas ?? 0) >= 2 * FEW);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchEngineCompare(range, project === ALL_PROJECTS ? undefined : project, splitOnly)
      .then((d) => {
        if (!live) return;
        setData(d); setError('');
        if (!d.splitOnly) setSplitHas(d.rows.reduce((n, r) => n + r.split, 0));
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.start, range.end, project, splitOnly, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => new Map(METRICS.map((m) => [m.id, data && ready ? bestOf(data.rows, m) : null])), [data, ready]);
  const label = (key: string) => data?.rows.find((r) => r.key === key)?.label ?? key;

  const split = data?.split;
  const splitLine = !split ? null : split.on
    ? `New tasks are shared: ${split.entries.map((e) => `${e.label} ${e.weight}`).join(' : ')}. A task that names its own engine keeps it.`
    : 'New tasks all run on the default engine. Turn on "Share new tasks" in Settings, Sessions to spread them.';

  return (
    <SettingsGroup className="usage-ec" heading="Engines compared" data-testid="usage-engines">
      <div className="settings-row settings-row-stacked usage-ec-body" data-wide="true" aria-busy={loading || undefined}>
        <div className="usage-ec-toolbar">
          <p className="usage-ec-split" data-testid="usage-engines-split" data-on={split?.on || undefined}>
            {splitLine}{split && !split.on && <> <a href="#sessions">Open Sessions</a></>}
          </p>
          {split?.on && (
            <span className="usage-ec-which">
              <SegmentedControl<'all' | 'split'> aria-label="Which tasks" value={splitOnly ? 'split' : 'all'} onChange={(v) => setWhich(v)}
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
                  {METRICS.map((m) => (
                    <tr key={m.id} data-metric={m.id}>
                      <td title={m.help}>{m.label}</td>
                      {data.rows.map((r) => (
                        <td key={r.key} className="num" data-best={best.get(m.id) === r.key || undefined}
                          data-partial={(m.partial && m.partial(r) > 0) || undefined} title={m.partial && m.partial(r) > 0 ? partialNote(m.partial(r)) : undefined}>
                          {m.show(m.value(r), r)}{m.partial && m.partial(r) > 0 && m.value(r) !== null && <span className="usage-ec-partial">+?</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="usage-bd-foot">
              {`A task counts under the engine and model that carried most of its cost. Finished tasks count by the day they finished, open ones by the day they started. Main, leads, asks and routine runs are left out. The best value of a row is in bold, among engines with ${FEW} or more finished tasks; "+?" marks a cost that leaves out requests to a model with no price.`}
            </p>
            {!data.splitOnly && split?.on && (
              <p className="usage-bd-foot" data-testid="usage-engines-bias">Counting every task: a lead may have picked an engine by hand for some of them, so this is not a fair test. "Assigned by the split" is.</p>
            )}
            <details className="usage-more" data-testid="usage-engines-defs">
              <summary>What each row means</summary>
              <dl className="usage-ec-defs">
                {METRICS.filter((m) => m.help).map((m) => <div key={m.id}><dt>{m.label}</dt><dd>{m.help}</dd></div>)}
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
                        <span className="usage-ec-sub">{[label(t.key), t.project || 'Inbox', t.done ? hours(t.hours) : 'open', t.split ? 'split' : '',
                          t.reviews ? `${t.reviews} review${t.reviews === 1 ? '' : 's'}${t.reviewCostUsd ? ` (${money(t.reviewCostUsd)})` : ''}` : '', t.followUps ? `${t.followUps} of your messages` : '',
                          t.reopens ? `reopened ${t.reopens}x` : '', t.errored ? 'error' : ''].filter(Boolean).join(' · ')}</span></td>
                      <td className="num usage-line-cost" title={t.partialCost || t.reviewPartialCost ? 'Some requests (its own or a reviewer\'s) used a model with no price: left out of this cost' : undefined}>
                        {money(t.costUsd)}{(t.partialCost || t.reviewPartialCost) && <span className="usage-ec-partial">+?</span>}
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
