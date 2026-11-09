/** A path or branch that may wrap only after a separator (/ - _ .), never mid-word. */
import { Fragment } from 'react';

export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[/\-_.])/);
  return <>{parts.map((p, i) => <Fragment key={i}>{p}{i < parts.length - 1 && <wbr />}</Fragment>)}</>;
}
