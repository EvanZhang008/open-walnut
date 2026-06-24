// Syntax highlighting for the Changed-tab diff, via refractor (Prism grammars,
// open source). react-diff-view's `tokenize` consumes `{ highlight: true,
// refractor, language }` and emits standard Prism token <span>s (class
// "token keyword" etc.) — we style those in globals.css to match GitHub.
//
// The default `refractor` import is the "common" bundle (~62 languages incl.
// ts/js/py/java/go/rust/c/cpp/json/yaml/bash/sql/…). This is a React+TS repo,
// so we additionally register tsx/jsx, which the common bundle omits.
import { refractor } from 'refractor';
import tsx from 'refractor/lang/tsx.js';
import jsx from 'refractor/lang/jsx.js';

if (!refractor.registered('tsx')) refractor.register(tsx);
if (!refractor.registered('jsx')) refractor.register(jsx);

/** Map a file extension to a refractor/Prism language name. Only entries the
 *  common bundle (plus the tsx/jsx we register above) actually knows are worth
 *  listing; unknown extensions return undefined → highlighting is skipped. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'jsx',
  py: 'python', pyi: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  c: 'c', h: 'c',
  cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
  sql: 'sql',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  ini: 'ini', toml: 'ini', cfg: 'ini', conf: 'ini',
  diff: 'diff', patch: 'diff',
};

/** Resolve a refractor language for a path, or undefined if we can't highlight
 *  it (so the caller falls back to plain, never-throwing tokenization). */
export function languageForPath(relPath: string): string | undefined {
  const base = relPath.split('/').pop() || relPath;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  if (!lang) return undefined;
  return refractor.registered(lang) ? lang : undefined;
}

/** react-diff-view 3.x was built against refractor v2, whose `highlight()`
 *  returned an ARRAY of hast nodes — it does `createRoot(refractor.highlight(...))`,
 *  treating the result as the children array. refractor v4 (what we install)
 *  instead returns a hast Root object `{ type: 'root', children: [...] }`, so
 *  react-diff-view ends up wrapping the Root in another root and tries to
 *  iterate a non-iterable → highlighting silently no-ops. Unwrap to `.children`
 *  so the v4 grammar output matches the v2-era shape react-diff-view expects. */
export const diffRefractor: { highlight: (value: string, language: string) => unknown } = {
  highlight: (value, language) => refractor.highlight(value, language).children,
};
