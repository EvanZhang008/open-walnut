/**
 * `<suggest>` action card — the Personal AI's suggestion, one click from done.
 *
 * The card is a sibling of the markdown runs around it (see splitSuggestSegments),
 * so every button keeps real React state: running, result, inline confirmation.
 *
 * Two behaviours are copied from the session permission card because they were
 * learned the hard way:
 *  - a resolved button renders a RECEIPT, never an armed button again. Re-arming
 *    on a refusal bred zombie cards the user clicked forever.
 *  - the resolved state comes from a persisted verdict, not from local state
 *    only, so a reload shows what already happened instead of a fresh button
 *    over an op that already ran.
 */
import { useCallback, useMemo, useState } from 'react';
import { log } from '@/utils/log';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { invokeAction } from '@/api/actions';
import { readCardRecord, recordCardAction, terminalVerdict, type ActionVerdict } from '@/utils/suggest-card-state';
import type { SuggestAction, SuggestCardSpec } from '@/utils/suggest-parse';
import '@/styles/suggest-cards.css';

type Phase = 'idle' | 'confirming' | 'running' | 'done' | 'failed' | 'blocked';

interface ActionState {
  phase: Phase;
  message?: string;
  /** Confirmation prompt in flight — the card's own attr or the server's reason. */
  prompt?: string;
}

function phaseFromVerdict(verdict: ActionVerdict): Phase {
  if (verdict === 'ok') return 'done';
  if (verdict === 'unknown_tool') return 'blocked';
  return 'failed';
}

/**
 * Why a button can never fire, decided before any request. There is no op
 * CATALOG in the browser, so an unknown tool NAME can only be found out by
 * asking: the first click settles that button as blocked (persisted, so it stays
 * disabled with the reason as its tooltip after a reload).
 */
function staticBlock(action: SuggestAction): string | null {
  if (action.dismiss) return null;
  if (!action.tool) return 'This suggestion is missing a tool name';
  if (action.argsError) return action.argsError;
  return null;
}

/**
 * What the click will actually run. The label is free text the model chose, and
 * the model's input includes task titles, notes and transcripts it did not write,
 * so "Fix typo" can sit over an arbitrary `delegate`. The confirmation step shows
 * the op name and its literal args verbatim — never truncated, the CSS scrolls
 * instead, because an authorization prompt that hides part of the call is worse
 * than no prompt at all.
 */
function callPreview(action: SuggestAction): string {
  const args = Object.keys(action.args).length > 0 ? JSON.stringify(action.args, null, 2) : '{}';
  return `${action.tool} ${args}`;
}

