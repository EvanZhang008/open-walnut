import { useState } from 'react';
import { draftRoutine } from '@/api/routines';
import type { CreateRoutineInput } from '@/api/routines';

const TEMPLATES: Array<{ label: string; text: string }> = [
  {
    label: 'Morning briefing',
    text: 'Every weekday at 7:30am, generate a briefing to help me catch up: schedule, important emails, messages requiring response, and pending action items. Keep it concise and scannable.',
  },
  {
    label: 'Weekday PR summary',
    text: 'Summarize all open pull requests every weekday at 9am: title, author, how long open, which are waiting for review or have failing CI. One line per PR.',
  },
  {
    label: 'Daily repo health check',
    text: 'Every day at 8am, run in my main repo with Claude Code: check for failing tests, uncommitted changes, and stale branches, then write a short status report.',
  },
  {
    label: 'Watch my mail',
    text: 'Every 10 minutes, check my unread mail. If something needs a reply or an action from me, make a task for it and tell me. Ignore newsletters, notifications and anything automated. If there is nothing new, do nothing.',
  },
];

interface RoutineComposerProps {
  onDraft: (draft: CreateRoutineInput) => void;
  /** Fall back to a manual empty form when drafting fails. */
  onDraftFailed: (error: string) => void;
  /** Open the empty form directly, without asking the model first. */
  onManual: () => void;
}

export function RoutineComposer({ onDraft, onDraftFailed, onManual }: RoutineComposerProps) {
  const [text, setText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDraft() {
    if (!text.trim() || drafting) return;
    setDrafting(true);
    setError(null);
    try {
      const draft = await draftRoutine(text);
      onDraft(draft);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Draft failed';
      setError(msg);
      onDraftFailed(msg);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <div className="routine-composer">
      <textarea
        className="routine-composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleDraft();
        }}
        placeholder="What do you want automated?"
        rows={2}
        disabled={drafting}
      />
      <div className="routine-composer-templates">
        {TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            className="routine-template-chip"
            onClick={() => setText(t.text)}
            disabled={drafting}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <div className="cron-form-error text-xs">{error} — fill the form manually below.</div>}
      <div className="routine-composer-actions">
        {/* The manual path is a FIRST-CLASS button, not a fallback the user
            reaches by making the model fail. Also the only path that works with
            no provider configured. */}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onManual}
          disabled={drafting}
        >
          Build it myself
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleDraft}
          disabled={!text.trim() || drafting}
        >
          {drafting ? 'Drafting…' : 'Draft routine'}
        </button>
      </div>
    </div>
  );
}
