/**
 * Voice Accuracy's Recordings group: by recording (or by day), the engines as
 * columns. The header row and every row share one column template (the
 * recording, one column per engine, the Details key's room), and the header
 * stays in view under the pane's title bar while the list scrolls. When the
 * engine columns do not fit the pane, or on a phone, each recording is a stacked
 * row with one tag per engine, so the list never scrolls sideways. A click on a
 * recording's row, or its Details key, opens the whole recording in a dialog
 * (VoiceAccuracyTakeDialog): a row never grows in place. Texts show in full.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { NoticeStatus } from '@/components/common/NoticeCard';
import type { CompareDay, CompareEngineRow, CompareTake } from '@/api/stt-compare';
import { useElementWidth } from '@/hooks/useElementWidth';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { usePageView } from '@/utils/view-memory';
import { SettingsGroup, SettingsRow, SettingsTag } from '../SettingsSection';
import { ChevronGlyph } from '../settings-glyphs';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { SettingsButton } from '../inputs/SettingsButton';
import { VoiceAccuracyTakeDialog, whenOf } from './VoiceAccuracyTakeDialog';
import { RUN_LAST, markedLowest, pct, shortLabel, takeCell, takeRate, takeText, takesLayout, type TakeCell, type TakesLayout } from './voice-accuracy-model';
import { EmptyState } from '@/components/common/EmptyState';

type View = 'take' | 'day';
const isView = (v: unknown): v is View => v === 'take' || v === 'day';

interface Props {
  takes: CompareTake[];
  total: number;
  hasMore: boolean;
  byDay: CompareDay[];
  /** The engine columns, in order. */
  engines: CompareEngineRow[];
  /** The AI judge's row (its state says whether errors can be estimated again). */
  judge: CompareEngineRow | undefined;
  onMore(): void;
  /** Run one engine again on one take; null when queued, else why not (shown on that take's row). */
  onRetry(takeId: string, engineId: string): Promise<string | null>;
  onJudge(takeId: string): Promise<string | null>;
}

/** The shared "Lowest" mark: a word in the shared badge, never a bare dot. */
export function LowestTag() {
  return <span className="badge badge-done">Lowest</span>;
}


function versionOf(take: CompareTake): string {
  const run = Object.entries(take.run).map(([e, s]) => `${e}:${s.state}`).join(',');
  const results = Object.entries(take.results).map(([e, r]) => `${e}:${r.at}`).join(',');
  return `${run}|${results}|${take.reference?.at ?? ''}`;
}

/** One engine's number, or its state as the shared status, named for a screen reader (the header row is hidden from it). */
function Num({ cell, engine, marked }: { cell: TakeCell; engine: CompareEngineRow; marked: boolean }) {
  return (
    <span className="va-num" data-tone={cell.tone} data-marked={marked ? 'true' : undefined} title={cell.error}>
      <span className="settings-visually-hidden">{`${engine.label}: `}</span>
      {cell.status ? <NoticeStatus tone={cell.status} whole className="va-num-status">{cell.text}</NoticeStatus> : cell.text}
      {cell.sub && <span className="va-num-sub">{cell.sub}</span>}
      {marked && <span className="va-num-sub"><LowestTag /></span>}
    </span>
  );
}

function Badges({ cells, engines, marked }: { cells: TakeCell[]; engines: CompareEngineRow[]; marked?: string }) {
  return (
    <span className="va-badges">
      {engines.map((engine, i) => {
        const cell = cells[i]!;
        const lowest = marked === engine.id;
        const tone = cell.tone === 'error' ? 'error' : lowest ? 'success' : 'neutral';
        return (
          <SettingsTag key={engine.id} tone={tone} title={cell.error ?? engine.label}>
            {`${shortLabel(engine)} ${cell.text}${cell.sub ? ` · ${cell.sub}` : ''}${lowest ? ' · Lowest' : ''}`}
          </SettingsTag>
        );
      })}
    </span>
  );
}

/** The matrix's one column template: the first cell, one per engine, and the Details key's room. */
function Grid({ engines, first, cells, end }: { engines: CompareEngineRow[]; first: ReactNode; cells: ReactNode[]; end?: ReactNode }) {
  return (
    <span className="va-grid" style={{ ['--va-cols' as string]: engines.length }}>
      {first}
      {cells}
      {end ?? <span className="va-grid-end" aria-hidden="true" />}
    </span>
  );
}

/**
 * One recording: a click anywhere on it opens its dialog; its Details key (the family's quiet icon
 * key) is the way in from the keyboard and where the focus comes back when the dialog closes. A
 * Retry that could not start says why on this row.
 */
function TakeRow({ take, engines, layout, open, error, onOpen }: {
  take: CompareTake; engines: CompareEngineRow[]; layout: TakesLayout; open: boolean; error?: string; onOpen(): void;
}) {
  const cells = engines.map((e) => takeCell(take, e));
  const marked = markedLowest(engines.map((e) => ({ id: e.id, value: takeRate(take.scores?.[e.id]) })));
  const words = takeText(take);
  const copy = (
    <span className="settings-row-copy">
      <span className="va-take-when">{whenOf(take)}</span>
      {words.text && (
        <span className="va-take-text">
          <span className="va-take-source">{`${words.source}: `}</span>
          {words.text}
        </span>
      )}
      {layout === 'stacked' && <Badges cells={cells} engines={engines} marked={marked} />}
      {error && <span className="va-error" role="alert" data-testid="va-row-error">{error}</span>}
    </span>
  );
  const details = (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      aria-label={`Details of the recording of ${whenOf(take)}`}
      title="Details"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="va-take-details"
      data-take={take.id}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
    >
      <ChevronGlyph size={12} />
    </button>
  );
  return (
    <div className="settings-row va-take-row" data-testid="va-take-row" data-take={take.id} data-open={open ? 'true' : 'false'} onClick={onOpen}>
      {layout === 'matrix'
        ? <Grid engines={engines} first={copy} cells={cells.map((cell, i) => <Num key={engines[i]!.id} cell={cell} engine={engines[i]!} marked={marked === engines[i]!.id} />)} end={<span className="va-grid-end">{details}</span>} />
        : <>{copy}<span className="va-take-end">{details}</span></>}
    </div>
  );
}

