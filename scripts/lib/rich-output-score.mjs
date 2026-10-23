/**
 * Scores one model reply against the rich-output rules (pure, no I/O).
 *
 * Used by scripts/rich-output-eval.mjs. Global checks run on every reply; a case's
 * `expect` adds the shape the question calls for. A check is `fail` (the case
 * fails) or `warn` (reported, never fails the case).
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*$/;

/** Fence languages that hold real code, where `->` or `-->` is syntax, not a drawing. */
const CODE_LANGS = new Set([
  'c', 'cc', 'cpp', 'c++', 'h', 'hpp', 'cs', 'go', 'rs', 'rust', 'java', 'kt', 'kotlin', 'swift', 'scala',
  'js', 'jsx', 'mjs', 'cjs', 'javascript', 'ts', 'tsx', 'typescript', 'py', 'python', 'rb', 'ruby', 'php',
  'sh', 'bash', 'zsh', 'shell', 'console', 'ps1', 'powershell', 'sql', 'json', 'jsonc', 'yaml', 'yml', 'toml',
  'ini', 'xml', 'html', 'css', 'scss', 'diff', 'patch', 'makefile', 'make', 'dockerfile', 'lua', 'r', 'dart',
  'elixir', 'ex', 'erlang', 'haskell', 'hs', 'ocaml', 'ml', 'clojure', 'zig', 'nim', 'proto', 'graphql', 'gql',
]);

/** Split a reply into fenced blocks (with their language) and the text outside them. */
export function splitFences(text) {
  const fences = [];
  const outside = [];
  let open = null;
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line);
    if (open) {
      if (m && m[1][0] === open.marker[0] && m[1].length >= open.marker.length && !m[2]) {
        fences.push({ lang: open.lang, body: open.lines.join('\n') });
        open = null;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    if (m) {
      open = { marker: m[1], lang: m[2].toLowerCase(), lines: [] };
      continue;
    }
    outside.push(line);
  }
  if (open) fences.push({ lang: open.lang, body: open.lines.join('\n'), unclosed: true });
  return { fences, outside: outside.join('\n') };
}

const BOX_CORNERS = /[\u250c\u2510\u2514\u2518\u256d\u256e\u256f\u2570\u2554\u2557\u255a\u255d\u250f\u2513\u2517\u251b]/;
const DRAWN_ARROW = /(?:[\u2500\u2501\u2550-]{2,}\s*[\u25b6\u25ba>\u2192\u27f6]|[\u25c0\u25c4<\u2190\u27f5]\s*[\u2500\u2501\u2550-]{2,}|[\u25b2\u25bc\u2191\u2193]|[\u25b6\u25ba\u2192\u27f6\u25c0\u25c4\u2190]\s*$)/m;
const TREE_LINE = /^\s*(?:[\u2502|]\s*)*[\u251c\u2514]\u2500\u2500/m;

/** A fence that draws boxes or arrows instead of holding code (file trees excepted). */
export function isAsciiDiagramFence(fence) {
  if (CODE_LANGS.has(fence.lang)) return false;
  // A file tree's last-entry glyph (U+2514) is also a box corner, so tree lines are set aside first.
  const rest = fence.body.split('\n').filter((l) => !TREE_LINE.test(l)).join('\n');
  return BOX_CORNERS.test(rest) || DRAWN_ARROW.test(rest);
}

export function isFileTreeFence(fence) {
  return TREE_LINE.test(fence.body);
}

const HTML_TAG = /<(?:div|span|svg|table|details|summary|section|p|b|strong|br|style|ul|ol|li|h[1-6]|pre)\b[^>]*>/i;

function svgRoots(outside) {
  return [...outside.matchAll(/<svg\b([^>]*)>/gi)].map((m) => m[1]);
}

