import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Task-ref regex: matches <task-ref id="..." label="..."/> or <task-ref id="..."/> */
const TASK_REF_RE = /<task-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;
/** Session-ref regex: matches <session-ref id="..." label="..."/> or <session-ref id="..."/> */
const SESSION_REF_RE = /<session-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;

/**
 * Convert entity reference XML tags to clickable HTML anchors.
 * Handles both labeled (resolved) and unlabeled (streaming/unresolved) variants.
 */
export function entityRefsToHtml(text: string): string {
  let result = text;
  result = result.replace(TASK_REF_RE, (_match, id: string, label?: string) => {
    const display = label || id;
    const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="/tasks/${id}" class="task-link" data-task-id="${id}">${escaped}</a>`;
  });
  result = result.replace(SESSION_REF_RE, (_match, id: string, label?: string) => {
    const display = label || id;
    const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="/sessions?id=${id}" class="session-link" data-session-id="${id}">${escaped}</a>`;
  });
  return result;
}

/**
 * Convert entity reference XML tags to markdown links.
 * Used by NotesEditor to preprocess pasted/loaded content containing raw XML refs.
 * <task-ref id="X" label="Y"/> → [Y](/tasks/X)
 * <session-ref id="X" label="Y"/> → [Y](/sessions?id=X)
 */
export function entityRefsToMarkdownLinks(text: string): string {
  let result = text;
  result = result.replace(TASK_REF_RE, (_match, id: string, label?: string) => {
    const display = (label || id).replace(/[\[\]]/g, '\\$&');
    return `[${display}](/tasks/${id})`;
  });
  result = result.replace(SESSION_REF_RE, (_match, id: string, label?: string) => {
    const display = (label || id).replace(/[\[\]]/g, '\\$&');
    return `[${display}](/sessions?id=${id})`;
  });
  return result;
}

/** DOMPurify attributes preserved for entity ref, image, and file link rendering */
const SANITIZE_ATTRS = ['data-task-id', 'data-session-id', 'data-lightbox-src', 'data-file-path', 'data-file-line', 'data-rel-path', 'data-cwd', 'loading', 'target', 'rel'];

// ── JSON ID pill injection for tool call INPUT/RESULT areas ──

/** Regex for task-ID-bearing keys in JSON: "task_id", "taskId", "parent_task_id" */
const JSON_TASK_ID_RE = /(&quot;(?:task_id|taskId|parent_task_id)&quot;:\s*&quot;)([a-z0-9]{7,10}-[a-f0-9]{4})(&quot;)/g;

/** Regex for session-ID-bearing keys in JSON */
const JSON_SESSION_ID_RE = /(&quot;(?:session_id|sessionId|from_plan|plan_session|exec_session|plan_session_id|exec_session_id)&quot;:\s*&quot;)([^&]+)(&quot;)/g;

/** Regex for bare "id" key when value matches task ID format */
const JSON_BARE_ID_RE = /(&quot;id&quot;:\s*&quot;)([a-z0-9]{7,10}-[a-f0-9]{4})(&quot;)/g;

/**
 * Inject clickable <a> pill tags into HTML-escaped JSON text for task_id and session_id values.
 * Expects the input to be already HTML-escaped (& → &amp;, < → &lt;, " → &quot;).
 */
export function injectJsonIdLinks(escapedText: string): string {
  let result = escapedText;

  // Task ID keys
  result = result.replace(JSON_TASK_ID_RE, (_m, prefix, id, suffix) => {
    return `${prefix}<a class="task-link" data-task-id="${id}" href="/tasks/${id}">${id}</a>${suffix}`;
  });

  // Session ID keys
  result = result.replace(JSON_SESSION_ID_RE, (_m, prefix, id, suffix) => {
    const display = id.length > 12 ? id.slice(0, 12) + '\u2026' : id;
    return `${prefix}<a class="session-link" data-session-id="${id}" href="/sessions?id=${id}" title="${id}">${display}</a>${suffix}`;
  });

  // Bare "id" key (only task ID format)
  result = result.replace(JSON_BARE_ID_RE, (_m, prefix, id, suffix) => {
    return `${prefix}<a class="task-link" data-task-id="${id}" href="/tasks/${id}">${id}</a>${suffix}`;
  });

  // file_path / path values — make clickable
  // Matches: "file_path": "/abs/path/to/file.ts", "~/abs/path", or "path": "/abs/path"
  result = result.replace(
    /(&quot;(?:file_path|path)&quot;:\s*&quot;)(~?\/[^&]+?)(&quot;)/g,
    (_m, prefix, filePath, suffix) => {
      return `${prefix}<a class="file-link" data-file-path="${filePath}" href="#">${filePath}</a>${suffix}`;
    },
  );

  return result;
}

