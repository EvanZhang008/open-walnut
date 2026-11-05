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

function hours(h: number | null): string {
  if (h === null) return '-';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

const ratio = (n: number | null) => (n === null ? '-' : n.toFixed(n < 10 ? 1 : 0));

interface Metric {
  id: string;
  label: string;
  help?: string;
  value: (r: EngineCompareRow) => number | null;
  show: (n: number | null, r: EngineCompareRow) => string;
  /** Lower is better (time, cost, rework); absent = not ranked. */
  lower?: boolean;
}

const METRICS: Metric[] = [
  { id: 'done', label: 'Tasks finished', value: (r) => r.done, show: (n) => String(n ?? 0) },
  { id: 'open', label: 'Still open', value: (r) => r.open, show: (n) => String(n ?? 0) },
  { id: 'split', label: 'Assigned by the split', value: (r) => r.split, show: (n) => String(n ?? 0) },
  { id: 'time', label: 'Median time to done', help: 'From its session starting to the task completed.', value: (r) => r.medianHours, show: hours, lower: true },
  { id: 'cost', label: 'Median cost per task', value: (r) => r.medianCostUsd, show: (n) => (n === null ? '-' : money(n)), lower: true },
  { id: 'total', label: 'Total cost', help: 'Every task counted here, open ones included; reviewer tasks are not in it.', value: (r) => r.costUsd, show: (n) => money(n ?? 0) },
  { id: 'tokens', label: 'Median tokens per task', value: (r) => r.medianTokens, show: (n) => (n === null ? '-' : formatTokens(n)), lower: true },
  { id: 'reviews', label: 'Review tasks per task', help: 'Subtasks with "review" in the title: more means more rounds before it passed.', value: (r) => r.reviewsPerTask, show: ratio, lower: true },
  { id: 'followups', label: 'Your messages per task', help: 'What you typed into the task: corrections and follow-ups.', value: (r) => r.followUpsPerTask, show: ratio, lower: true },
  { id: 'reopens', label: 'Reopened after done', value: (r) => r.reopens, show: (n) => String(n ?? 0), lower: true },
  { id: 'errored', label: 'Had a session error', value: (r) => r.errored, show: (n) => String(n ?? 0), lower: true },
];

/** The column holding a row's best value, when there is a contest (two engines with finished work). */
function bestOf(rows: EngineCompareRow[], m: Metric): string | null {
  if (!m.lower) return null;
  const judged = rows.filter((r) => r.done > 0 && m.value(r) !== null);
  if (judged.length < 2) return null;
  const sorted = [...judged].sort((a, b) => (m.value(a) as number) - (m.value(b) as number));
  return (m.value(sorted[0]) as number) < (m.value(sorted[1]) as number) ? sorted[0].key : null;
}

export function EngineCompareCard({ range }: { range: { start?: string; end?: string } }) {
  const navigate = useNavigate();
  const [project, setProject] = usePageView<string>('usage', 'engines-project', ALL_PROJECTS, isProject);
  const [data, setData] = useState<EngineCompare | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchEngineCompare(range, project === ALL_PROJECTS ? undefined : project)
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.start, range.end, project]); // eslint-disable-line react-hooks/exhaustive-deps
  const best = useMemo(() => new Map(METRICS.map((m) => [m.id, data ? bestOf(data.rows, m) : null])), [data]);
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
          {data && data.projects.length > 1 && (
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
                        <td key={r.key} className="num" data-best={best.get(m.id) === r.key || undefined}>{m.show(m.value(r), r)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="usage-bd-foot">
              {'A task counts under the engine and model that carried most of its cost. Finished tasks count by the day they finished, open ones by the day they started. Main, leads, asks and routine runs are left out. The best value of a row is in bold.'}
            </p>
            <details className="usage-more" data-testid="usage-engines-tasks">
              <summary>{`The ${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'} behind these numbers`}</summary>
              <table className="usage-bd-table usage-ec-tasks">
                <tbody>
                  {data.tasks.map((t) => (
                    <tr key={t.taskId} className="usage-line" onClick={() => openTaskOnHome(t.taskId, navigate)} data-task={t.taskId}>
                      <td><span className="usage-bd-name"><span title={t.title}>{t.title}</span></span>
                        <span className="usage-ec-sub">{[label(t.key), t.project || 'Inbox', t.done ? hours(t.hours) : 'open', t.split ? 'split' : '',
                          t.reviews ? `${t.reviews} review${t.reviews === 1 ? '' : 's'}` : '', t.followUps ? `${t.followUps} of your messages` : '',
                          t.reopens ? `reopened ${t.reopens}x` : '', t.errored ? 'error' : ''].filter(Boolean).join(' · ')}</span></td>
                      <td className="num usage-line-cost">{money(t.costUsd)}</td>
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
