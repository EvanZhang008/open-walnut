import { useState } from 'react';
import { DatePicker, formatDateTimeDisplay } from '@/components/common/DatePicker';
import { PinTierPicker } from '@/components/common/PinTierPicker';
import {
  PRIORITY_CYCLE,
  PRIORITY_OPTIONS,
  nextValue,
} from '@/components/sessions/task-meta-constants';

export type ConfirmField = 'title' | 'due' | 'start' | 'end' | 'pin' | 'priority' | 'star' | 'project';

export interface ConfirmDraft {
  title: string;
  due?: string;
  start?: string;
  /** End of the working block (start→end). Independent of the due deadline. */
  end?: string;
  /** Built-in tier name or a custom tier id (`ct_*`). */
  pin?: string;
  priority?: 'immediate' | 'important' | 'backlog';
  starred: boolean;
  /** Target project. Empty/undefined = Inbox. */
  project?: string;
  /** The AI invented this project name — it doesn't exist yet. Drives the "new" badge. */
  projectIsNew?: boolean;
  aiFields: Set<ConfirmField>;
}

interface Props {
  draft: ConfirmDraft;
  /** The sentence in the NL input above — drives the "was:" line under an AI-rewritten title. */
  rawText: string;
  /**
   * Flat list of existing project names (Project is the single grouping layer).
   * MUST come from the project REGISTRY (`useProjectRegistry`), not from the
   * loaded task list: an existing-but-empty project mentions no task, so a
   * task-derived list makes it look new and the "new" badge below lies.
   */
  projectOptions: string[];
  submitting: boolean;
  onChange: (patch: Partial<ConfirmDraft>) => void;
  onCreate: () => void;
}

function AiBadge({ visible }: { visible: boolean }) {
  return visible ? <span className="qtc-confirm-ai" aria-label="AI suggested">✦</span> : null;
}

/**
 * The always-visible task form. Nothing here waits on the AI: every field is
 * directly editable from the moment the composer opens, and the background
 * parse back-fills fields (✦-badged) only where the user hasn't typed.
 */