/**
 * Render tool result text with both entity-ref XML support AND raw JSON ID pill injection.
 * Pipeline: entityRefsToHtml → injectJsonIdLinks (on the escaped portions) → marked → DOMPurify.
 */
export function renderToolResultWithRefs(text: string): string {
  try {
    // Step 1: Convert <task-ref>/<session-ref> XML to <a> tags
    const withEntityRefs = entityRefsToHtml(text);
    // Step 2: Run marked to get HTML
    const raw = marked.parse(withEntityRefs);
    const html = typeof raw === 'string' ? raw : '';
    // Step 3: Inject JSON ID pills into HTML-escaped JSON values
    // The marked parser will have HTML-escaped the JSON quotes as &quot;
    const withPills = injectJsonIdLinks(html);
    // Step 4: Linkify file paths inside code blocks (tool results are mostly code)
    const withCodePaths = linkifyPathsInCode(withPills);
    // Step 5: Sanitize
    return DOMPurify.sanitize(withCodePaths, { ADD_ATTR: SANITIZE_ATTRS });
  } catch {
    return DOMPurify.sanitize(text);
  }
}

// ── File path detection & linkification ──

/** Image extensions to exclude from file-path linkification */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff']);

/** Common code/text extensions that indicate a real file path */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'less', 'html', 'xml', 'sql', 'graphql', 'proto',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'md', 'mdx', 'txt', 'log', 'csv', 'tsv', 'env', 'conf', 'cfg', 'ini',
  'lock', 'gitignore', 'dockerignore', 'editorconfig',
  'dockerfile', 'makefile',
]);

/**
 * Convert file paths in text to clickable <a class="file-link"> elements.
 * Runs as a preprocessing step before marked.parse().
 *
 * Two-pass approach:
 * 1. Absolute paths: /dir/dir/file.ext (with optional :line suffix)
 * 2. Relative paths with extension: dir/file.ext (needs sessionCwd to resolve)
 *
 * Exclusions: URLs, image paths, code fences, already-linked text.
 */
