import { Fragment } from 'react';

/** The rule lines whose tail is a command (claude-permission-options.ts describeRule). */
const COMMAND_LINE = /^(Bash commands starting with |Bash command: |Part of this command: )([\s\S]+)$/;

/**
 * A remembering choice's rule, one line per rule, with the command part set as code:
 * in "Bash commands starting with npm test" the reader sees where the prefix ends.
 */
export function RuleDetail({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => {
        const m = COMMAND_LINE.exec(line);
        return (
          <Fragment key={i}>
            {i > 0 && '\n'}
            {m ? <>{m[1]}<code className="perm-rule-code">{m[2]}</code></> : line}
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * An answer line with the person's note set apart: in italics, without the quote
 * marks around it, so a note that holds its own quotes never ends in a stack of them.
 */
export function AnswerText({ text }: { text: string | null }) {
  if (!text) return null;
  const open = text.indexOf('\u201C');
  const close = text.lastIndexOf('\u201D');
  if (open < 0 || close <= open) return <>{text}</>;
  const before = text.slice(0, open);
  return (
    <>
      {/note $/.test(before) ? `${before.trimEnd()}: ` : before}
      <em className="answer-note">{text.slice(open + 1, close)}</em>
      {text.slice(close + 1)}
    </>
  );
}

/** A choice that writes its rule into a settings file: marked so, beside a choice that only lasts the session. */
export function SavedFileMark() {
  return (
    <svg className="perm-saved-mark" width="11" height="11" viewBox="0 0 12 12" aria-label="Saved to a settings file" role="img">
      <path d="M2.5 1h5l2.5 2.5V11h-7.5z M7.5 1v2.5H10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}