export function SuggestCard({ card, onContentClick }: {
  card: SuggestCardSpec;
  onContentClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const persisted = useMemo(() => readCardRecord(card.id), [card.id]);
  const [states, setStates] = useState<Record<string, ActionState>>(() => {
    const initial: Record<string, ActionState> = {};
    for (const [actionId, verdict] of Object.entries(persisted?.actions ?? {})) {
      initial[actionId] = { phase: phaseFromVerdict(verdict), ...(persisted?.note ? { message: persisted.note } : {}) };
    }
    return initial;
  });
  const [dismissed, setDismissed] = useState(
    () => Object.values(persisted?.actions ?? {}).includes('dismissed'),
  );

  const bodyHtml = useMemo(
    () => (card.body ? renderMarkdownWithRefs(card.body) : ''),
    [card.body],
  );

  const setState = useCallback((actionId: string, next: ActionState) => {
    setStates((prev) => ({ ...prev, [actionId]: next }));
  }, []);

  const fire = useCallback(async (action: SuggestAction, confirmed: boolean) => {
    if (!action.tool) return;
    setState(action.id, { phase: 'running' });
    const outcome = await invokeAction(action.tool, action.args, confirmed ? { confirmed: true } : undefined);

    if (outcome.ok) {
      log.info('chat', 'suggest action applied', { cardId: card.id, actionId: action.id, tool: action.tool });
      recordCardAction(card.id, action.id, 'ok', action.label);
      setState(action.id, { phase: 'done', message: action.label });
      return;
    }

    const code = outcome.code ?? 'op_failed';
    const message = outcome.message ?? 'The action did not run';
    log.warn('chat', 'suggest action failed', { cardId: card.id, actionId: action.id, tool: action.tool, code, message });

    // The server owns the destructive rule; a card that forgot `confirm` is
    // escalated here rather than shown as an error the user cannot act on.
    if (code === 'confirmation_required') {
      setState(action.id, { phase: 'confirming', prompt: message });
      return;
    }
    // Only a verdict that is true of the CARD (not of this attempt) settles the
    // button and gets persisted — see terminalVerdict.
    const verdict: ActionVerdict | null = terminalVerdict(code);
    if (verdict) {
      recordCardAction(card.id, action.id, verdict, message);
      setState(action.id, { phase: verdict === 'unknown_tool' ? 'blocked' : 'failed', message });
      return;
    }
    // Transient (network / timeout / wrong box / the op's own refusal): show it,
    // stay armed, persist nothing.
    setState(action.id, { phase: 'idle', message });
  }, [card.id, setState]);

  const onClick = useCallback((action: SuggestAction) => {
    if (action.dismiss) {
      recordCardAction(card.id, action.id, 'dismissed', action.label);
      log.info('chat', 'suggest card dismissed', { cardId: card.id, actionId: action.id });
      setDismissed(true);
      return;
    }
    if (action.confirm && states[action.id]?.phase !== 'confirming') {
      setState(action.id, { phase: 'confirming', prompt: action.confirm });
      return;
    }
    void fire(action, Boolean(action.confirm) || states[action.id]?.phase === 'confirming');
  }, [card.id, fire, setState, states]);

  if (dismissed) {
    return <div className="sug-card sug-card-dismissed">Suggestion dismissed</div>;
  }

  const anyResolved = card.actions.some((a) => {
    const phase = states[a.id]?.phase;
    return phase === 'done' || phase === 'failed' || phase === 'blocked';
  });
  const anyRunning = card.actions.some((a) => states[a.id]?.phase === 'running');
  // Default is one-shot: the first choice settles the whole card. `multi` scopes
  // that to each button; `sticky` never settles.
  const cardSettled = !card.sticky && !card.multi && anyResolved;

  return (
    <div className={`sug-card${cardSettled ? ' sug-card-settled' : ''}`}>
      {card.title && <div className="sug-card-title">{card.title}</div>}
      {bodyHtml && (
        <div
          className="sug-card-body markdown-body"
          onClick={onContentClick}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      <div className="sug-card-actions">
        {card.actions.map((action) => {
          const state = states[action.id] ?? { phase: 'idle' as Phase };
          const blockedReason = staticBlock(action);
          const resolved = state.phase === 'done' || state.phase === 'failed' || state.phase === 'blocked';
          // `blocked` outranks `sticky`: an unknown or non-invocable tool can
          // only fail again, and re-arming it is how zombie cards happen.
          const disabled = Boolean(blockedReason)
            || state.phase === 'running'
            || state.phase === 'blocked'
            || anyRunning
            || (!card.sticky && (cardSettled || resolved));

          if (state.phase === 'confirming') {
            return (
              <div key={action.id} className="sug-confirm">
                <span className="sug-confirm-text">{state.prompt ?? action.confirm}</span>
                {action.tool && <pre className="sug-confirm-call">{callPreview(action)}</pre>}
                <span className="sug-confirm-buttons">
                  <button
                    className="sug-btn sug-btn-danger"
                    onClick={() => void fire(action, true)}
                  >
                    Confirm
                  </button>
                  <button
                    className="sug-btn"
                    onClick={() => setState(action.id, { phase: 'idle' })}
                  >
                    Cancel
                  </button>
                </span>
              </div>
            );
          }

          if (state.phase === 'blocked' || (resolved && !card.sticky)) {
            return (
              <span
                key={action.id}
                className={`sug-receipt sug-receipt-${state.phase}`}
                title={state.message}
              >
                {state.phase === 'done' ? '✓' : '✗'} {action.label}
                {state.phase !== 'done' && state.message ? `: ${state.message}` : ''}
              </span>
            );
          }

          return (
            <span key={action.id} className="sug-action">
              <button
                className={`sug-btn sug-btn-${action.style}`}
                disabled={disabled}
                title={blockedReason ?? action.tool ?? undefined}
                onClick={() => onClick(action)}
              >
                {state.phase === 'running' ? 'Running…' : action.label}
              </button>
              {/* The op name rides the card FACE, not just a tooltip: the label
                  is the model's prose, the tool is what runs. */}
              {action.tool && <code className="sug-tool">{action.tool}</code>}
              {state.message && (
                <span className={state.phase === 'done' ? 'sug-note-ok' : 'sug-error'}>
                  {state.phase === 'done' ? '✓ ' : ''}{state.message}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
