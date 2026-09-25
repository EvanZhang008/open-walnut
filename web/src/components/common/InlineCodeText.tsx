import { Fragment } from 'react';
import { splitInlineCode } from '@/utils/local-claude-banner';

/** A server sentence whose `backticked` parts render as code ("Run `claude` once ..."). */
export function InlineCodeText({ text }: { text: string }) {
  return (
    <>
      {splitInlineCode(text).map((part, i) => (part.code ? <code key={i}>{part.text}</code> : <Fragment key={i}>{part.text}</Fragment>))}
    </>
  );
}
