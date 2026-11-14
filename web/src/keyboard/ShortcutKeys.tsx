/** A shortcut row's keys as key caps, with the word between alternatives: the sheet and Settings. */
import type { ShortcutRow } from './shortcuts';

export function ShortcutKeys({ row, as: Tag = 'span' }: { row: Pick<ShortcutRow, 'keys' | 'sep'>; as?: 'span' | 'dd' }) {
  return (
    <Tag className="shortcuts-help-keys">
      {row.keys.map((chord, i) => (
        <span key={i} className="shortcuts-help-chord">
          {i > 0 && <span className="shortcuts-help-sep">{row.sep ?? 'or'}</span>}
          {chord.map((key, j) => <kbd key={j}>{key}</kbd>)}
        </span>
      ))}
    </Tag>
  );
}
