/**
 * Every <MicInput> in web/src, read from the AST with what the send-waits ratchet needs to judge it
 * (tests/web/send-waits-for-dictation-ratchet.test.ts): its key, the attributes that decide how its
 * words leave the box (micRef, onEnter, onKeyDown, onBlur, a spread of a hook's props), and the
 * functions those attributes run.
 */
import ts from 'typescript';

export interface MicInputUse {
  /** `file|MicInput <attr>=<value>`, a repeated signature gets `#2`, `#3`. */
  key: string;
  line: number;
  /** Attribute name to its value as written (`"x"` or the expression); spreads as `...expr`. */
  attrs: Map<string, string>;
  spreads: string[];
}

const SIGNATURE_ATTRS = ['data-testid', 'id', 'aria-label', 'placeholder', 'className'];
/** MicInput, and SearchField (a MicInput drawn as the one search field): both are judged as `MicInput`. */
const MIC_INPUT_TAGS = new Set(['MicInput', 'SearchField']);

function valueText(init: ts.JsxAttributeValue | undefined): string {
  if (!init) return 'true';
  if (ts.isStringLiteral(init)) return JSON.stringify(init.text);
  if (ts.isJsxExpression(init) && init.expression) return init.expression.getText();
  return '';
}

export function micInputsOf(file: string, source: string): MicInputUse[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: MicInputUse[] = [];
  const seen = new Map<string, number>();
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && MIC_INPUT_TAGS.has(n.tagName.getText())) {
      const attrs = new Map<string, string>();
      const spreads: string[] = [];
      for (const p of n.attributes.properties) {
        if (ts.isJsxAttribute(p)) attrs.set(p.name.getText(), valueText(p.initializer));
        else if (ts.isJsxSpreadAttribute(p)) spreads.push(p.expression.getText());
      }
      const name = SIGNATURE_ATTRS.find((a) => attrs.has(a));
      const signature = name ? `MicInput ${name}=${attrs.get(name)!.replace(/\s+/g, ' ')}` : 'MicInput';
      const count = (seen.get(signature) ?? 0) + 1;
      seen.set(signature, count);
      out.push({
        key: `${file}|${signature}${count > 1 ? `#${count}` : ''}`,
        line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
        attrs,
        spreads,
      });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Names of the gates in a file: `const <name> = useSendAfterDictation(`. */
export function gateNames(source: string): Set<string> {
  return new Set([...source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*useSendAfterDictation\(/g)].map((m) => m[1]));
}

/** Functions a handler's text runs or binds: `x`, `() => x()`, `{ void x(); }`. Setters and DOM calls are not submits. */
export function submitNames(handler: string, declared: Set<string>): string[] {
  const out = new Set<string>();
  const bare = handler.trim().match(/^([A-Za-z_$][\w$]*)$/);
  if (bare) out.add(bare[1]);
  for (const m of handler.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  return [...out].filter((n) => declared.has(n) && !/^set[A-Z]/.test(n));
}

/** Functions the file declares (`const x = (`, `const x = async (`, `const x = useCallback(`, `function x(`). */
export function declaredFunctions(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  for (const m of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*use(?:Callback|LeanCallback)\(/g)) out.add(m[1]);
  for (const m of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) out.add(m[1]);
  return out;
}

/**
 * The places a button or form runs `name` directly: `onClick={name}`, `onClick={() => void name()}`,
 * `onSubmit={(e) => { ...; name(); }}` and the like. These are the external submits a box's mic must
 * be waited on by.
 */
export function directSubmits(source: string, name: string): string[] {
  const out: string[] = [];
  const esc = name.replace(/\$/g, '\\$');
  for (const m of source.matchAll(/\b(onClick|onSubmit|onPointerUp|onMouseUp)=\{/g)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (let i = end; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { end = i; break; }
    }
    const value = source.slice(m.index! + m[0].length, end);
    if (new RegExp(`^\\s*${esc}\\s*$|(?<![\\w$.])${esc}\\s*\\(`).test(value)) out.push(`${m[1]}={${value.replace(/\s+/g, ' ').trim()}}`);
  }
  return out;
}

/** Every `onClick` / `onSubmit` (and pointer-up) attribute value in the file, as written. */
export function pressHandlers(source: string): Array<{ attr: string; value: string }> {
  const out: Array<{ attr: string; value: string }> = [];
  for (const m of source.matchAll(/\b(onClick|onSubmit|onPointerUp|onMouseUp)=\{/g)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (let i = end; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { end = i; break; }
    }
    out.push({ attr: m[1], value: source.slice(m.index! + m[0].length, end).replace(/\s+/g, ' ').trim() });
  }
  return out;
}
