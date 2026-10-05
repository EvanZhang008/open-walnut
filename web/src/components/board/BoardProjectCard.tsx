/**
 * One card of the project board (BoardProjectBoard.tsx): a board project the
 * way the leader's page shows it, built from Walnut's data
 * (board-cards-model.ts).
 *
 * Head: the title (a click folds the card; done ones start folded), the status
 * pill (a click opens the four statuses inline; a pick is the user's and goes
 * to the leader), the "waiting on" tag, red counts of what needs the user, the
 * leader's count line. Body, each part one the reader can hide: the tasks as
 * live chips (a click opens the task beside the board), the overview, the
 * latest update with its time, the next step; then the choices waiting for an
 * answer (always shown: they are what the user is here for) and the Questions
 * thread.
 */
import { memo, useState } from 'react';
import { log } from '@/utils/log';
import { timeAgo } from '@/utils/time';
import type { BoardProjectStatus } from './board-model';
import {
  PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, rowTooltip, type PlacedRow,
} from './board-overview-model';
import { choiceAnswered, foldedByDefault, type CardChoice, type CardParts, type ProjectCard } from './board-cards-model';
import { CardComposer, CardThreadBlock, MdText, shortWhen, type CardContext } from './BoardCardThread';
import type { ChoiceSave } from './useBoardItemSaves';

/** What the user hears after a choice write, in the page's words. */
function savedNote(r: ChoiceSave): { text: string; failed: boolean } {
  if (!r.ok) return { text: `Not sent: ${r.error}`, failed: true };
  return { text: r.delivered ? 'Sent to the leader' : 'Saved. The leader sees it on the board.', failed: false };
}

/** Chips a card shows before "+N more". */
const SHOWN_CHIPS = 8;
const STATUSES: readonly BoardProjectStatus[] = ['decide', 'wip', 'wait', 'done'];

export interface BoardCardActions {
  setStatus: (projectId: string, status: BoardProjectStatus) => Promise<string | null>;
  pickChoice: (choiceId: string, option: string) => Promise<ChoiceSave>;
  answerChoiceText: (choiceId: string, text: string) => Promise<ChoiceSave>;
  postMessage: (threadId: string, text: string) => Promise<string | null>;
  markSeen: (threadId: string, ts: string) => void;
}

