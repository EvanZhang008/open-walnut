import { useState } from 'react';
import type { CategorySummary } from '@/api/tasks';
import { DatePicker, formatDateTimeDisplay } from '@/components/common/DatePicker';
import { PinTierPicker } from '@/components/common/PinTierPicker';
import {
  PRIORITY_CYCLE,
  PRIORITY_OPTIONS,
  nextValue,
} from '@/components/sessions/task-meta-constants';

export type ConfirmField = 'title' | 'due' | 'start' | 'pin' | 'priority' | 'star' | 'category' | 'project';

export interface ConfirmDraft {
  title: string;
  due?: string;
  start?: string;
  pin?: 'focus' | 'satellite' | 'wait';
  priority?: 'immediate' | 'important' | 'backlog';
  starred: boolean;
  category?: string;
  project?: string;
  aiFields: Set<ConfirmField>;
}

interface Props {
  draft: ConfirmDraft | null;
  rawText: string;
  categories: CategorySummary[] | null;
  projectOptions: Record<string, string[]>;
  submitting: boolean;
  onChange: (patch: Partial<ConfirmDraft>) => void;
  onCreate: () => void;
  onBack: () => void;
  onCreateWithoutAi: () => void;
}

function AiBadge({ visible }: { visible: boolean }) {
  return visible ? <span className="qtc-confirm-ai" aria-label="AI suggested">✦</span> : null;
}

export function QuickTaskConfirm({
  draft,
  rawText,
  categories,
  projectOptions,
  submitting,
  onChange,
  onCreate,
  onBack,
  onCreateWithoutAi,
}: Props) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  // All categories stay selectable (including Inbox) — the empty option means
  // "server default", which is configurable and not necessarily Inbox.
  const categoryOptions = categories ?? [];

  if (!draft) {
    return (
      <div className="qtc-confirm-panel qtc-confirm-skeleton" tabIndex={-1} aria-busy="true">
        <div className="qtc-confirm-analyzing">✦ Analyzing…</div>
        <div className="qtc-confirm-skeleton-row qtc-confirm-skeleton-title" />
        <div className="qtc-confirm-skeleton-row" />
        <div className="qtc-confirm-skeleton-row" />
        <div className="qtc-confirm-footer">
          <button type="button" className="qtc-confirm-primary" onClick={onCreateWithoutAi} disabled={submitting}>
            Create without AI
          </button>
          <button type="button" className="qtc-confirm-back" onClick={onBack} disabled={submitting}>Back</button>
        </div>
      </div>
    );
  }

  const priorityOption = PRIORITY_OPTIONS.find((option) => option.value === draft.priority);
  const priorityLabel = priorityOption ? `${priorityOption.icon} ${priorityOption.label}` : 'No priority';
  const suggestions = projectOptions[draft.category || 'Inbox'] ?? [];
  const titleChanged = draft.title.trim() !== rawText.trim();

  return (
    <div
      className="qtc-confirm-panel"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (datePickerOpen || startPickerOpen)) {
          event.preventDefault();
          event.stopPropagation();
          setDatePickerOpen(false);
          setStartPickerOpen(false);
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
          onChange={(event) => onChange({ title: event.target.value })}
        />
        {titleChanged && <span className="qtc-confirm-was">was: &quot;{rawText}&quot;</span>}
      </label>

      <div className="qtc-confirm-field">
        <span className="qtc-confirm-label">Details</span>
        <div className="qtc-chips qtc-confirm-chips">
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('due') ? ' qtc-chip-ai' : ''}`}
            disabled={submitting}
            onClick={() => { setStartPickerOpen(false); setDatePickerOpen((open) => !open); }}
          >
            {draft.due ? `Due ${formatDateTimeDisplay(draft.due)}` : 'No due'} <AiBadge visible={draft.aiFields.has('due')} />
          </button>
          <button
            type="button"
            className={`qtc-chip${draft.aiFields.has('start') ? ' qtc-chip-ai' : ''}`}
            disabled={submitting}
            onClick={() => { setDatePickerOpen(false); setStartPickerOpen((open) => !open); }}
          >
            {draft.start ? `Start ${formatDateTimeDisplay(draft.start)}` : 'No start'} <AiBadge visible={draft.aiFields.has('start')} />
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
          <span className="qtc-confirm-label">Category <AiBadge visible={draft.aiFields.has('category')} /></span>
          {/* key forces a remount when categories arrive: React won't re-apply an
              unchanged controlled value to a <select> whose matching option appeared
              later, leaving the DOM stuck on the placeholder. The fallback option
              covers a draft.category seeded before the fetch resolves. */}
          <select
            key={categories ? 'loaded' : 'loading'}
            className="qtc-confirm-select"
            value={draft.category ?? ''}
            disabled={submitting}
            onChange={(event) => onChange({ category: event.target.value || undefined, project: undefined })}
          >
            <option value="">Default</option>
            {draft.category && !categoryOptions.some((category) => category.name === draft.category) && (
              <option value={draft.category}>{draft.category}</option>
            )}
            {categoryOptions.map((category) => <option key={category.name} value={category.name}>{category.name}</option>)}
          </select>
        </label>
        <label className="qtc-confirm-field">
          <span className="qtc-confirm-label">Project <AiBadge visible={draft.aiFields.has('project')} /></span>
          <input
            className="qtc-confirm-input qtc-confirm-project"
            value={draft.project ?? ''}
            list="qtc-project-options"
            disabled={submitting}
            placeholder="Default"
            onChange={(event) => onChange({ project: event.target.value })}
          />
          <datalist id="qtc-project-options">
            {suggestions.map((project) => <option key={project} value={project} />)}
          </datalist>
        </label>
      </div>

      <div className="qtc-confirm-footer">
        <button type="button" className="qtc-confirm-primary" disabled={submitting || !draft.title.trim()} onClick={onCreate}>
          {submitting ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="qtc-confirm-back" disabled={submitting} onClick={onBack}>Back</button>
        <span className="qtc-confirm-key-hint">Enter to create · Esc to edit text</span>
      </div>
    </div>
  );
}
