const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ',
};

/** Text extraction only: no DOM, execution, fetching or recursion on outside markup. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table|section|article)\s*>/gi, '\n')
    .replace(/<(li|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-zA-Z]+|#\d{1,6});/g, (whole, name: string) => {
      const named = ENTITIES[name.toLowerCase()] ?? ENTITIES[name];
      if (named !== undefined) return named;
      if (name.startsWith('#')) {
        const code = Number(name.slice(1));
        return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return whole;
    })
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prefer the actual text part, converting HTML only when that part is empty. */
export function plainTextOf(body: { text?: string; html?: string }): string {
  if (body.text && body.text.trim()) return body.text;
  return body.html ? htmlToText(body.html) : '';
}
