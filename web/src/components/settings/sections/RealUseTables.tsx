/**
 * Settings > Real Use, its three tables (RealUseSection.tsx draws the rest): tools, requests from
 * the browser and the phone, and page errors. One table component for all three: a row opens (its
 * name is a button, Enter and Space too) to its alarm, every failure code, its sizes and a link to
 * Walnut Health; each table shows its first rows and a "Show all". Columns that do not fit a
 * narrow pane hide, and their numbers move into the opened row, so the list never scrolls sideways.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { UsageKind, UsageRange, UsageRow } from '@/api/usage-watch';
import { NoticeStatus } from '@/components/common/NoticeCard';
import { SearchField } from '@/components/common/SearchField';
import { DisclosureChevron } from '@/components/controls';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { sparkPaths } from './host-fleet-dashboard-model';
import { EmptyState } from '@/components/common/EmptyState';
import {
  ROWS_SHOWN, alarmLine, alarmStatus, failuresText, isToolSort, matchesFind, msText, pageKindParts, pctText, rangeWord,
  realErrors, rowKey, seriesTitle, sizeText, sizesText, slowText, slowIsHigh, sortRows, spilledText, stepWord, type ToolSort,
} from './real-use-model';

export const HEALTH_PATH = '/settings#walnut-health';

const SORT_OPTIONS: ReadonlyArray<{ value: ToolSort; label: string; testId: string }> = [
  { value: 'problems', label: 'Problems first', testId: 'real-use-sort-problems' },
  { value: 'calls', label: 'Calls', testId: 'real-use-sort-calls' },
  { value: 'name', label: 'Name', testId: 'real-use-sort-name' },
];

/** One column: its head, its cell, and classes (ru-num right-aligned, ru-wide hidden when narrow, a width). */
interface Col { head: ReactNode; title?: string; cls: string; cell: (r: UsageRow) => ReactNode }

function Num({ n, bad }: { n: number; bad?: boolean }) {
  return <span className={n === 0 ? 'ru-zero' : bad ? 'ru-bad' : undefined}>{n.toLocaleString('en-US')}</span>;
}

