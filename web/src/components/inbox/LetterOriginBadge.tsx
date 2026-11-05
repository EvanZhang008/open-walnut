/**
 * Who a letter is from, first and in Walnut's own colors (2026-11-04: a task's decision whose
 * subject named a company read as that company's new mail). Every inbox surface leads a letter
 * with this: the envelope row, the reader's head, the session's Inbox tab. Nothing in the inbox is
 * outside mail, and this badge is what says so at a glance: the Walnut mark, the kind (Task,
 * Triage, Walnut, Plugin), and the sender's name. A task's name is its live title.
 *
 * `tests/core/human-inbox/letter-origin-surfaces.test.ts` fails on a letter surface without it.
 */
import { useTaskLabel } from '@/hooks/useEntityLabels';
import { LETTER_ORIGIN_KIND_LABEL, letterOriginOf, type LetterEnvelope } from '@/api/human-inbox';
import { taskPath } from '@/utils/task-path';
import '@/styles/human-inbox.css';

/** The badge's tooltip: what kind of Walnut sender this is, in one sentence. */
const ORIGIN_TITLE: Record<string, (name: string) => string> = {
  task: (name) => `From your Walnut task "${name}"`,
  triage: () => 'From an Inbox Triage run: Walnut\'s summary of mail it read for you',
  session: (name) => `From the Walnut session "${name}"`,
  walnut: () => 'Walnut\'s own notice',
  plugin: (name) => `From the ${name} plugin, inside Walnut`,
  script: () => 'Sent by a script through Walnut\'s API',
};

export function LetterOriginBadge({ letter, variant = 'row', linkTask = false }: {
  letter: Pick<LetterEnvelope, 'sender' | 'origin'>;
  /** `reader` reads "From" before the badge and links the task. */
  variant?: 'row' | 'reader';
  /** Render the task's name as a task link (the reader); a row is one big button already. */
  linkTask?: boolean;
}) {
  const origin = letterOriginOf(letter);
  const live = useTaskLabel(origin.taskId ?? '');
  const name = (origin.kind === 'task' && live?.title?.trim()) || origin.name;
  const kindLabel = LETTER_ORIGIN_KIND_LABEL[origin.kind] ?? 'Walnut';
  // "WALNUT Walnut" says it twice: the mark alone leads a name that is the kind.
  const showKind = kindLabel.toLowerCase() !== name.trim().toLowerCase();
  const title = ORIGIN_TITLE[origin.kind]?.(name) ?? `From ${name}, inside Walnut`;
  return (
    <span
      className={`hib-origin hib-origin--${origin.kind} hib-origin--${variant}`}
      data-testid="letter-origin"
      data-origin-kind={origin.kind}
      title={title}
    >
      {variant === 'reader' && <span className="hib-origin-from">From</span>}
      <span className={`hib-origin-badge${showKind ? '' : ' hib-origin-badge--mark'}`}>
        <img src="/walnut-icon.png" alt="" className="hib-origin-mark" aria-hidden="true" />
        {showKind && <span className="hib-origin-kind">{kindLabel}</span>}
      </span>
      {linkTask && origin.taskId ? (
        <a
          className="hib-origin-name task-link"
          data-task-id={origin.taskId}
          href={taskPath(origin.taskId)}
        >
          {name}
        </a>
      ) : (
        <span className="hib-origin-name">{name}</span>
      )}
    </span>
  );
}
