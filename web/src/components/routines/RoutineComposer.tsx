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
];

interface RoutineComposerProps {
  onDraft: (draft: CreateRoutineInput) => void;
  /** Fall back to a manual empty form when drafting fails. */
  onDraftFailed: (error: string) => void;
}

export function RoutineComposer({ onDraft, onDraftFailed }: RoutineComposerProps) {
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