export function QuickTaskConfirm({
  draft,
  rawText,
  projectOptions,
  submitting,
  onChange,
  onCreate,
}: Props) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [endPickerOpen, setEndPickerOpen] = useState(false);

  const priorityOption = PRIORITY_OPTIONS.find((option) => option.value === draft.priority);
  const priorityLabel = priorityOption ? `${priorityOption.icon} ${priorityOption.label}` : 'No priority';
  // Badge a project the AI invented, but only while it's still absent from the
  // known list — the moment the user picks an existing name it isn't new anymore.
  const showNewProjectBadge = !!draft.projectIsNew
    && !!draft.project?.trim()
    && !projectOptions.some((p) => p.toLowerCase() === draft.project!.trim().toLowerCase());

  return (
    <div
      className="qtc-confirm-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (datePickerOpen || startPickerOpen || endPickerOpen)) {
          event.preventDefault();
          event.stopPropagation();
          setDatePickerOpen(false);
          setStartPickerOpen(false);
          setEndPickerOpen(false);
        }
      }}
    >
      <label className="qtc-confirm-field qtc-confirm-title-field">
        <span className="qtc-confirm-label">Title <AiBadge visible={draft.aiFields.has('title')} /></span>
        <input
          className="qtc-confirm-input qtc-confirm-title"
          value={draft.title}
          maxLength={500}
          disabled={submitting}
          placeholder="Task title"
          onChange={(event) => onChange({ title: event.target.value })}
        />
        {draft.aiFields.has('title') && !!rawText.trim() && (
          <span className="qtc-confirm-was">was: &quot;{rawText}&quot;</span>
        )}
      </label>

      <div className="qtc-confirm-field">
        <span className="qtc-confirm-label">Details</span>
        <div className="qtc-chips qtc-confirm-chips">
          {/* Calendar semantics: Start is the primary date and leads; the
              due/end date is usually empty, so its empty state is a low-key
              "+ Due" ghost rather than a full chip. */}
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('start') ? ' qtc-chip-ai' : ''}`}
            disabled={submitting}
            onClick={() => { setDatePickerOpen(false); setEndPickerOpen(false); setStartPickerOpen((open) => !open); }}
          >
            {draft.start ? `Start ${formatDateTimeDisplay(draft.start)}` : 'No start'} <AiBadge visible={draft.aiFields.has('start')} />
          </button>
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('end') ? ' qtc-chip-ai' : ''}${!draft.end ? ' qtc-chip-ghost' : ''}`}
            disabled={submitting}
            onClick={() => { setDatePickerOpen(false); setStartPickerOpen(false); setEndPickerOpen((open) => !open); }}
          >
            {draft.end ? `End ${formatDateTimeDisplay(draft.end)}` : '+ End'} <AiBadge visible={draft.aiFields.has('end')} />
          </button>
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('due') ? ' qtc-chip-ai' : ''}${!draft.due ? ' qtc-chip-ghost' : ''}`}
            disabled={submitting}
            onClick={() => { setStartPickerOpen(false); setEndPickerOpen(false); setDatePickerOpen((open) => !open); }}
          >
            {draft.due ? `Due ${formatDateTimeDisplay(draft.due)}` : '+ Due'} <AiBadge visible={draft.aiFields.has('due')} />
          </button>
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('priority') ? ' qtc-chip-ai' : ''}`}
            disabled={submitting}
            onClick={() => onChange({ priority: nextValue(PRIORITY_CYCLE, draft.priority) as ConfirmDraft['priority'] })}
          >
            {priorityLabel} <AiBadge visible={draft.aiFields.has('priority')} />
          </button>
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('star') ? ' qtc-chip-ai' : ''}`}
            disabled={submitting}
            onClick={() => onChange({ starred: !draft.starred })}
          >
            {draft.starred ? '★ Starred' : '☆ Star'} <AiBadge visible={draft.aiFields.has('star')} />
          </button>
        </div>
        {datePickerOpen && (
          <div className="qtc-date-picker">
            <DatePicker inline date={draft.due} onChange={(due) => onChange({ due: due ?? undefined })} />
          </div>
        )}
        {startPickerOpen && (
          <div className="qtc-date-picker">
            <DatePicker inline date={draft.start} onChange={(start) => onChange({ start: start ?? undefined })} />
          </div>
        )}
        {endPickerOpen && (
          <div className="qtc-date-picker">
            <DatePicker inline date={draft.end} onChange={(end) => onChange({ end: end ?? undefined })} />
          </div>
        )}
      </div>

      {/* Pinned area — its OWN labelled field, not a chip in Details. Which tier
          a task lands in decides whether the user ever sees it again, so it gets
          the same always-visible three-button row as the session launcher
          instead of a chip you had to click up to three times to read. */}
      <div className="qtc-confirm-field">
        <span className="qtc-confirm-label">
          Pinned <AiBadge visible={draft.aiFields.has('pin')} />
        </span>
        <PinTierPicker
          value={draft.pin}
          disabled={submitting}
          onChange={(pin) => onChange({ pin })}
        />
      </div>

      <div className="qtc-confirm-grid">
        <label className="qtc-confirm-field">
          <span className="qtc-confirm-label">
            Project <AiBadge visible={draft.aiFields.has('project')} />
            {showNewProjectBadge && <span className="qtc-confirm-new" title="This project doesn't exist yet — it will be created">new</span>}
          </span>
          <input
            className="qtc-confirm-input qtc-confirm-project"
            value={draft.project ?? ''}
            list="qtc-project-options"
            disabled={submitting}
            placeholder="Inbox"
            onChange={(event) => onChange({ project: event.target.value })}
          />
          <datalist id="qtc-project-options">
            {projectOptions.map((project) => <option key={project} value={project} />)}
          </datalist>
        </label>
      </div>

      <div className="qtc-confirm-footer">
        <button type="button" className="qtc-confirm-primary" disabled={submitting || !draft.title.trim()} onClick={onCreate}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
        <span className="qtc-confirm-key-hint">Enter to create · Esc to close</span>
      </div>
    </div>
  );
}