/** Root svg must scale with the column: a viewBox, and no fixed pixel width without a cap. */
function svgSizeProblems(attrs) {
  const problems = [];
  if (!/\bviewBox\s*=/i.test(attrs)) problems.push('no viewBox');
  // A pixel width ("660", "660px"); "100%" is fluid and is not matched.
  const width = /\bwidth\s*=\s*["']?\s*(\d+(?:\.\d+)?)(?:px)?\s*(?=["'\s>/]|$)/i.exec(attrs);
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const styleText = style ? (style[1] ?? style[2] ?? '') : '';
  const capped = /max-width\s*:/i.test(styleText) || /(?:^|;)\s*width\s*:\s*100%/i.test(styleText);
  if (width && !capped) problems.push(`fixed width ${width[1]}`);
  return problems;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;

/** Long CJK labels do not wrap inside an svg <text>, so they spill out of their box. */
function longCjkLabels(outside) {
  const labels = [...outside.matchAll(/<text\b[^>]*>([^<]*)<\/text>/gi)].map((m) => m[1].trim());
  return labels.filter((l) => (l.match(CJK) ?? []).length > 16);
}

function prose(outside) {
  return outside
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text the reply
 * @param {{svg?: 'required'|'forbidden'|'any', html?: 'forbidden', code_lang?: string[],
 *          file_tree?: boolean, table?: boolean, fence?: boolean}} expect
 */
export function scoreReply(text, expect = {}) {
  const checks = [];
  const add = (name, ok, level = 'fail', detail = '') => checks.push({ name, ok, level, detail });
  const { fences, outside } = splitFences(text);
  const roots = svgRoots(outside);

  // Global rules.
  const ascii = fences.filter(isAsciiDiagramFence);
  add('no ASCII diagram in a fence', ascii.length === 0, 'fail', ascii.map((f) => f.body.split('\n')[0]).join(' | '));
  const mermaid = fences.filter((f) => f.lang === 'mermaid');
  add('no mermaid', mermaid.length === 0);
  const fencedSvg = fences.filter((f) => /<svg\b/i.test(f.body) && f.lang !== 'html-app');
  add('svg is inline, not fenced', fencedSvg.length === 0);
  add('no hand-built <pre>', !/<pre\b/i.test(outside));
  const sizeProblems = roots.flatMap(svgSizeProblems);
  add('svg scales with the column', sizeProblems.length === 0, 'fail', sizeProblems.join(', '));
  const long = longCjkLabels(outside);
  add('svg labels stay short', long.length === 0, 'warn', long.slice(0, 2).join(' | '));
  if (roots.length > 0) {
    const words = prose(outside);
    add('prose carries the point beside the svg', words.length >= 40, 'fail', `${words.length} chars of prose`);
    const themed = /var\(--(?:fg|fg-muted|border|bg-secondary|accent|bg)\)|currentColor/.test(outside);
    add('svg uses theme colours', themed, 'warn');
  }

  // The shape the question calls for.
  if (expect.svg === 'required') add('draws an svg', roots.length > 0, 'fail', `${roots.length} svg`);
  if (expect.svg === 'forbidden') add('no svg', roots.length === 0, 'fail', `${roots.length} svg`);
  if (expect.html === 'forbidden') add('no HTML at all', !HTML_TAG.test(outside));
  if (expect.code_lang?.length) {
    const langs = new Set(fences.map((f) => f.lang));
    const hit = expect.code_lang.some((l) => langs.has(l));
    add('real code in a labelled fence', hit, 'fail', `fences: ${[...langs].join(',') || 'none'}`);
  }
  if (expect.file_tree) add('file tree stays fenced', fences.some(isFileTreeFence));
  if (expect.fence) add('has a code fence', fences.length > 0);
  if (expect.table) add('uses a markdown table', /^\s*\|.*\|\s*$/m.test(outside) && /^\s*\|\s*:?-{3,}/m.test(outside));

  const pass = checks.every((c) => c.ok || c.level === 'warn');
  return { pass, checks, svgCount: roots.length };
}
