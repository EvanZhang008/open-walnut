import { Tokenizer } from 'htmlparser2';
import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { decodeHTMLAttribute } from 'entities';
import { createAgentHtmlSecurity } from './agent-html-security';

export interface BoardSummaryText {
  text: string;
  start: number;
  end: number;
  raw: string;
  textStart: number;
}

export function boardSummaryRange(summary: BoardSummaryText, start: number, end: number): { start: number; end: number } | null {
  let decoded = 0, foundStart: number | undefined, foundEnd: number | undefined;
  const take = (text: string, rawStart: number, rawEnd: number) => {
    const after = decoded + text.length;
    if (foundStart === undefined && start >= decoded && start < after) foundStart = rawStart;
    if (end > decoded && end <= after) foundEnd = rawEnd;
    decoded = after;
  };
  for (let i = 0; i < summary.raw.length;) {
    const at = i;
    if (summary.raw[i] === '&') {
      let emitted = '';
      const decoder = new EntityDecoder(htmlDecodeTree, (cp) => { emitted += String.fromCodePoint(cp); });
      decoder.startEntity(DecodingMode.Attribute);
      let consumed = decoder.write(summary.raw, i + 1);
      if (consumed < 0) consumed = decoder.end();
      if (consumed > 0) { i += consumed; take(emitted, at, i); continue; }
    }
    let text = summary.raw[i]!;
    i++;
    if (text === '\r') { if (summary.raw[i] === '\n') i++; text = '\n'; }
    else if (text === '\0') text = String.fromCodePoint(0xfffd);
    take(text, at, i);
  }
  return foundStart === undefined || foundEnd === undefined ? null
    : { start: summary.textStart + foundStart, end: summary.textStart + foundEnd };
}

export function boardSummaryTexts(html: string): BoardSummaryText[] {
  const summaries: BoardSummaryText[] = [];
  const parser = createAgentHtmlSecurity({
    scriptingEnabled: true,
    onOutput: () => {},
    onTag: (name, start, end, closing, linkable) => {
      if (name !== 'walnut-choice' || closing || !linkable) return;
      const tag = html.slice(start, end);
      let attrName = '', nameEnd = 0, seen = false;
      const tokenizer = new Tokenizer({ xmlMode: false, decodeEntities: false }, {
        onattribname: (s, e) => { attrName = tag.slice(s, e).toLowerCase(); nameEnd = e; },
        onattribend: (_quote, e) => {
          if (attrName !== 'summary' || seen) return;
          seen = true;
          const lead = /^\s*=\s*/.exec(tag.slice(nameEnd, e));
          if (!lead) return;
          const valueStart = nameEnd + lead[0].length;
          const raw = tag.slice(valueStart, e);
          const quoted = raw[0] === '"' || raw[0] === "'";
          const value = quoted ? raw.slice(1, -1) : raw;
          summaries.push({
            text: decodeHTMLAttribute(value.replace(/\r\n?/g, '\n').replace(/\u0000/g, String.fromCodePoint(0xfffd))),
            start: start + valueStart,
            end: start + e,
            raw: value,
            textStart: start + valueStart + (quoted ? 1 : 0),
          });
        },
        ontext: () => {}, ontextentity: () => {}, onopentagname: () => {},
        onattribdata: () => {}, onattribentity: () => {}, onopentagend: () => {},
        onselfclosingtag: () => {}, onclosetag: () => {}, oncomment: () => {},
        oncdata: () => {}, ondeclaration: () => {}, onprocessinginstruction: () => {}, onend: () => {},
      });
      tokenizer.write(tag);
      tokenizer.end();
    },
  });
  parser.write(html);
  parser.end();
  return summaries;
}