/** Uses (grey) and problems (red) on one scale, one point per day or per 4 hours; a page error has the grey line only, and no problems draws no red. */
function UsageSpark({ row }: { row: UsageRow }) {
  const uses = row.series.map((p) => p.uses);
  const bad = row.series.map((p) => p.bad);
  const max = Math.max(1, ...uses, ...bad);
  const h = 22;
  return (
    <svg className="ru-spark" viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="ru-spark-uses" d={sparkPaths(uses, max, h).line} vectorEffect="non-scaling-stroke" />
      {row.kind !== 'page' && bad.some((n) => n > 0) && <path className="ru-spark-bad" d={sparkPaths(bad, max, h).line} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function PageKind({ name }: { name: string }) {
  return <>{pageKindParts(name).map((p, i) => (p.mono ? <code key={i} className="ru-mono">{p.text}</code> : <span key={i}>{p.text}</span>))}</>;
}

function sparkCol(range: UsageRange): Col {
  return { head: rangeWord(range), cls: 'ru-w-spark ru-mid', cell: (r) => <span className="ru-spark-cell" title={seriesTitle(r, range)}><UsageSpark row={r} /></span> };
}

const STATE_COL: Col = {
  head: 'State', cls: 'ru-w-state',
  cell: (r) => { const s = alarmStatus(r.alarm); return <NoticeStatus tone={s.tone}>{s.text}</NoticeStatus>; },
};

function toolCols(range: UsageRange): Col[] {
  return [
    { head: 'Calls', cls: 'ru-num ru-w-num', cell: (r) => <Num n={r.calls} /> },
    {
      head: 'Errors', title: 'Server errors and timeouts', cls: 'ru-num ru-w-err',
      cell: (r) => <><Num n={realErrors(r)} />{realErrors(r) > 0 && <span className="ru-share"> ({pctText(realErrors(r), r.calls)})</span>}</>,
    },
    { head: 'Refused', title: 'Designed refusals: a guard said no; they never ring', cls: 'ru-num ru-w-refused ru-wide', cell: (r) => <Num n={r.refused} /> },
    { head: 'Bad args', title: 'Calls the tool refused for their arguments', cls: 'ru-num ru-w-small ru-wide', cell: (r) => <Num n={r.badArgs} /> },
    { head: 'Cut (confirmed)', cls: 'ru-num ru-w-cut ru-mid', cell: (r) => <Num n={r.cut} bad /> },
    { head: 'Over budget', cls: 'ru-num ru-w-over ru-wide', cell: (r) => <Num n={r.overLimit} /> },
    { head: 'Answer p95', title: 'The answer size 95% of calls stay under, in characters', cls: 'ru-num ru-w-size ru-mid', cell: (r) => sizeText(r.sizeP95) },
    { head: 'Largest (chars)', cls: 'ru-num ru-w-largest ru-wide', cell: (r) => sizeText(r.largest) },
    sparkCol(range),
    STATE_COL,
  ];
}

function requestCols(range: UsageRange): Col[] {
  return [
    { head: 'Requests', cls: 'ru-num ru-w-size', cell: (r) => <Num n={r.calls} /> },
    { head: 'Slow 5\u00a0s+', cls: 'ru-num ru-w-size', cell: (r) => <Num n={r.slow} bad={slowIsHigh(r)} /> },
    { head: 'Server errors', cls: 'ru-num ru-w-size ru-mid', cell: (r) => <Num n={r.serverErrors} /> },
    { head: 'Latency p95', cls: 'ru-num ru-w-size ru-mid', cell: (r) => msText(r.msP95) },
    sparkCol(range),
    STATE_COL,
  ];
}

function pageCols(range: UsageRange): Col[] {
  return [{ head: 'Times', cls: 'ru-num ru-w-num', cell: (r) => <Num n={r.calls} /> }, sparkCol(range), STATE_COL];
}

/**
 * The numbers of the columns a narrow pane hides, for the opened row: `wide` while the ru-wide
 * columns are hidden (under 860 px), `small` while the ru-mid ones are too (under 560 px).
 */
function hiddenNumbers(r: UsageRow): { wide: string | null; small: string | null } {
  const n = (v: number) => v.toLocaleString('en-US');
  if (r.kind === 'op') return { wide: `Refused ${n(r.refused)} · Bad args ${n(r.badArgs)} · Over budget ${n(r.overLimit)} · Largest ${sizeText(r.largest)} characters`, small: `Cut (confirmed) ${n(r.cut)}` };
  if (r.kind === 'http') return { wide: null, small: `Server errors ${n(r.serverErrors)} · Latency p95 ${msText(r.msP95)}` };
  return { wide: null, small: null };
}

function RowDetail({ row, now, range }: { row: UsageRow; now: number; range: UsageRange }) {
  const sizes = row.kind === 'op' ? sizesText(row) : null;
  const slow = row.kind === 'http' ? slowText(row) : null;
  const spilled = row.kind === 'op' ? spilledText(row.spilled) : null;
  const narrow = hiddenNumbers(row);
  return (
    <div className="health-detail ru-detail" data-testid="real-use-detail">
      <p>{row.kind === 'page' ? <PageKind name={row.name} /> : <code className="ru-mono">{row.name}</code>} · {alarmLine(row.alarm, now)}</p>
      {slow && <p>{slow}</p>}
      {row.kind === 'page'
        ? <p>{`Seen ${row.calls.toLocaleString('en-US')} time${row.calls === 1 ? '' : 's'} in the last ${rangeWord(range)}.`}</p>
        : <p>{failuresText(row.codes, row.kind === 'http' ? 'error answer' : 'failure')}</p>}
      {sizes && <p>{sizes}</p>}
      {spilled && <p>{spilled}</p>}
      {narrow.wide && <p className="ru-wide-only">{narrow.wide}</p>}
      {narrow.small && <p className="ru-mid-only">{narrow.small}</p>}
      {row.alarm && <p><Link className="settings-addons-link" to={HEALTH_PATH}>Open the alarm in Walnut Health</Link></p>}
    </div>
  );
}

const NOUN: Record<UsageKind, [string, string]> = { op: ['Tool', 'tools'], http: ['Request', 'requests'], page: ['Kind', 'kinds'] };

/** One table of rows already filtered and in order: first rows, Show all, one row opened at a time. */
function UsageTable({ kind, rows, cols, range, now, empty }: { kind: UsageKind; rows: UsageRow[]; cols: Col[]; range: UsageRange; now: number; empty: ReactNode }) {
  const [all, setAll] = usePageView<boolean>('settings', `real-use.all-${kind}`, false, isBoolean);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [head, noun] = NOUN[kind];
  const shown = all ? rows : rows.slice(0, ROWS_SHOWN);
  const span = cols.length + 1;
  return (
    <table className="ru-table" data-testid={`real-use-table-${kind}`}>
      <thead>
        <tr>
          <th className="ru-name">{head}</th>
          {cols.map((c, i) => <th key={i} className={c.cls} title={c.title}>{c.head}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <tr><td className="ru-state-cell" colSpan={span}>{empty}</td></tr>}
        {shown.map((r) => {
          const key = rowKey(r);
          const open = openKey === key;
          return (
            <UsageRowView key={key} row={r} cols={cols} open={open} span={span} range={range} now={now}
              onToggle={() => setOpenKey(open ? null : key)} />
          );
        })}
        {rows.length > ROWS_SHOWN && (
          <tr className="ru-more-row">
            <td colSpan={span}>
              <button type="button" className="btn btn-link" data-testid={`real-use-all-${kind}`} onClick={() => setAll(!all)}>
                {all ? `Show the first ${ROWS_SHOWN}` : `Show all ${rows.length.toLocaleString('en-US')} ${noun}`}
              </button>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function UsageRowView({ row, cols, open, span, range, now, onToggle }: { row: UsageRow; cols: Col[]; open: boolean; span: number; range: UsageRange; now: number; onToggle: () => void }) {
  const state = row.alarm?.state ?? 'none';
  return (
    <>
      {/* The row opens as Walnut Health's do: a click anywhere on it, or Enter or Space on it. */}
      <tr className={`health-row ru-row${open ? ' is-open' : ''}`} data-row={row.name} data-state={state} onClick={onToggle}
        role="button" tabIndex={0} aria-expanded={open}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <td className="ru-name">
          <span className="ru-open">
            <DisclosureChevron open={open} className="ru-chev" />
            {row.kind === 'page' ? <span className="ru-kind"><PageKind name={row.name} /></span> : <code className="ru-mono">{row.name}</code>}
          </span>
        </td>
        {cols.map((c, i) => <td key={i} className={c.cls}>{c.cell(row)}</td>)}
      </tr>
      {open && (
        <tr className="health-detail-row">
          <td colSpan={span}><RowDetail row={row} now={now} range={range} /></td>
        </tr>
      )}
    </>
  );
}

function FindBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SearchField small fieldClassName="ru-find"
      type="search" data-no-draft="search" className="settings-filter" data-testid="real-use-find"
      placeholder="Find a tool" aria-label="Find a tool" autoComplete="off" spellCheck={false}
      value={value} setText={onChange} onClear={() => onChange('')} clearLabel="Clear the search" />
  );
}

interface BlockProps { rows: UsageRow[]; range: UsageRange; now: number }

export function ToolsBlock({ rows, range, now }: BlockProps) {
  // A typed search is a passing thing and starts empty (utils/view-memory.ts).
  const [find, setFind] = useState('');
  const [sort, setSort] = usePageView<ToolSort>('settings', 'real-use.sort', 'problems', isToolSort);
  const ops = rows.filter((r) => r.kind === 'op');
  const shown = sortRows(ops.filter((r) => matchesFind(r.name, find)), sort);
  const empty = ops.length === 0
    ? <EmptyState size="row" title={`No tool calls in the last ${rangeWord(range)}`} />
    : <EmptyState size="row" title={`No tool matches “${find.trim()}”`} action={{ label: 'Clear search', onClick: () => setFind('') }} />;
  return (
    <section className="ru-block" data-testid="real-use-tools">
      <h4 className="ru-h">Tools</h4>
      <p className="ru-caption">Every call of a Walnut tool, through MCP or the walnut CLI · {rangeWord(range)}</p>
      <div className="ru-toolbar">
        <FindBox value={find} onChange={setFind} />
        <span className="ru-toolbar-label">Sort</span>
        <SegmentedControl<ToolSort> value={sort} options={SORT_OPTIONS} onChange={setSort} aria-label="Sort tools" />
      </div>
      <UsageTable kind="op" rows={shown} cols={toolCols(range)} range={range} now={now} empty={empty} />
      <p className="ru-legend">
        <b>Cut (confirmed)</b>: Claude Code said it saved the answer to a file, so the agent read only its start; one rings an alarm.{' '}
        <b>Over budget</b>: answers bigger than the asking client takes (25,000 characters through MCP, 10,240 bytes through the CLI).{' '}
        <b>Refused</b>: designed refusals (a guard said no); they never ring.{' '}
        <b>{rangeWord(range)}</b>: grey line uses {stepWord(range)}, red line problems {stepWord(range)}.{' '}
        <b>State</b>: its Walnut Health alarm. <b>Alarm</b> rang; <b>No alarm</b> checked and under its threshold; <b>No data</b> too little use to judge yet.{/* empty-state-ok: a legend */}
      </p>
    </section>
  );
}

export function RequestsBlock({ rows, range, now }: BlockProps) {
  const http = sortRows(rows.filter((r) => r.kind === 'http'), 'problems');
  return (
    <section className="ru-block" data-testid="real-use-requests">
      <h4 className="ru-h">Requests</h4>
      <p className="ru-caption">Requests from the browser and the phone (a tool's own calls are counted under Tools) · {rangeWord(range)}</p>
      <UsageTable kind="http" rows={http} cols={requestCols(range)} range={range} now={now} empty={<EmptyState size="row" title={`No requests in the last ${rangeWord(range)}`} />} />
      <p className="ru-legend">
        <b>Slow</b>: reads over 5 s, long polls and streams not counted; 10 in 60 minutes ring an alarm.{' '}
        <b>Server errors</b>: 5xx answers except 501; 5 in 60 minutes ring.{' '}
        <b>{rangeWord(range)}</b>: grey requests, red slow and server errors {stepWord(range)}.
      </p>
    </section>
  );
}

export function PageErrorsBlock({ rows, range, now }: BlockProps) {
  const pages = sortRows(rows.filter((r) => r.kind === 'page'), 'problems');
  return (
    <section className="ru-block" data-testid="real-use-pages">
      <h4 className="ru-h">Page errors</h4>
      <p className="ru-caption">Errors in Walnut's pages · {rangeWord(range)}</p>
      <UsageTable kind="page" rows={pages} cols={pageCols(range)} range={range} now={now} empty={<EmptyState size="row" title={`No page errors in the last ${rangeWord(range)}`} />} />
      <p className="ru-legend">Kept as the request it failed on, or the error's type and the part of Walnut's built code it came from; never its message.</p>
    </section>
  );
}