export function filePathsToHtml(text: string, sessionCwd?: string): string {
  // Track code fence regions to skip
  const fenceRanges: [number, number][] = [];
  const fenceRe = /```[\s\S]*?```|`[^`\n]+`/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    fenceRanges.push([fm.index, fm.index + fm[0].length]);
  }

  function isInFence(idx: number): boolean {
    return fenceRanges.some(([start, end]) => idx >= start && idx < end);
  }

  // Track full URL ranges so a path SEGMENT inside a URL is never linkified —
  // e.g. https://host/packages/--/x/task.md must stay one URL, not become a
  // clickable "/x/task.md". The old `:// in preceding 3 chars` check only caught
  // the segment right after `://`, missing deeper segments.
  const urlRanges: [number, number][] = [];
  const urlRe = /https?:\/\/[^\s"'`<>)]+/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(text)) !== null) urlRanges.push([um.index, um.index + um[0].length]);
  function isInUrl(idx: number): boolean {
    return urlRanges.some(([start, end]) => idx >= start && idx < end);
  }

  // Also skip if inside a URL, a code fence, or a markdown image
  function shouldSkip(matchIdx: number, matchStr: string): boolean {
    if (isInFence(matchIdx)) return true;
    if (isInUrl(matchIdx)) return true;
    // Check for markdown image ![...](path)
    if (matchIdx >= 2 && text[matchIdx - 1] === '(' && text.slice(0, matchIdx).lastIndexOf('![') > text.slice(0, matchIdx).lastIndexOf(']')) return true;
    return false;
  }

  let result = text;
  const replacements: { start: number; end: number; replacement: string }[] = [];

  // Pass 1: Absolute paths — /dir/file.ext, ~/dir/file.ext, optional :42 suffix.
  // Negative lookbehind: leading `/` must NOT be preceded by a word char or another `/`.
  // This prevents matching mid-path substrings like `/providers/foo.ts` from `src/providers/foo.ts`.
  // The optional `~/` prefix keeps home-relative paths intact (`~` would otherwise be
  // dropped, both visually and from data-file-path — backend expands `~`).
  const absRe = /(?<![\/\w])(~?\/(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = absRe.exec(text)) !== null) {
    const fullMatch = m[0];
    const filePath = m[1];
    const lineNum = m[2];

    if (shouldSkip(m.index, fullMatch)) continue;

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTENSIONS.has(ext)) continue;

    const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
    const display = lineNum ? `${filePath}:${lineNum}` : filePath;
    const replacement = `<a class="file-link" data-file-path="${filePath}"${lineAttr} href="#">${display}</a>`;
    replacements.push({ start: m.index, end: m.index + fullMatch.length, replacement });
  }

  // Pass 1b: Absolute DIRECTORY paths (no file extension) — /dir/sub/leaf.
  // Requires ≥3 segments to avoid matching short prose-y roots like "/usr/bin".
  // Skips anything already linkified by Pass 1 (overlap check) and URLs/fences.
  const absDirRe = /(?<![\/\w])(~?\/(?:[\w@.+-]+\/){2,}[\w@.+-]+)\/?(?=[\s,;)"'`\]]|$)/g;
  while ((m = absDirRe.exec(text)) !== null) {
    const dirPath = m[1];
    if (shouldSkip(m.index, dirPath)) continue;
    // Skip if it has a file extension (Pass 1 owns those) or overlaps a prior match
    const leaf = dirPath.split('/').pop() ?? '';
    if (leaf.includes('.')) continue;
    const start = m.index;
    const end = m.index + dirPath.length;
    if (replacements.some(r => start < r.end && end > r.start)) continue;
    const replacement = `<a class="file-link" data-file-path="${dirPath}" href="#">${dirPath}</a>`;
    replacements.push({ start, end, replacement });
  }

  // Pass 2: Relative paths with extension — dir/file.ext or ./file.ext:42
  // Only linkify if sessionCwd is available (needed to resolve absolute path)
  if (sessionCwd) {
    const relRe = /(?:^|[\s"'`(])((\.\/|[\w@][\w@.+-]*\/)+[\w@.+-]+\.(\w+))(?::(\d+))?/gm;
    while ((m = relRe.exec(text)) !== null) {
      // m[1] = the path, m[3] = extension, m[4] = line number
      const pathPart = m[1];
      const ext = m[3]?.toLowerCase();
      const lineNum = m[4];

      if (!ext || IMAGE_EXTENSIONS.has(ext)) continue;
      if (!CODE_EXTENSIONS.has(ext)) continue;

      // Calculate the actual match position (m[1] may start after whitespace)
      const pathStart = m.index + m[0].indexOf(pathPart);
      const fullEnd = lineNum ? pathStart + pathPart.length + 1 + lineNum.length : pathStart + pathPart.length;

      if (shouldSkip(pathStart, pathPart)) continue;

      // Skip if this overlaps with an already-found absolute path
      const overlaps = replacements.some(r => pathStart < r.end && fullEnd > r.start);
      if (overlaps) continue;

      // Carry rel+cwd instead of pre-joining: the path may live in a sibling
      // package, so resolution (cwd → walk up → repo root) happens on click.
      const relClean = pathPart.replace(/^\.\//, '');
      const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
      const display = lineNum ? `${pathPart}:${lineNum}` : pathPart;
      const replacement = `<a class="file-link" data-rel-path="${relClean}" data-cwd="${sessionCwd}"${lineAttr} href="#">${display}</a>`;
      replacements.push({ start: pathStart, end: fullEnd, replacement });
    }

    // Pass 2b: Relative DIRECTORY / extensionless paths below cwd — e.g.
    // packages/services/some-team/SomeService.
    // Claude frequently emits package-relative paths with no leading ./ and no
    // extension. Require ≥3 segments to avoid prose like "and/or/maybe". Resolved
    // against cwd; if it doesn't exist the explorer just shows "not found".
    const relDirRe = /(?:^|[\s"'`(])((?:[\w@][\w@.+-]*\/){2,}[\w@][\w@.+-]*)\/?(?=[\s,;)"'`\].]|$)/gm;
    while ((m = relDirRe.exec(text)) !== null) {
      // Trim a trailing sentence period the greedy class may have swallowed
      // (e.g. "…/SomeService." → drop the final ".").
      const pathPart = m[1].replace(/\.+$/, '');
      const leaf = pathPart.split('/').pop() ?? '';
      if (leaf.includes('.')) continue; // files-with-ext belong to Pass 2
      if (pathPart.split('/').length < 3) continue; // trim may have dropped a segment
      const pathStart = m.index + m[0].indexOf(pathPart);
      const fullEnd = pathStart + pathPart.length;
      if (shouldSkip(pathStart, pathPart)) continue;
      if (replacements.some(r => pathStart < r.end && fullEnd > r.start)) continue;
      const replacement = `<a class="file-link" data-rel-path="${pathPart}" data-cwd="${sessionCwd}" href="#">${pathPart}</a>`;
      replacements.push({ start: pathStart, end: fullEnd, replacement });
    }
  }

  // Apply replacements in reverse order to preserve indices
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return result;
}

/**
 * Linkify file paths that ended up *inside* <code> blocks after marked ran.
 * filePathsToHtml() deliberately skips code fences (injecting <a> before marked
 * would get HTML-escaped), so this post-pass handles inline `code` and fenced
 * blocks. Operates on the already-escaped inner text of each <code> element.
 */
function linkifyPathsInCode(html: string, sessionCwd?: string): string {
  return html.replace(/(<code[^>]*>)([\s\S]*?)(<\/code>)/g, (full, open: string, inner: string, close: string) => {
    if (inner.includes('<a ')) return full; // already linkified
    let changed = false;

    // Track URL ranges (http(s)://…) so we never linkify a path SEGMENT inside a
    // URL — e.g. https://host/packages/--/x/task.md must stay a single URL, not a
    // clickable "/x/task.md" file link. Matches against the escaped inner text.
    const urlRanges: [number, number][] = [];
    const urlRe = /https?:\/\/[^\s"'`<>]+/g;
    let um: RegExpExecArray | null;
    while ((um = urlRe.exec(inner)) !== null) urlRanges.push([um.index, um.index + um[0].length]);
    const inUrl = (idx: number) => urlRanges.some(([s, e]) => idx >= s && idx < e);

    // Absolute paths: /dir/file.ext(:line)
    const absRe = /(?<![\/\w])(~?\/(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+)(?::(\d+))?/g;
    let out = inner.replace(absRe, (m, filePath: string, lineNum: string | undefined, offset: number) => {
      if (inUrl(offset)) return m;
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (IMAGE_EXTENSIONS.has(ext)) return m;
      changed = true;
      const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
      const display = lineNum ? `${filePath}:${lineNum}` : filePath;
      return `<a class="file-link" data-file-path="${filePath}"${lineAttr} href="#">${display}</a>`;
    });

    // Absolute DIRECTORY paths (no extension, ≥3 segments) — open the folder.
    {
      const urlR: [number, number][] = [];
      urlRe.lastIndex = 0;
      while ((um = urlRe.exec(out)) !== null) urlR.push([um.index, um.index + um[0].length]);
      const inU = (idx: number) => urlR.some(([s, e]) => idx >= s && idx < e);
      const absDirRe = /(?<![\/\w])(~?\/(?:[\w@.+-]+\/){2,}[\w@.+-]+)\/?(?=[\s,;)"'`\]<]|$)/g;
      out = out.replace(absDirRe, (m, dirPath: string, offset: number) => {
        if (inU(offset)) return m;
        if (m.includes('file-link')) return m;
        const leaf = dirPath.split('/').pop() ?? '';
        if (leaf.includes('.')) return m;
        changed = true;
        return `<a class="file-link" data-file-path="${dirPath}" href="#">${dirPath}</a>`;
      });
    }

    // Relative paths (needs cwd to resolve): dir/file.ext or ./file.ext(:line)
    if (sessionCwd) {
      // URL offsets shift after the abs pass rewrites text; recompute against `out`.
      const urlRanges2: [number, number][] = [];
      urlRe.lastIndex = 0;
      while ((um = urlRe.exec(out)) !== null) urlRanges2.push([um.index, um.index + um[0].length]);
      const inUrl2 = (idx: number) => urlRanges2.some(([s, e]) => idx >= s && idx < e);

      const relRe = /(^|[\s"'`(>])((?:\.\/|[\w@][\w@.+-]*\/)+[\w@.+-]+\.(\w+))(?::(\d+))?/g;
      out = out.replace(relRe, (m, lead: string, pathPart: string, ext: string, lineNum: string | undefined, offset: number) => {
        if (inUrl2(offset)) return m;
        const e = ext?.toLowerCase();
        if (!e || IMAGE_EXTENSIONS.has(e) || !CODE_EXTENSIONS.has(e)) return m;
        // Don't re-wrap something already turned into an anchor by the abs pass
        if (m.includes('file-link')) return m;
        changed = true;
        // Carry rel+cwd; resolution (sibling pkg / repo root) happens on click.
        const relClean = pathPart.replace(/^\.\//, '');
        const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
        const display = lineNum ? `${pathPart}:${lineNum}` : pathPart;
        return `${lead}<a class="file-link" data-rel-path="${relClean}" data-cwd="${sessionCwd}"${lineAttr} href="#">${display}</a>`;
      });
    }

    // Linkify full URLs as external links ("render all", not a partial file link).
    // Runs last; file passes left URL text intact, and our file-link anchors carry
    // no http (data-file-path is a fs path), so this won't touch them.
    out = out.replace(/https?:\/\/[^\s"'`<>]+/g, (url) => {
      changed = true;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    return changed ? open + out + close : full;
  });
}

/**
 * Strip tool-call syntax the model occasionally leaks into plain assistant TEXT.
 *
 * The model sometimes emits a literal `<invoke name="X">…<parameter …>…</parameter></invoke>`
 * block as prose right before the real `tool_use` block. Left in, marked passes the
 * unknown tags through and DOMPurify strips `<invoke>`/`<parameter>`, dumping the raw
 * multiline command as flat text and breaking layout. The real tool call still renders
 * from its own block, so the leaked copy is pure noise — remove it.
 *
 * Code fences are protected so a legit sample that *shows* this syntax survives.
 */
export function stripLeakedToolCalls(text: string): string {
  if (!text.includes('invoke')) return text;

  const fenceRanges: [number, number][] = [];
  const fenceRe = /```[\s\S]*?```|`[^`\n]+`/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) fenceRanges.push([fm.index, fm.index + fm[0].length]);
  const inFence = (i: number) => fenceRanges.some(([s, e]) => i >= s && i < e);

  const removals: [number, number][] = [];
  const blockRe = /<(?:antml:)?invoke\b[^>]*>[\s\S]*?<\/(?:antml:)?invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    if (!inFence(m.index)) removals.push([m.index, m.index + m[0].length]);
  }
  // Streaming mid-leak: an open <invoke …> with no closer yet → drop to end of text.
  if (removals.length === 0) {
    const openRe = /<(?:antml:)?invoke\b[^>]*>[\s\S]*$/;
    const om = openRe.exec(text);
    if (om && !inFence(om.index)) removals.push([om.index, text.length]);
  }
  if (removals.length === 0) return text;

  removals.sort((a, b) => b[0] - a[0]);
  let result = text;
  for (const [s, e] of removals) result = result.slice(0, s) + result.slice(e);
  // Collapse blank-line/whitespace debris left behind by the removed block.
  return result.replace(/\s+$/, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Render markdown text with entity ref support and file path linkification.
 * Preprocesses <task-ref> and <session-ref> XML tags into clickable HTML anchors,
 * converts file paths to clickable links (including inside code blocks),
 * then runs marked.parse() + DOMPurify.sanitize().
 */
/**
 * Post-process sanitized HTML: rewrite <img src="..."> to use the /api/local-image proxy.
 * Handles both absolute (/path/to/img.png) and relative (subdir/img.png) paths.
 * Relative paths are resolved against `cwd` (the directory containing the .md file).
 */
function proxyImageSrcs(html: string, cwd?: string, host?: string): string {
  return html.replace(/<img\s([^>]*)>/gi, (full, attrs: string) => {
    const srcMatch = attrs.match(/src="([^"]*)"/);
    if (!srcMatch) return full;
    const src = srcMatch[1];
    if (src.startsWith('/api/') || src.startsWith('http') || src.startsWith('data:')) return full;

    let absPath: string;
    if (src.startsWith('/')) {
      absPath = src;
    } else if (cwd) {
      absPath = `${cwd.replace(/\/$/, '')}/${src.replace(/^\.\//, '')}`;
    } else {
      return full;
    }

    const hostParam = host ? `&host=${encodeURIComponent(host)}` : '';
    const proxied = `/api/local-image?path=${encodeURIComponent(absPath)}${hostParam}`;
    const newAttrs = attrs
      .replace(/src="[^"]*"/, `src="${proxied}"`)
      + ` data-lightbox-src="${proxied}" loading="lazy"`;
    return `<img ${newAttrs}>`;
  });
}

const mdCache = new Map<string, string>();
const MD_CACHE_MAX = 200;
const MD_CACHE_SKIP_LENGTH = 10_000; // skip caching very long texts to avoid memory bloat

export function renderMarkdownWithRefs(text: string, sessionCwd?: string, host?: string): string {
  const key = host ? `${text}\0${sessionCwd ?? ''}\0${host}` : sessionCwd ? `${text}\0${sessionCwd}` : text;
  const cached = text.length <= MD_CACHE_SKIP_LENGTH ? mdCache.get(key) : undefined;
  if (cached !== undefined) {
    mdCache.delete(key);
    mdCache.set(key, cached);
    return cached;
  }

  let html: string;
  try {
    let preprocessed = stripLeakedToolCalls(text);
    preprocessed = entityRefsToHtml(preprocessed);
    preprocessed = filePathsToHtml(preprocessed, sessionCwd);
    const raw = marked.parse(preprocessed);
    let parsed = typeof raw === 'string' ? raw : '';
    parsed = linkifyPathsInCode(parsed, sessionCwd);
    html = DOMPurify.sanitize(parsed, { ADD_ATTR: SANITIZE_ATTRS });
  } catch {
    html = DOMPurify.sanitize(text);
  }

  html = proxyImageSrcs(html, sessionCwd, host);

  if (text.length <= MD_CACHE_SKIP_LENGTH) {
    if (mdCache.size >= MD_CACHE_MAX) {
      const oldest = mdCache.keys().next().value;
      if (oldest !== undefined) mdCache.delete(oldest);
    }
    mdCache.set(key, html);
  }
  return html;
}

/**
 * Render markdown to clean, self-contained HTML suitable for copying as RICH TEXT
 * into external editors (Docs / Word / email / Slack).
 *
 * Unlike renderMarkdownWithRefs, this deliberately does NOT inject walnut-internal
 * links (file-link / task-ref / session-ref / image proxy). Those are meaningless
 * — and can leak internal filesystem paths — once pasted outside the app. Output is
 * standard semantic HTML only (h/ul/ol/table/pre/code/strong/a…), so the paste
 * target applies its own styling. Uses the same marked config as the on-screen
 * render so the copied rich text matches what the user sees.
 */
export function markdownToRichHtml(text: string): string {
  try {
    const raw = marked.parse(text);
    const html = typeof raw === 'string' ? raw : '';
    return DOMPurify.sanitize(html);
  } catch {
    return DOMPurify.sanitize(text);
  }
}

// ── Shared constants for tool call markdown field expansion (Phase 2) ──

/** Input field keys that should never get markdown expansion (IDs, paths, etc.) */
export const MARKDOWN_EXCLUDED_INPUT_KEYS = new Set([
  'task_id', 'taskId', 'session_id', 'sessionId', 'from_plan',
  'id', 'cwd', 'file_path', 'working_directory',
]);

/** Minimum string length to qualify for markdown expansion */
export const MARKDOWN_FIELD_MIN_LENGTH = 200;

/**
 * Extract long multiline string fields from tool input and render as markdown.
 * Used by ToolCallSection (ChatMessage) and GenericToolCall (SessionMessage).
 */
export function extractMarkdownFields(
  input: Record<string, unknown>,
): { key: string; html: string }[] {
  return Object.entries(input)
    .filter(([k, v]) =>
      typeof v === 'string' &&
      (v as string).includes('\n') &&
      (v as string).length > MARKDOWN_FIELD_MIN_LENGTH &&
      !MARKDOWN_EXCLUDED_INPUT_KEYS.has(k),
    )
    .map(([k, v]) => ({ key: k, html: renderMarkdownWithRefs(v as string) }));
}

// ── Tool result image detection & rendering ──

/** Image file extension pattern */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Match absolute image file paths in text (allows spaces/hyphens in path segments) */
const IMAGE_PATH_IN_TEXT_RE = /(\/(?:[\w. -]+\/)+[\w. -]+\.(?:png|jpe?g|gif|webp))/gi;

/** Match relative image file paths like "screenshot.png" or "subdir/file.png".
 *  Boundaries include backtick — Claude Code commonly wraps filenames in backticks. */
const RELATIVE_IMAGE_PATH_RE = /(?:^|[\s"'`=:(])(([\w][\w.-]*\/)*[\w][\w.-]*\.(?:png|jpe?g|gif|webp))(?=[\s"'`),;\]}]|$)/gi;

/**
 * Extract base64 images from Anthropic content-block JSON format.
 * Handles both array and single-object forms:
 *   [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR..."}}]
 *   {"type":"image","source":{"type":"base64","data":"..."}}
 */
export function extractContentBlockImages(result: string): { imageSrcs: string[]; textParts: string[] } | null {
  const trimmed = result.trimStart();
  if ((trimmed[0] !== '[' && trimmed[0] !== '{') || !result.includes('"base64"')) return null;

  try {
    const parsed = JSON.parse(result);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    const imageSrcs: string[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === 'base64' && typeof source.data === 'string') {
          const mt = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          imageSrcs.push(`data:${mt};base64,${source.data}`);
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }

    return imageSrcs.length > 0 ? { imageSrcs, textParts } : null;
  } catch {
    return null;
  }
}

/** Find image file paths in text — both absolute (/path/to/img.png) and relative (img.png) */
export function findImagePaths(text: string): string[] {
  const paths: string[] = [];
  // Pass 1: absolute paths
  let re = new RegExp(IMAGE_PATH_IN_TEXT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) paths.push(m[1]);
  // Pass 2: relative paths (skip any already captured as absolute)
  const absSet = new Set(paths);
  re = new RegExp(RELATIVE_IMAGE_PATH_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const p = m[1];
    if (!p.startsWith('/') && !absSet.has(p)) paths.push(p);
  }
  return [...new Set(paths)];
}

/** Check if a file path looks like an image file */
export function isImageFilePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}

/** Resolve an image path: absolute paths pass through, relative paths get cwd prepended.
 *  Returns null if a relative path can't be resolved (no cwd available). */
export function resolveImagePath(path: string, cwd?: string): string | null {
  if (path.startsWith('/')) return path;
  if (cwd) return `${cwd.replace(/\/$/, '')}/${path}`;
  return null;
}

/**
 * Isolated DOMPurify instance for note rendering.
 * Hooks are added once at module init — no global mutations, no race conditions.
 */
const notePurify = DOMPurify();
notePurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src');
    if (src && !src.startsWith('/api/') && !src.startsWith('http') && !src.startsWith('data:')) {
      if (src.startsWith('/')) {
        const proxied = `/api/local-image?path=${encodeURIComponent(src)}`;
        node.setAttribute('src', proxied);
        node.setAttribute('data-lightbox-src', proxied);
      }
    } else if (src?.startsWith('/api/')) {
      node.setAttribute('data-lightbox-src', src);
    }
    node.setAttribute('loading', 'lazy');
  }
});

/**
 * Preprocess text to convert bare image file paths into markdown image syntax.
 * Handles:
 * 1. Backtick-wrapped paths: `path/to/img.png` → ![img.png](path/to/img.png)
 * 2. Bare absolute paths: /tmp/screenshot.png → ![screenshot.png](/tmp/screenshot.png)
 * Skips paths inside triple-backtick fences or markdown image/link syntax.
 */
function bareImagePathsToMarkdown(text: string): string {
  const tripleFenceRanges: [number, number][] = [];
  const tripleFenceRe = /```[\s\S]*?```/g;
  let fm: RegExpExecArray | null;
  while ((fm = tripleFenceRe.exec(text)) !== null) {
    tripleFenceRanges.push([fm.index, fm.index + fm[0].length]);
  }
  const inTripleFence = (i: number) => tripleFenceRanges.some(([s, e]) => i >= s && i < e);

  const replacements: { start: number; end: number; replacement: string }[] = [];

  // Pass 1: backtick-wrapped image paths — `path.png` → ![name](path)
  const backtickImgRe = /`((?:\/(?:[\w. @+-]+\/)*)?[\w. @+-]+\.(?:png|jpe?g|gif|webp))`/gi;
  let m: RegExpExecArray | null;
  while ((m = backtickImgRe.exec(text)) !== null) {
    if (inTripleFence(m.index)) continue;
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    if (before.includes('!') || before.includes('](')) continue;
    const imgPath = m[1];
    const filename = imgPath.split('/').pop() ?? imgPath;
    replacements.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `![${filename}](${imgPath})`,
    });
  }

  // Pass 2: bare absolute image paths (not in backticks, not in triple fences)
  const singleBacktickRanges: [number, number][] = [];
  const singleBtRe = /`[^`\n]+`/g;
  while ((fm = singleBtRe.exec(text)) !== null) {
    singleBacktickRanges.push([fm.index, fm.index + fm[0].length]);
  }
  const inAnyBacktick = (i: number) =>
    inTripleFence(i) || singleBacktickRanges.some(([s, e]) => i >= s && i < e);

  const imgPathRe = /(\/(?:[\w. @+-]+\/)+[\w. @+-]+\.(?:png|jpe?g|gif|webp))/gi;
  while ((m = imgPathRe.exec(text)) !== null) {
    if (inAnyBacktick(m.index)) continue;
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    if (before.includes('](') || before.includes('src=') || before.includes('![')) continue;
    const overlaps = replacements.some(r => m!.index < r.end && m!.index + m![0].length > r.start);
    if (overlaps) continue;
    const filename = m[1].split('/').pop() ?? m[1];
    replacements.push({
      start: m.index,
      end: m.index + m[0].length,
      replacement: `![${filename}](${m[1]})`,
    });
  }

  if (replacements.length === 0) return text;
  replacements.sort((a, b) => b.start - a.start);
  let result = text;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }
  return result;
}

/**
 * Render a note string as sanitized HTML with markdown support.
 * All <a> links open in a new tab with noopener/noreferrer.
 * Bare image paths are detected and rendered as inline images via local-image proxy.
 */
export function renderNoteMarkdown(text: string): string {
  let html: string;
  try {
    const preprocessed = bareImagePathsToMarkdown(text);
    const raw = marked.parse(preprocessed, { breaks: true, gfm: true });
    html = typeof raw === 'string' ? raw : '';
  } catch {
    // Fallback: escape and return raw text in a <p> tag
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p>${escaped}</p>`;
  }

  return notePurify.sanitize(html, { ADD_ATTR: ['target', 'data-lightbox-src', 'loading'] });
}
