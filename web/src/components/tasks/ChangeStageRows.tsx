/**
 * The deploy part of a change's card (ChangeCard.tsx): one row per pipeline stage, in order, a
 * long run of stages not reached yet folded into one "N more stages" row (change-status.ts
 * stageRows). A click on a stage opens its steps and what blocks it, read live from the provider
 * (`GET /api/tasks/:id/changes/stage`, the server answers within its own deadline). Which rows are
 * open is a moment's look, kept by nothing.
 */
import { useState } from 'react';
import type { ChangeBlocker, ChangeStage, ChangeStageDetail } from '../../../../src/core/changes/model';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import { BLOCKER_WORDS, STAGE_TONES, STAGE_WORDS, STATUS_MARKS, stageRows, stageTime } from './change-status';

type DetailState =
  | { kind: 'loading' }
  | { kind: 'error'; text: string }
  | { kind: 'done'; detail: ChangeStageDetail | null };

/** The stage detail route's answer. */
interface StageAnswer { detail: ChangeStageDetail | null; error?: string }

/** Longer than the server's own 15 s deadline: it answers `timeout` itself, never hangs. */
const STAGE_FETCH_MS = 20_000;

function errorWords(error: string): string {
  if (error === 'timeout') return 'The pipeline did not answer in time. Try again in a moment.';
  return `Could not read this stage: ${error}`;
}

function Blocker({ blocker }: { blocker: ChangeBlocker }) {
  return (
    <li className="change-card-blocker" data-kind={blocker.kind}>
      <span className="change-card-blocker-kind">{BLOCKER_WORDS[blocker.kind]}</span>
      <span>{blocker.text}</span>
      {blocker.until && <span className="change-card-muted"> until {stageTime(blocker.until)}</span>}
    </li>
  );
}

function StageDetail({ state }: { state: DetailState }) {
  if (state.kind === 'loading') return <div className="change-card-detail change-card-muted" role="status" data-testid="change-stage-loading">Reading the stage…</div>;
  if (state.kind === 'error') return <div className="change-card-detail change-card-error" role="status" data-testid="change-stage-error">{state.text}</div>;
  const d = state.detail;
  if (!d || (d.steps.length === 0 && d.blockers.length === 0)) {
    return <div className="change-card-detail change-card-muted" data-testid="change-stage-empty">Nothing more on this stage.</div>;
  }
  return (
    <div className="change-card-detail" data-testid="change-stage-detail">
      {d.steps.length > 0 && (
        <ul className="change-card-steps">
          {d.steps.map((step, i) => (
            <li key={`${i}:${step.name}`} className="change-card-step" data-status={step.status} data-testid="change-stage-step">
              <span className="change-card-mark" data-tone={STAGE_TONES[step.status]} title={STAGE_WORDS[step.status]} aria-label={STAGE_WORDS[step.status]}>{STATUS_MARKS[step.status]}</span>
              {step.url
                ? <a href={step.url} target="_blank" rel="noopener noreferrer">{step.name}</a>
                : <span>{step.name}</span>}
              {step.note && <span className="change-card-muted"> {step.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {d.blockers.length > 0 && <ul className="change-card-blockers">{d.blockers.map((b, i) => <Blocker key={`${i}:${b.kind}`} blocker={b} />)}</ul>}
      {d.url && <a className="change-card-detail-link" href={d.url} target="_blank" rel="noopener noreferrer">Open the stage</a>}
    </div>
  );
}

function StageRow({ stage, taskId, url }: { stage: ChangeStage; taskId: string; url: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const tone = STAGE_TONES[stage.status];
  const words = stage.blocker?.text ?? stage.note ?? STAGE_WORDS[stage.status];

  const read = () => {
    setState({ kind: 'loading' });
    apiGet<StageAnswer>(`/api/tasks/${encodeURIComponent(taskId)}/changes/stage`, { url, stage: stage.name }, { timeoutMs: STAGE_FETCH_MS })
      .then((answer) => setState(answer.error && !answer.detail ? { kind: 'error', text: errorWords(answer.error) } : { kind: 'done', detail: answer.detail }))
      .catch((err: unknown) => {
        log.warn('tasks', 'change stage detail failed', { taskId, url, stage: stage.name, error: String(err) });
        setState({ kind: 'error', text: errorWords(err instanceof Error ? err.message : String(err)) });
      });
  };
  const toggle = () => {
    // Read again on every open: the server keeps a minute's copy, and a stage moves.
    if (!open) read();
    setOpen(!open);
  };

  return (
    <li className="change-card-stage" data-status={stage.status} data-open={open ? 'true' : undefined} data-testid="change-stage" data-stage={stage.name}>
      <button type="button" className="change-card-stage-row" aria-expanded={open} onClick={toggle}>
        <span className="change-card-dot" data-tone={tone} aria-hidden="true" />
        <span className="change-card-stage-name">{stage.name}</span>
        {stage.prod && <span className="change-card-prod" title="A production stage">prod</span>}
        {stage.target && <span className="change-card-stage-target">{stage.target}</span>}
        <span className="change-card-stage-words" data-tone={stage.blocker || stage.status === 'failed' ? tone : undefined}>
          <span className="change-card-sr">{STAGE_WORDS[stage.status]}: </span>{words}
        </span>
        {stage.at && <span className="change-card-stage-at">{stageTime(stage.at)}</span>}
      </button>
      {open && <StageDetail state={state} />}
    </li>
  );
}

export function ChangeStageRows({ stages, taskId, url }: { stages: readonly ChangeStage[]; taskId: string; url: string }) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  const rows = stageRows(stages, opened);
  return (
    <ul className="change-card-stages" data-testid="change-stages">
      {rows.map((row) => row.kind === 'stage'
        ? <StageRow key={`s:${row.index}:${row.stage.name}`} stage={row.stage} taskId={taskId} url={url} />
        : (
          <li key={`f:${row.from}`} className="change-card-stage change-card-fold">
            <button
              type="button"
              className="change-card-stage-row"
              data-testid="change-stage-fold"
              title={row.stages.map((s) => s.name).join(', ')}
              onClick={() => setOpened((prev) => new Set(prev).add(row.from))}
            >
              <span className="change-card-dot" data-tone="unknown" aria-hidden="true" />
              <span className="change-card-stage-name">{row.stages.length} more stages</span>
              <span className="change-card-stage-words change-card-muted">{row.stages[0]!.name} to {row.stages.at(-1)!.name}, not reached</span>
            </button>
          </li>
        ))}
    </ul>
  );
}