export const BoardProjectCard = memo(function BoardProjectCard({ card, parts, folded, onToggle, ctx, actions }: {
  card: ProjectCard;
  parts: CardParts;
  folded: boolean;
  /** Fold or open the card, against its default (done ones start folded). */
  onToggle: (cardId: string, byDefault: boolean) => void;
  ctx: CardContext;
  actions?: BoardCardActions;
}) {
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<BoardProjectStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const status = saving ?? card.status;
  const isProject = card.kind === 'project';

  const pick = async (next: BoardProjectStatus) => {
    setPicking(false);
    if (!actions || next === card.status) return;
    log.info('board', 'overview project status picked', { taskId: ctx.ownerId, projectId: card.id, status: next, from: card.status ?? '' });
    setSaving(next);
    setStatusError('');
    const failed = await actions.setStatus(card.id, next);
    setSaving(null);
    if (failed) setStatusError(failed);
  };

  const hasText = !!(card.summary || card.latest || card.next);
  const wantsText = parts.summary || parts.latest || parts.next;
  return (
    <article
      className="bpc"
      data-card-id={card.id}
      data-kind={card.kind}
      data-status={status ?? undefined}
      data-tone={status ? PROJECT_STATUS_TONES[status] : undefined}
      data-folded={folded ? 'true' : 'false'}
      data-testid="board-card"
      aria-label={card.title}
    >
      <div className="bpc-head">
        <button
          type="button"
          className="bpc-fold"
          data-bo-nav=""
          aria-expanded={!folded}
          title={folded ? `Show ${card.title}` : `Fold ${card.title}`}
          data-testid="board-card-fold"
          onClick={() => onToggle(card.id, foldedByDefault(card))}
        >
          <span className={`bo-chevron${folded ? '' : ' is-open'}`} aria-hidden="true" />
          <span className="bpc-title" data-testid="board-card-title">{card.title}</span>
        </button>
        {isProject && (
          <button
            type="button"
            className="bo-badge bpc-status"
            data-tone={status ? PROJECT_STATUS_TONES[status] : undefined}
            aria-haspopup="true"
            aria-expanded={picking}
            disabled={!actions || saving !== null}
            title={card.statusByUser ? 'You set this status. Click to change it.' : 'Click to change the status'}
            data-testid="board-card-status"
            onClick={() => setPicking((v) => !v)}
          >
            {status ? PROJECT_STATUS_LABELS[status] : 'No status'}
            {card.statusByUser && <span className="bpc-by-you"> · yours</span>}
            <span className="bpc-caret" aria-hidden="true" />
          </button>
        )}
        {card.bucket === 'answered' && <span className="bpc-tag bpc-tag-answered" title="You answered its choices; the leader has not moved it on yet">Answered</span>}
        {card.waiting && <span className="bpc-tag bpc-waiting" data-testid="board-card-waiting" title={`Waiting on: ${card.waiting}`}>{card.waiting}</span>}
        {card.attention > 0 && (
          <span className="bpc-count-red" data-testid="board-card-attention" title={`${card.attention} ${card.attention === 1 ? 'task needs' : 'tasks need'} you`}>
            {card.attention} need{card.attention === 1 ? 's' : ''} you
          </span>
        )}
        {folded && card.pendingChoices > 0 && <span className="bpc-count-red">{card.pendingChoices} to answer</span>}
        {folded && card.unread > 0 && <span className="bpc-new">{card.unread} new</span>}
        <span className="bpc-meta" data-testid="board-card-meta">{card.meta || (card.rows.length ? `${card.rows.length} ${card.rows.length === 1 ? 'task' : 'tasks'}` : '')}</span>
      </div>
      {picking && actions && (
        <div className="bpc-picker" role="group" aria-label={`Status of ${card.title}`} data-testid="board-card-picker">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className="bo-badge bpc-pick"
              data-tone={PROJECT_STATUS_TONES[s]}
              aria-pressed={s === card.status}
              data-testid={`board-card-pick-${s}`}
              onClick={() => void pick(s)}
            >{PROJECT_STATUS_LABELS[s]}</button>
          ))}
          <button type="button" className="bo-link" onClick={() => setPicking(false)}>Cancel</button>
        </div>
      )}
      {statusError && <div className="bpc-error bpc-head-error" role="alert">Status not saved: {statusError}</div>}

      {!folded && (
        <div className="bpc-body">
          {parts.tasks && card.rows.length > 0 && <TaskChips rows={card.rows} ctx={ctx} />}
          {parts.summary && card.summary && <MdText className="bpc-summary" text={card.summary} onOpenTask={ctx.onOpenTask} />}
          {parts.latest && card.latest && (
            <div className="bpc-line" data-testid="board-card-latest">
              <span className="bpc-label">Latest</span>
              <div className="bpc-line-text">
                {card.latestAt && <span className="bpc-when" title={new Date(card.latestAt).toLocaleString()}>{shortWhen(card.latestAt)} · {timeAgo(card.latestAt)}</span>}
                <MdText text={card.latest} onOpenTask={ctx.onOpenTask} />
              </div>
            </div>
          )}
          {parts.next && card.next && (
            <div className="bpc-line" data-testid="board-card-next">
              <span className="bpc-label">Next</span>
              <div className="bpc-line-text"><MdText text={card.next} onOpenTask={ctx.onOpenTask} /></div>
            </div>
          )}
          {isProject && wantsText && !hasText && (
            <div className="bpc-none">The leader has not written this card yet.</div>
          )}
          {card.choices.map((c) => <ChoiceBlock key={c.id} choice={c} ctx={ctx} actions={actions} />)}
          {parts.questions && card.threads.map((t, i) => (
            <CardThreadBlock
              key={t.id}
              thread={t}
              label={i === 0 && isProject ? 'Questions' : t.title || 'Thread'}
              ctx={ctx}
              onPost={actions?.postMessage}
              onSeen={actions?.markSeen}
            />
          ))}
        </div>
      )}
    </article>
  );
});

function TaskChips({ rows, ctx }: { rows: readonly PlacedRow[]; ctx: CardContext }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN_CHIPS);
  return (
    <div className="bpc-tasks" data-testid="board-card-tasks">
      {shown.map((r) => (
        <button
          key={r.id}
          type="button"
          className="bpc-chip"
          data-task-id={r.id}
          data-group={r.group}
          data-tone={r.badge.tone}
          data-unread={r.task.unread && r.group !== 'done' ? 'true' : undefined}
          title={r.task.unread && r.group !== 'done' ? `${rowTooltip(r)}\nUnread output` : rowTooltip(r)}
          data-testid="board-card-chip"
          onClick={() => {
            log.info('board', 'overview row opened', { taskId: ctx.ownerId, targetTaskId: r.id, from: 'card' });
            ctx.onOpenTask(r.id);
          }}
        >
          <span className="bpc-dot" aria-hidden="true" />
          <span className="bpc-chip-title">{r.task.title}</span>
          <span className="bpc-chip-state">{r.badge.label}</span>
        </button>
      ))}
      {rows.length > SHOWN_CHIPS && (
        <button type="button" className="bo-link bpc-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `+${rows.length - SHOWN_CHIPS} more`}
        </button>
      )}
    </div>
  );
}

/**
 * A choice on a card: open while it waits for an answer (the options, the
 * recommended one marked, "In your own words"), one line once answered with a
 * way back in to change it. Its discussion thread sits under it.
 */
