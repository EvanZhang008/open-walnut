/**
 * A change's deploy (ChangeCard.tsx, and a merged pull request's card in PrPill.tsx): the pipeline
 * and how far it got ("13 of 29 deployed"), the track (one segment per stage in its status's tone,
 * the furthest stage marked; a click on a segment opens that stage), then the stage rows: the ones
 * that ask for a look in full, every other run folded into one row ("5 deployed", "14 not
 * reached", change-status.ts stageRows). A click on a stage reads its steps and what blocks it
 * live from the provider (`GET /api/tasks/:id/changes/stage`, the server answers within its own
 * deadline). Which rows are open is a moment's look, kept by nothing.
 */
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { useEffect, useRef, useState } from 'react';
import type { ChangeBlocker, ChangeDeploy, ChangeStage, ChangeStageDetail } from '../../../../src/core/changes/model';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { BLOCKER_WORDS, STAGE_WORDS, deployCounts, foldOf, stageRows, stageTime, trackGroups, untilWords } from './change-status';
import { OutIcon, StatusIcon } from './ChangeIcons';
import { DisclosureChevron } from '@/components/controls';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'done'; detail: ChangeStageDetail | null };

/** The stage detail route's answer. */
interface StageAnswer { detail: ChangeStageDetail | null; error?: string }

/** Longer than the server's own 15 s deadline: it answers `timeout` itself, never hangs. */
const STAGE_FETCH_MS = 20_000;

function errorWords(error: string): string {
  if (error === 'timeout') return 'The pipeline did not answer in time. Try again in a moment';
  return `Could not read this stage: ${error}`;
}

function Blocker({ blocker }: { blocker: ChangeBlocker }) {
  const when = blocker.until ? `${stageTime(blocker.until)}, ${untilWords(blocker.until)}` : '';
  return (
    <li className="change-card-blocker" data-kind={blocker.kind}>
      <span className="change-card-blocker-kind">{BLOCKER_WORDS[blocker.kind]}</span>
      <span className="change-card-blocker-text">{blocker.text}</span>
      {when && <span className="change-card-blocker-until">until {when}</span>}
    </li>
  );
}