function DayRows({ days, engines, layout }: { days: CompareDay[]; engines: CompareEngineRow[]; layout: TakesLayout }) {
  if (!days.length) return <EmptyState size="row" title="No day has estimated errors yet" />;
  return (
    <>
      {days.map((day) => {
        const cells: TakeCell[] = engines.map((e) => {
          const rate = day.engines[e.id]?.mixed ?? null;
          return rate === null ? { text: 'Not run', tone: 'muted', status: 'muted' } : { text: pct(rate) };
        });
        const label = new Date(`${day.day}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const help = `${day.takes} recording${day.takes === 1 ? '' : 's'}`;
        if (layout === 'stacked') {
          return <SettingsRow key={day.day} label={label} help={<>{help}<Badges cells={cells} engines={engines} marked={day.best} /></>} data-testid="va-day-row" />;
        }
        return (
          <div key={day.day} className="settings-row" data-testid="va-day-row">
            <Grid
              engines={engines}
              first={<span className="settings-row-copy"><span className="va-take-when">{label}</span><span className="va-take-text">{help}</span></span>}
              cells={cells.map((cell, i) => <Num key={engines[i]!.id} cell={cell} engine={engines[i]!} marked={day.best === engines[i]!.id} />)}
            />
          </div>
        );
      })}
    </>
  );
}

export function VoiceAccuracyTakes({ takes, total, hasMore, byDay, engines, judge, onMore, onRetry, onJudge }: Props) {
  const [view, setView] = usePageView<View>('settings-voice-accuracy', 'takes', 'take', isView);
  // The recording in the dialog; a modal is never reopened by itself on the way back to the pane.
  const [dialogTake, setDialogTake] = useState<string | null>(null);
  // A Retry that could not start, by recording: it shows on that recording's row (and in its dialog).
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const boxRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(boxRef);
  const phone = usePhoneLayout();
  const layout = takesLayout(width, engines.length, phone);
  const shown = dialogTake ? takes.find((t) => t.id === dialogTake) : undefined;

  const close = useLeanCallback((returnFocus = true) => {
    const id = dialogTake;
    setDialogTake(null);
    // The focus goes back to the row the dialog came from (its Details key).
    if (id && returnFocus) {
      requestAnimationFrame(() => [...(boxRef.current?.querySelectorAll<HTMLElement>('[data-testid="va-take-details"]') ?? [])]
        .find((el) => el.dataset.take === id)?.focus());
    }
  }, [dialogTake]);

  const retry = async (takeId: string, engineId: string) => {
    setRetryErrors(({ [takeId]: _gone, ...rest }) => rest);
    const refused = await onRetry(takeId, engineId);
    if (refused) setRetryErrors((e) => ({ ...e, [takeId]: `Couldn't run it again: ${refused}` }));
  };

  const header = layout === 'matrix' && (
    <div className="settings-row settings-sticky-head va-grid-head-row" aria-hidden="true" data-testid="va-takes-head">
      <Grid
        engines={engines}
        first={<span className="va-grid-head">{view === 'take' ? 'Recording' : 'Day'}</span>}
        cells={engines.map((e) => <span key={e.id} className="va-grid-head va-num" title={e.label}>{shortLabel(e)}</span>)}
      />
    </div>
  );

  return (
    <div ref={boxRef} data-testid="va-takes" data-layout={layout}>
      <SettingsGroup
        heading="Recordings"
        className="settings-group-sticky"
        headingTrailing={(
          <SegmentedControl<View>
            value={view}
            onChange={setView}
            aria-label="Show the recordings"
            options={[{ value: 'take', label: 'By recording', testId: 'va-view-take' }, { value: 'day', label: 'By day', testId: 'va-view-day' }]}
          />
        )}
        footer={view === 'take' && takes.length > 0 ? `${takes.length} of ${total} recordings shown. Estimated errors are against the AI's guess.` : undefined}
      >
        {header}
        {view === 'day' && <DayRows days={byDay} engines={engines} layout={layout} />}
        {view === 'take' && takes.length === 0 && (
          <EmptyState size="row" title="No recordings compared yet" hint={`Run a comparison to hear up to ${RUN_LAST} recordings again.`} />
        )}
        {view === 'take' && takes.map((take) => (
          <TakeRow
            key={take.id}
            take={take}
            engines={engines}
            layout={layout}
            open={dialogTake === take.id}
            error={retryErrors[take.id]}
            onOpen={() => setDialogTake(take.id)}
          />
        ))}
        {view === 'take' && hasMore && (
          <SettingsRow label={`${takes.length} of ${total} shown`} control={<SettingsButton onClick={onMore}>Show more</SettingsButton>} />
        )}
      </SettingsGroup>
      {shown && (
        <VoiceAccuracyTakeDialog
          take={shown}
          engines={engines}
          judge={judge}
          version={versionOf(shown)}
          retryError={retryErrors[shown.id]}
          onRetry={(engineId) => void retry(shown.id, engineId)}
          onJudge={() => onJudge(shown.id)}
          onClose={close}
        />
      )}
    </div>
  );
}
