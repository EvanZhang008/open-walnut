/**
 * ComposerRefStrip: one full-width row per entity reference attached to the
 * message being composed, shown above the textarea (same slot as image
 * previews).
 *
 * The tags live in ChatInput's `refs` state, never in the textarea: the box
 * holds prose only and the message is composed at send time (see
 * composer-refs.ts). This strip is the whole UI for them: the readable title
 * (current one from the entity-label store when known, so a rename shows
 * through) and an × that detaches that reference. Purely derived from the tags
 * it is handed; it holds no state of its own.
 */
import { useMemo } from 'react';
import { extractEntityRefs, type EntityRefKind } from '@/utils/entity-ref-tags';
import { lookupSessionTitle, peekTaskLabel } from '@/stores/entity-label-store';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';

interface ComposerRefStripProps {
  /** The tag strings, in order. */
  tags: string[];
  /** Detach the reference at this index. */
  onRemove: (index: number) => void;
}

const KIND_GLYPH = { task: '▢', session: '●', project: '▣' } as const;

interface Pill {
  kind: EntityRefKind;
  id: string;
  title: string;
  /** Position in `tags`, which is what × removes. */
  index: number;
}

/** One tag → one row, titled from the label store when it knows better. */
function pillFor(tag: string, index: number): Pill | null {
  const r = extractEntityRefs(tag)[0];
  if (!r) return null;
  let title = r.label || r.id;
  if (r.kind === 'task') title = peekTaskLabel(r.id)?.title ?? title;
  else if (r.kind === 'session') title = lookupSessionTitle(r.id) ?? title;
  return { kind: r.kind, id: r.id, title, index };
}

export function ComposerRefStrip({ tags, onRemove }: ComposerRefStripProps) {
  // Re-derive titles when the label store learns something new.
  const labelsVersion = useEntityLabelsVersion();
  const pills = useMemo(
    () => tags.map(pillFor).filter((p): p is Pill => p !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tags, labelsVersion],
  );

  if (pills.length === 0) return null;
  return (
    <div className="composer-refs" aria-label="References in this message">
      {pills.map((p) => (
        <span key={`${p.kind}:${p.id}`} className={`composer-ref composer-ref-${p.kind}`} title={`${p.kind}: ${p.id}`}>
          <span className="composer-ref-glyph" aria-hidden="true">{KIND_GLYPH[p.kind]}</span>
          <span className="composer-ref-title">{p.title}</span>
          <button
            type="button"
            className="composer-ref-remove"
            aria-label={`Remove reference to ${p.title}`}
            onMouseDown={(e) => { e.preventDefault(); }}
            onClick={() => onRemove(p.index)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