function StageDetail({ state }: { state: DetailState }) {
  if (state.kind === 'loading') return <div className="change-card-detail"><LoadingState size="row" testId="change-stage-loading" title="Reading the stage…" /></div>;
  if (state.kind === 'error') return <div className="change-card-detail"><UnavailableState size="row" testId="change-stage-error" title={state.text} /></div>;
  const d = state.detail;
  if (!d || (d.steps.length === 0 && d.blockers.length === 0)) {
    return <div className="change-card-detail"><EmptyState size="row" testId="change-stage-empty" title="Nothing more on this stage" /></div>;
  }
  return (
    <div className="change-card-detail" data-testid="change-stage-detail">
      {d.blockers.length > 0 && <ul className="change-card-blockers">{d.blockers.map((b, i) => <Blocker key={`${i}:${b.kind}`} blocker={b} />)}</ul>}
      {d.steps.length > 0 && (
        <ul className="change-card-steps">
          {d.steps.map((step, i) => (
            <li key={`${i}:${step.name}`} className="change-card-step" data-status={step.status} data-testid="change-stage-step">
              <span className="change-card-step-mark" data-tone={step.status}><StatusIcon status={step.status} label={STAGE_WORDS[step.status]} /></span>
              <span className="change-card-step-name wn-title" title={step.url}>{step.name}</span>
              {step.note && <span className="change-card-step-note">{step.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {d.url && <a className="change-card-detail-link" href={d.url} target="_blank" rel="noopener noreferrer">Open the stage <OutIcon /></a>}
    </div>
  );
}

function StageRow({ stage, last, open, state, onToggle }: {
  stage: ChangeStage; last: boolean; open: boolean; state: DetailState; onToggle(): void;
}) {
  const loud = stage.status === 'failed' || stage.status === 'blocked' || stage.status === 'waiting' || stage.status === 'running';
  // A row says its state in a word; why is the card's summary and the stage's detail.
  const word = stage.status === 'waiting' && stage.blocker?.kind === 'bake' ? 'Baking' : STAGE_WORDS[stage.status];
  const when = stage.blocker?.until ? untilWords(stage.blocker.until) : stageTime(stage.at);
  return (
    <li
      className="change-card-stage"
      data-status={stage.status}
      data-open={open ? 'true' : undefined}
      data-last={last ? 'true' : undefined}
      data-testid="change-stage"
      data-stage={stage.name}
    >
      <button type="button" className="change-card-stage-row" aria-expanded={open} onClick={onToggle} title={stage.blocker?.text ?? stage.note}>
        <span className="change-card-stage-mark" data-tone={stage.status}><StatusIcon status={stage.status} label={STAGE_WORDS[stage.status]} /></span>
        <span className="change-card-stage-main">
          <span className="change-card-stage-name">{stage.name}</span>
          {stage.target && <span className="change-card-stage-target">{stage.target}</span>}
        </span>
        <span className="change-card-stage-end">
          {loud && <span className="change-card-stage-words" data-tone={stage.status}>{word}</span>}
          {when && <span className="change-card-stage-at" title={stage.blocker?.until ? 'When it moves on by itself' : 'When it was deployed'}>{stage.blocker?.until ? `opens ${when}` : when}</span>}
        </span>
      </button>
      {open && <StageDetail state={state} />}
    </li>
  );
}

function Segment({ stage, index, now, open, onPick }: { stage: ChangeStage; index: number; now?: string; open: boolean; onPick(index: number): void }) {
  return (
    <button
      type="button"
      className="change-card-seg"
      data-choice-exempt="a stage of the deploy progress bar, coloured by its status; a click opens that stage"
      data-status={stage.status}
      data-now={stage.name === now ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
      title={`${stage.name}: ${stage.blocker?.text ?? stage.note ?? STAGE_WORDS[stage.status]}`}
      aria-label={`${stage.name}, ${STAGE_WORDS[stage.status]}`}
      onClick={() => onPick(index)}
    />
  );
}

/** One segment per stage; a long pipeline in its groups (`build`, `prod`), each named under it. */
/** A group's label shows only where its segments are wide enough for it (about 13 px a segment
 *  and 2 px between, 6.5 px a letter); the whole name is its tooltip. */
const fitsLabel = (label: string, size: number) => label.length * 6.5 <= size * 13 + (size - 1) * 2;

function Track({ stages, now, opened, onPick }: { stages: readonly ChangeStage[]; now?: string; opened: ReadonlySet<string>; onPick(index: number): void }) {
  const groups = trackGroups(stages);
  if (!groups.length) {
    return (
      <div className="change-card-track" role="group" aria-label="Pipeline stages" data-testid="change-track">
        <div className="change-card-track-group" style={{ flexGrow: stages.length }}>
          <div className="change-card-track-segs">{stages.map((s, i) => <Segment key={`${i}:${s.name}`} stage={s} index={i} now={now} open={opened.has(s.name)} onPick={onPick} />)}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="change-card-track" role="group" aria-label="Pipeline stages" data-testid="change-track" data-grouped="true">
      {groups.map((g) => (
        <div key={g.from} className="change-card-track-group" style={{ flexGrow: g.size }}>
          <div className="change-card-track-segs">
            {stages.slice(g.from, g.from + g.size).map((s, k) => <Segment key={`${g.from + k}:${s.name}`} stage={s} index={g.from + k} now={now} open={opened.has(s.name)} onPick={onPick} />)}
          </div>
          <span className="change-card-track-label" title={g.label}>{fitsLabel(g.label, g.size) ? g.label : ''}</span>
        </div>
      ))}
    </div>
  );
}

export function ChangeDeployView({ deploy, taskId, url, stale, focus, now }: {
  deploy: ChangeDeploy; taskId: string; url: string; stale?: boolean;
  /** The stage the card's summary is about: its segment stands out on the track. */
  now?: string;
  /** A stage the card asks to open (its "Open <stage>" button), with a count that changes per ask. */
  focus?: { stage: string; ask: number };
}) {
  const [openedFolds, setOpenedFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [openStages, setOpenStages] = useState<ReadonlySet<string>>(() => new Set());
  const [details, setDetails] = useState<Readonly<Record<string, DetailState>>>({});
  const counts = deployCounts(deploy);
  const rows = stageRows(deploy.stages, deploy.last, openedFolds);

  // Each read of a stage counts up: only the newest answer for it is drawn.
  const reads = useRef<Record<string, number>>({});
  const read = (stage: string) => {
    const n = (reads.current[stage] ?? 0) + 1;
    reads.current[stage] = n;
    const settle = (state: DetailState) => { if (reads.current[stage] === n) setDetails((prev) => ({ ...prev, [stage]: state })); };
    settle({ kind: 'loading' });
    apiGet<StageAnswer>(`/api/tasks/${encodeURIComponent(taskId)}/changes/stage`, { url, stage }, { timeoutMs: STAGE_FETCH_MS })
      .then((answer) => settle(answer.error && !answer.detail ? { kind: 'error', text: errorWords(answer.error) } : { kind: 'done', detail: answer.detail }))
      .catch((err: unknown) => {
        log.warn('tasks', 'change stage detail failed', { taskId, url, stage, error: String(err) });
        settle({ kind: 'error', text: errorWords(err instanceof Error ? err.message : String(err)) });
      });
  };
  const toggle = (stage: string) => {
    const opening = !openStages.has(stage);
    // Read again on every open: the server keeps a minute's copy, and a stage moves.
    if (opening) read(stage);
    setOpenStages((prev) => {
      const next = new Set(prev);
      if (opening) next.add(stage); else next.delete(stage);
      return next;
    });
  };
  const pick = (index: number) => {
    const stage = deploy.stages[index]!;
    const fold = foldOf(rows, index);
    if (fold !== undefined) setOpenedFolds((prev) => new Set(prev).add(fold));
    if (!openStages.has(stage.name)) toggle(stage.name);
  };

  useEffect(() => {
    if (!focus) return;
    const index = deploy.stages.findIndex((s) => s.name === focus.stage);
    if (index >= 0 && !openStages.has(focus.stage)) pick(index);
    // Only a new ask opens it: the rest is read at the time of the ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.ask]);

  return (
    <section className="change-card-deploy" data-stale={stale ? 'true' : undefined} data-testid="change-deploy">
      <div className="change-card-deploy-head">
        <span className="change-card-deploy-name wn-title">{deploy.pipeline}</span>
        {deploy.commit && <code className="change-card-commit" title={deploy.commit}>{deploy.commit.slice(0, 7)}</code>}
        <span className="change-card-count" data-testid="change-deploy-count">{counts.done} of {counts.total} deployed</span>
      </div>
      {deploy.stages.length > 1 && <Track stages={deploy.stages} now={now ?? deploy.last} opened={openStages} onPick={pick} />}
      {deploy.stages.length > 0 && (
        <ul className="change-card-stages" data-testid="change-stages">
          {rows.map((row) => row.kind === 'hide'
            ? (
              <li key={`h:${row.from}`} className="change-card-stage change-card-hide">
                <button
                  type="button"
                  className="change-card-hide-row"
                  data-testid="change-stage-hide"
                  onClick={() => setOpenedFolds((prev) => { const next = new Set(prev); next.delete(deploy.stages[row.from]!.name); return next; })}
                >
                  <DisclosureChevron open /> Hide {row.size} {row.status === 'done' ? 'deployed' : 'not reached'}
                </button>
              </li>
            )
            : row.kind === 'stage'
            ? (
              <StageRow
                key={`s:${row.index}:${row.stage.name}`}
                stage={row.stage}
                last={row.stage.name === deploy.last}
                open={openStages.has(row.stage.name)}
                state={details[row.stage.name] ?? { kind: 'loading' }}
                onToggle={() => toggle(row.stage.name)}
              />
            )
            : (
              <li key={`f:${row.from}`} className="change-card-stage change-card-fold" data-status={row.status}>
                <button
                  type="button"
                  className="change-card-stage-row"
                  data-testid="change-stage-fold"
                  title={row.stages.map((s) => s.name).join(', ')}
                  onClick={() => setOpenedFolds((prev) => new Set(prev).add(row.stages[0]!.name))}
                >
                  <span className="change-card-stage-mark" data-tone={row.status}><StatusIcon status={row.status} /></span>
                  <span className="change-card-stage-main">
                    <span className="change-card-stage-name">{row.stages.length} {row.status === 'done' ? 'deployed' : 'not reached'}</span>
                    <span className="change-card-stage-target">{row.stages[0]!.name} to {row.stages.at(-1)!.name}</span>
                  </span>
                  <span className="change-card-fold-more">Show <DisclosureChevron /></span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
