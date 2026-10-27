/**
 * A person's own `<system-reminder>` in their bubble shows as typed: outside code it
 * would reach the markdown renderer as a tag, which the sanitizer drops (leaving only
 * its contents). Inside a code span or fence it already shows literally, so it is left
 * alone there. Pure: tests/web/hint-display.test.ts.
 */
import { escapeHintTags } from '@open-walnut/hint-format';

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

export function showHintTagsAsTyped(text: string): string {
  if (!/system-reminder/i.test(text)) return text;
  return text.split(CODE).map((part, i) => (i % 2 === 1 ? part : escapeHintTags(part))).join('');
}