function ChoiceBlock({ choice, ctx, actions }: { choice: CardChoice; ctx: CardContext; actions?: BoardCardActions }) {
  const answered = choiceAnswered(choice.answer);
  const [open, setOpen] = useState(false);
  const [words, setWords] = useState(false);
  const [sending, setSending] = useState('');
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const expanded = !answered || open || words || !!sending;

  const pick = async (option: string) => {
    if (!actions || sending || choice.answer?.option === option) return;
    log.info('board', 'overview choice picked', { taskId: ctx.ownerId, choiceId: choice.id, option });
    setSending(option);
    setNote(null);
    const saved = await actions.pickChoice(choice.id, option);
    setSending('');
    // Answered just now, here: it stays open under the user's eyes (as on the page) until they fold it.
    if (saved.ok) setOpen(true);
    setNote(savedNote(saved));
  };
  const sendWords = async (text: string): Promise<string | null> => {
    if (!actions) return 'This board cannot be written here';
    const saved = await actions.answerChoiceText(choice.id, text);
    if (!saved.ok) return saved.error;
    setWords(false);
    setOpen(true);
    setNote(savedNote(saved));
    return null;
  };

  const chosen = sending || choice.answer?.option || '';
  const at = choice.answer?.text_at && (!choice.answer.at || choice.answer.text_at > choice.answer.at) ? choice.answer.text_at : choice.answer?.at;
  return (
    <div className="bpc-choice" data-choice-id={choice.id} data-answered={answered ? 'true' : 'false'} data-testid="board-card-choice">
      {!expanded ? (
        <button type="button" className="bpc-choice-done" onClick={() => setOpen(true)} title="Answered. Click to see or change it.">
          <span className="bpc-check" aria-hidden="true">✓</span>
          <span className="bpc-choice-title">{choice.title || choice.id}</span>
          {choice.answerLabel && <span className="bpc-choice-pick">{choice.answerLabel}</span>}
          {!choice.answerLabel && choice.answer?.text && <span className="bpc-choice-said">"{choice.answer.text.replace(/\s+/g, ' ')}"</span>}
          {at && <span className="bpc-when">{timeAgo(at)}</span>}
        </button>
      ) : (
        <>
          <div className="bpc-choice-head">
            <span className="bpc-kicker">{answered ? 'Answered' : 'Your call'}</span>
            <span className="bpc-choice-title">{choice.title || choice.id}</span>
            {choice.due && <span className="bpc-count-red">Reminder due</span>}
            {answered && open && <button type="button" className="bo-link bpc-choice-fold" onClick={() => { setOpen(false); setNote(null); }}>Fold</button>}
          </div>
          {choice.context && <div className="bpc-choice-context">{choice.context}</div>}
          {choice.options.length > 0 && (
            <div className="bpc-options" role="group" aria-label={choice.title || choice.id}>
              {choice.options.map((o, i) => (
                <button
                  key={o.key}
                  type="button"
                  className={`bpc-option${o.key === choice.recommended ? ' is-rec' : ''}`}
                  aria-pressed={o.key === chosen}
                  disabled={!actions || !!sending}
                  data-option={o.key}
                  data-testid="board-card-option"
                  onClick={() => void pick(o.key)}
                >
                  <span className="bpc-option-n">{i + 1}.</span>
                  <span className="bpc-option-label">{o.label}</span>
                  {o.key === choice.recommended && <span className="bpc-rec">Recommended</span>}
                  {o.key === sending && <span className="bpc-when">Sending…</span>}
                </button>
              ))}
            </div>
          )}
          {choice.answer?.text && !words && (
            <div className="bpc-said"><span className="bpc-who">You wrote</span> {choice.answer.text}</div>
          )}
          {words ? (
            <CardComposer
              draftKey={`${ctx.ownerId}|choice:${choice.id}`}
              placeholder="Your answer, in your own words…"
              sendLabel="Send answer"
              initial={choice.answer?.text ?? ''}
              autoFocus
              onSend={sendWords}
              onClose={() => setWords(false)}
            />
          ) : actions && (
            <button type="button" className="bo-link bpc-own" data-testid="board-card-own-words" onClick={() => setWords(true)}>
              {choice.answer?.text ? 'Change your words…' : 'Answer in your own words…'}
            </button>
          )}
          {note && <div className={note.failed ? 'bpc-error' : 'bpc-ok'} role={note.failed ? 'alert' : 'status'}>{note.text}</div>}
        </>
      )}
      {choice.thread && (choice.thread.messages.length > 0 || expanded) && (
        <CardThreadBlock
          thread={choice.thread}
          label="Discussion"
          ctx={ctx}
          onPost={actions?.postMessage}
          onSeen={actions?.markSeen}
        />
      )}
    </div>
  );
}
