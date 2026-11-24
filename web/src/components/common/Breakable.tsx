/**
 * A path or branch that may wrap only after a separator (/ - _), never mid-word. Never after a
 * dot: that would split a file name from its extension (`settings.` | `json`).
 */
import { Fragment } from 'react';

export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/\-_])/);
  return <>{parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <wbr />}</Fragment>)}</>;
}
