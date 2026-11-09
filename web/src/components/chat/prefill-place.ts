/**
 * Where an external prefill lands in what is already typed (ChatInput's prefill
 * effect). Pure, so the order rules are tested without a browser.
 *
 *   replace     the prefill alone; what was typed goes
 *   keep-draft  the prefill first, the typed sentence after it (an injected block)
 *   append      the typed sentence, then the prefill (a reference joins the sentence)
 *   stack       a quote from the transcript's Quote / Comment: the first one leads
 *               the message like keep-draft; once the box holds a quote, each new
 *               one goes at the END, so quotes and their comments read in the order
 *               they were added, however many the user collects before sending
 *   attach      a block added from beside the chat (terminal output): always after
 *               what is typed, as its own paragraph, so blocks read in the order added
 */
export type PrefillMode = 'replace' | 'keep-draft' | 'append' | 'stack' | 'attach';

export interface PlacedPrefill {
  text: string;
  /** 'block': the caret goes to the end of the prefill; 'end': the end of the text. */
  caret: 'block' | 'end';
}

const HOLDS_QUOTE = /^>/m;
/** A `> npm test` inside a code fence is not a quote. */
const FENCED = /^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm;

function holdsQuote(text: string): boolean {
  return HOLDS_QUOTE.test(text.replace(FENCED, ''));
}

export function placePrefill(mode: PrefillMode, typed: string, prefill: string): PlacedPrefill {
  if (mode === 'replace') return { text: prefill, caret: 'block' };
  if (mode === 'append') {
    const head = typed.replace(/\s+$/, '');
    return { text: head ? `${head} ${prefill}` : prefill, caret: 'end' };
  }
  if (mode === 'attach') {
    const head = typed.replace(/\s+$/, '');
    return { text: head ? `${head}\n\n${prefill}` : prefill, caret: 'end' };
  }
  if (mode === 'stack' && holdsQuote(typed)) {
    return { text: `${typed.replace(/\s+$/, '')}\n\n${prefill}`, caret: 'end' };
  }
  const tail = typed.trimStart();
  return { text: tail ? `${prefill}${tail}` : prefill, caret: 'block' };
}
