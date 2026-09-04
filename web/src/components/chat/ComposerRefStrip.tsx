/**
 * ComposerRefStrip — the pills for every entity reference currently in the
 * composer text, shown above the textarea (same slot as image previews).
 *
 * The textarea is plain text, so a picked reference sits in it as the literal
 * `<task-ref id="…" label="…"/>` tag. That is what the CLI receives and what
 * the bubble renders as a pill, but it is not pleasant to read while typing.
 * This strip is the readable view: one pill per tag, current title from the
 * entity-label store when known (a rename shows through), × removes the tag
 * from the text. Purely derived from `value`; it holds no state of its own.
 */
import { useMemo } from 'react';
import { extractEntityRefs } from '@/utils/entity-ref-tags';
import { lookupSessionTitle, peekTaskLabel } from '@/stores/entity-label-store';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';

interface ComposerRefStripProps {
  value: string;
  /** Remove the [start, end) span (the tag plus one trailing space if present). */
  onRemove: (start: number, end: number) => void;
}

const KIND_GLYPH = { task: '▢', session: '●', project: '▣' } as const;

export function ComposerRefStrip({ value, onRemove }: ComposerRefStripProps) {
  // Re-derive titles when the label store learns something new.
  const labelsVersion = useEntityLabelsVersion();
  const refs = useMemo(() => extractEntityRefs(value), [value]);
  const pills = useMemo(() => refs.map((r) => {
    let title = r.label || r.id;
    if (r.kind === 'task') title = peekTaskLabel(r.id)?.title ?? title;
    else if (r.kind === 'session') title = lookupSessionTitle(r.id) ?? title;
    return { ...r, title };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [refs, labelsVersion]);

  if (pills.length === 0) return null;
  return (
    <div className="composer-refs" aria-label="References in this message">
      {pills.map((p) => (
        <span key={`${p.kind}:${p.id}:${p.start}`} className={`composer-ref composer-ref-${p.kind}`} title={`${p.kind}: ${p.id}`}>
          <span className="composer-ref-glyph" aria-hidden="true">{KIND_GLYPH[p.kind]}</span>
          <span className="composer-ref-title">{p.title}</span>
          <button
            type="button"
            className="composer-ref-remove"
            aria-label={`Remove reference to ${p.title}`}
            onMouseDown={(e) => { e.preventDefault(); }}
            onClick={() => {
              // Swallow ONE trailing space so removing a pill doesn't leave a
              // double space behind in the sentence.
              const end = value[p.end] === ' ' ? p.end + 1 : p.end;
              onRemove(p.start, end);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
