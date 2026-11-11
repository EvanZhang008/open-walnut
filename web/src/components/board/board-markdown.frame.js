/*
 * Board runtime, part 2 of 3 (the message renderer): light markdown for thread
 * messages. TaskBoardPane.tsx injects it between the core (board-runtime.frame.js)
 * and the elements (board-elements.frame.js). Same rules: plain ES2017, no
 * imports, loaded as a string (`?raw`), runs only inside the board frame.
 *
 * It reads `window.__wnBoardKit` and sets `kit.richText`, and touches nothing
 * else (no DOM), so tests/web/board-markdown.test.ts evaluates it with a fake
 * window.
 *
 * Supported: paragraphs, bullet and numbered lists (one nested level), fenced
 * code, `>` quotes, `#` headings (a bold line, never a big heading in a chat
 * bubble); inline code, bold, italic, strike, [text](http link) and bare
 * http(s) URLs. Anything else stays literal text.
 *
 * No html-app islands here: a ```html-app fence is a code block like any other.
 * An interactive block that keeps its state and hands a result back is a session
 * reply's (web/src/components/chat/island-runtime.ts; the walnut-board skill says so).
 *
 * A message must never become markup: its text is escaped before any tag is
 * added, only fixed tags come out, and a link keeps its href only for http(s)
 * (escaped, class wn-link, so the core's click handler opens it in a new tab).
 */
(function (kit) {
  'use strict';
  if (!kit || typeof kit.esc !== 'function') return;
  var esc = kit.esc;

  // Finished html is parked behind a \u0000N\u0000 token so later passes cannot
  // reach inside it. A \u0000 in the message is replaced first: every token is ours.
  var HOLD_RE = /\u0000(\d+)\u0000/g;
  var MAX_EMPHASIS_DEPTH = 6;
  var MAX_QUOTE_DEPTH = 4;

  var URL_RE = /https?:\/\/[^\s<>"'\u0000]+/g;
  var URL_TRAIL_RE = /[.,;:!?)\]}*_~]+$/;
  var HTTP_RE = /^https?:\/\//i;
  // A backtick run, then the same run again, neither touching another backtick.
  var CODE_RE = /(^|[^`])(`+)(?!`)([\s\S]*?[^`])\2(?!`)/g;
  // [text](url), the url allowing one level of balanced parentheses.
  var LINK_RE = /\[([^\[\]]+)\]\(((?:[^()\s\u0000]|\([^()\s\u0000]*\))+)\)/g;
  // An absolute path with a file name (`/Users/me/x.mp4`, `~/notes/a.md`) and a letter id
  // (`lt-…`, the inbox store's shape) open in the app: the core's click handler sends them up.
  var PATH_SRC = '(?:~/|/)(?:[\\w.@+~-]+/)+[\\w.@+~-]*[\\w@+~-]\\.[A-Za-z0-9]{1,8}';
  var PATH_RE = new RegExp('(^|[\\s(\\[\'"\u201c\uff08\uff1a:,\u3001])(' + PATH_SRC + ')(?![\\w/-])', 'g');
  var WHOLE_PATH_RE = new RegExp('^' + PATH_SRC + '$');
  var LETTER_SRC = 'lt-[0-9a-z]{1,12}-[0-9a-z]{4,12}';
  var LETTER_RE = new RegExp('(^|[^\\w./-])(' + LETTER_SRC + ')(?![\\w-])', 'g');
  var WHOLE_LETTER_RE = new RegExp('^' + LETTER_SRC + '$');
  // `_` emphasis only at word boundaries (snake_case stays literal); non-ASCII counts as a word character.
  var W = 'A-Za-z0-9_\\u00C0-\\uFFFF';
  var BOLD_STAR_RE = /\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g;
  var BOLD_UND_RE = new RegExp('(^|[^' + W + '])__(?=[^\\s_])([\\s\\S]*?[^\\s_])__(?![' + W + '])', 'g');
  var STRIKE_RE = /~~(?=[^\s~])([\s\S]*?[^\s~])~~/g;
  var EM_STAR_RE = /\*(?=[^\s*])([^*]*?[^\s*])\*/g;
  var EM_UND_RE = new RegExp('(^|[^' + W + '])_(?=[^\\s_])([\\s\\S]*?[^\\s_])_(?![' + W + '])', 'g');

  // A task the message names (web/src/utils/task-id-shape.ts, the same shapes; no lookbehind,
  // so the char before is captured): a UUID, a short id, or an id's first segment. It becomes a
  // live <walnut-task> chip only when the host put it in the refs (it resolves it to one task).
  var TASK_TOKEN_SRC = '(^|[^\\w\\-./@#])'
    + '((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{7,10}-[a-f0-9]{4}|[a-z0-9]{7,}))'
    + '(?![\\w\\-/@]|\\.\\w)';
  var TASK_REF_RE = /<task-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;
  var LEGACY_REF_RE = /\[([a-z0-9]{7,10}-[a-f0-9]{4})\|([^\]\n]+)\]/g;
  kit.TASK_TOKEN_SRC = TASK_TOKEN_SRC;
  function taskRef(token) {
    var refs = kit.state && kit.state.refs;
    return token && refs && Object.prototype.hasOwnProperty.call(refs, token) ? refs[token] : null;
  }
  /** The chip for a token the refs know; `data-wn-text` keeps what was written (a section's hash reads it). */
  function taskChip(token) {
    return '<walnut-task id="' + esc(token) + '" data-wn-text="' + esc(token) + '"></walnut-task>';
  }
  kit.taskRef = taskRef;
  kit.taskChip = taskChip;

  // ── A title written beside a mention: the chip shows it, so it is dropped ──
  // A mirror of web/src/utils/task-title-absorb.ts (same shapes, same cases:
  // tests/fixtures/task-title-absorb.json); see that file for the rule.

  var ABSORB_PAIRS = [['**', '**'], ['__', '__'], ['*', '*'], ['_', '_'],
    ['"', '"'], ['\u201c', '\u201d'], ['\u300c', '\u300d'], ['\u300e', '\u300f'], ['\u2018', '\u2019'], ["'", "'"]];
  var MAX_WRITTEN = 240;
  var ELLIPSIS_END_RE = /[ \t]*(?:\u2026|\.\.\.)$/;
  var PAREN_BEFORE_RE = /([ \t]*)([(\uff08])[ \t]*$/;
  var CLOSE_AFTER_RE = /^[ \t]*[)\uff09]/;
  var LIST_SEP_AFTER_RE = /^[ \t]*[,\uff0c\u3001;\uff1b][ \t]*/;
  var DASH_BEFORE_RE = /(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)$/;
  var DASH_AFTER_RE = /^(?:[ \t]*[\u2014\u2013][ \t]*|[ \t]+-{1,2}[ \t]+)/;
  var PAREN_AFTER_RE = /^[ \t]*[(\uff08]([^\n()\uff08\uff09]{1,240})[)\uff09]/;
  var SPACE_AFTER_RE = /^[ \t]+/;
  var ASCII_WORD_RE = /[A-Za-z0-9]/;
  var NOT_CHIP_RES = [
    /\[[^\[\]\n]*\]\((?:[^()\s]|\([^()\s]*\))*\)/g,
    /https?:\/\/[^\s<>"')\]]+/g,
    /<[^<>\n]+>/g
  ];

  function absorbNorm(s) { return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function unwrap(s) {
    var t = s.trim();
    for (var round = 0; round < 4; round++) {
      var pair = null;
      for (var i = 0; i < ABSORB_PAIRS.length; i++) {
        var o = ABSORB_PAIRS[i][0], c = ABSORB_PAIRS[i][1];
        if (t.length > o.length + c.length && t.startsWith(o) && t.endsWith(c)) { pair = ABSORB_PAIRS[i]; break; }
      }
      if (!pair) break;
      t = t.slice(pair[0].length, t.length - pair[1].length).trim();
    }
    return t;
  }
  function isNameCut(head, full, cut) {
    var h = head.trim();
    return cut || h.length >= 0.6 * full || (h.length >= 10 && h.split(/\s+/).length >= 2);
  }
  function writtenTitleMatches(written, title) {
    var w = unwrap(written);
    var cut = ELLIPSIS_END_RE.test(w);
    if (cut) w = unwrap(w.replace(ELLIPSIS_END_RE, ''));
    var nw = absorbNorm(w), nt = absorbNorm(title);
    if (nw.length < 3 || !nt) return false;
    if (nw === nt) return true;
    if (nt.indexOf(nw) !== 0) return false;
    if (ASCII_WORD_RE.test(nt.charAt(nw.length)) && ASCII_WORD_RE.test(nw.charAt(nw.length - 1))) return false;
    return isNameCut(nw, nt.length, cut);
  }
  function unitBefore(head) {
    for (var i = 0; i < ABSORB_PAIRS.length; i++) {
      var open = ABSORB_PAIRS[i][0], close = ABSORB_PAIRS[i][1];
      if (!head.endsWith(close)) continue;
      if (close.length === 1 && head.endsWith(close + close) && (close === '*' || close === '_')) continue;
      var start = head.lastIndexOf(open, head.length - close.length - 1);
      if (start < 0 || head.length - start > MAX_WRITTEN || head.slice(start).indexOf('\n') >= 0) continue;
      if (head.length - start <= open.length + close.length) continue;
      return start;
    }
    return -1;
  }
  function unitAfter(tail) {
    for (var i = 0; i < ABSORB_PAIRS.length; i++) {
      var open = ABSORB_PAIRS[i][0], close = ABSORB_PAIRS[i][1];
      if (!tail.startsWith(open)) continue;
      if (open.length === 1 && tail.startsWith(open + open) && (open === '*' || open === '_')) continue;
      var end = tail.indexOf(close, open.length + 1);
      if (end < 0 || end + close.length > MAX_WRITTEN || tail.slice(0, end).indexOf('\n') >= 0) continue;
      return end + close.length;
    }
    return 0;
  }
  function cutLengths(title, cut) {
    var out = [];
    for (var k = title.length; k >= 3; k--) {
      if (k < title.length && ASCII_WORD_RE.test(title.charAt(k)) && ASCII_WORD_RE.test(title.charAt(k - 1))) continue;
      if (k === title.length || isNameCut(title.slice(0, k), title.length, cut)) out.push(k);
    }
    return out;
  }
  function plainBefore(head, title) {
    var ell = ELLIPSIS_END_RE.exec(head);
    var core = ell ? head.slice(0, ell.index) : head;
    var lower = core.toLowerCase();
    // Offsets are taken on `core`: a case fold that changes the length cannot be mapped back.
    if (lower.length !== core.length) return -1;
    var t = title.trim().toLowerCase();
    var ks = cutLengths(t, !!ell);
    for (var i = 0; i < ks.length; i++) {
      var cand = t.slice(0, ks[i]).replace(/\s+$/, '');
      if (cand.length < 3 || !lower.endsWith(cand)) continue;
      var start = core.length - cand.length;
      if (start > 0 && ASCII_WORD_RE.test(cand.charAt(0)) && ASCII_WORD_RE.test(core.charAt(start - 1))) continue;
      return start;
    }
    return -1;
  }
  function plainAfter(tail, title) {
    var lower = tail.toLowerCase();
    var t = title.trim().toLowerCase();
    var ks = cutLengths(t, true);
    for (var i = 0; i < ks.length; i++) {
      var k = ks[i];
      var cand = t.slice(0, k).replace(/\s+$/, '');
      if (cand.length < 3 || !lower.startsWith(cand)) continue;
      var end = cand.length;
      var ell = /^[ \t]*(?:\u2026|\.\.\.)/.exec(tail.slice(end));
      if (ell) end += ell[0].length;
      else if (k < t.length && !isNameCut(cand, t.length, false)) continue;
      if (!ell && ASCII_WORD_RE.test(cand.charAt(cand.length - 1)) && ASCII_WORD_RE.test(tail.charAt(end))) continue;
      return end;
    }
    return 0;
  }
  function anyTitle(titles, fn) { for (var i = 0; i < titles.length; i++) if (fn(titles[i])) return true; return false; }
  function writtenBefore(head, titles) {
    var u = unitBefore(head);
    if (u >= 0) return anyTitle(titles, function (t) { return writtenTitleMatches(head.slice(u), t); }) ? u : -1;
    for (var i = 0; i < titles.length; i++) {
      var p = plainBefore(head, titles[i]);
      if (p >= 0) return p;
    }
    return -1;
  }
  function absorbEdit(text, m, lo, hi) {
    var mention = text.slice(m.start, m.end);
    var before = text.slice(lo, m.start);
    var after = text.slice(m.end, hi);
    var paren = PAREN_BEFORE_RE.exec(before);
    if (paren) {
      var close = CLOSE_AFTER_RE.exec(after);
      var sep = close ? null : LIST_SEP_AFTER_RE.exec(after);
      if (close || sep) {
        var at = writtenBefore(before.slice(0, paren.index), m.titles);
        if (at >= 0) {
          return close
            ? { from: lo + at, to: m.end + close[0].length, text: mention }
            : { from: lo + at, to: m.end + sep[0].length, text: mention + paren[1] + paren[2] };
        }
      }
    }
    var dashBefore = DASH_BEFORE_RE.exec(before);
    if (dashBefore) {
      var at2 = writtenBefore(before.slice(0, dashBefore.index), m.titles);
      if (at2 >= 0) return { from: lo + at2, to: m.start, text: '' };
    }
    var parenAfter = PAREN_AFTER_RE.exec(after);
    if (parenAfter && anyTitle(m.titles, function (t) { return writtenTitleMatches(parenAfter[1], t); })) {
      return { from: m.end, to: m.end + parenAfter[0].length, text: '' };
    }
    var dashAfter = DASH_AFTER_RE.exec(after);
    if (dashAfter) {
      var tail = after.slice(dashAfter[0].length);
      var u = unitAfter(tail);
      var len = u > 0 && anyTitle(m.titles, function (t) { return writtenTitleMatches(tail.slice(0, u), t); }) ? u : 0;
      if (!len && u === 0) for (var i = 0; i < m.titles.length && !len; i++) len = plainAfter(tail, m.titles[i]);
      if (len) return { from: m.end, to: m.end + dashAfter[0].length + len, text: '' };
    }
    var space = SPACE_AFTER_RE.exec(after);
    if (space) {
      var tail2 = after.slice(space[0].length);
      var u2 = unitAfter(tail2);
      if (u2 > 0 && anyTitle(m.titles, function (t) { return writtenTitleMatches(tail2.slice(0, u2), t); })) {
        return { from: m.end, to: m.end + space[0].length + u2, text: '' };
      }
    }
    return null;
  }
  function absorbWrittenTitles(text, mentions) {
    if (!mentions.length) return text;
    var sorted = mentions.slice().sort(function (a, b) { return a.start - b.start; });
    var edits = [];
    for (var i = 0; i < sorted.length; i++) {
      var m = sorted[i];
      var lineStart = text.lastIndexOf('\n', m.start - 1) + 1;
      var nl = text.indexOf('\n', m.end);
      var lo = Math.max(lineStart, i > 0 ? sorted[i - 1].end : 0);
      var hi = Math.min(nl < 0 ? text.length : nl, i + 1 < sorted.length ? sorted[i + 1].start : text.length);
      var e = absorbEdit(text, m, lo, hi);
      if (e && !edits.some(function (x) { return x.from < e.to && e.from < x.to; })) edits.push(e);
    }
    edits.sort(function (a, b) { return b.from - a.from; });
    var out = text;
    for (var j = 0; j < edits.length; j++) out = out.slice(0, edits[j].from) + edits[j].text + out.slice(edits[j].to);
    return out;
  }
  function pillNames(shown) {
    var out = [shown];
    if (/ VP$/i.test(shown)) out.push(shown.replace(/ VP$/i, ' lead'));
    if (shown === 'CEO') out.push('Main');
    return out;
  }
  /** The mentions of one paragraph's raw text that become chips, then the titles beside them dropped. */
  function absorbTaskTitles(raw) {
    if (raw.length < 7 || !/[a-z0-9]{7}/.test(raw)) return raw;
    var mentions = [];
    var blocked = [];
    function taken(a, b) { return blocked.some(function (r) { return r[0] < b && a < r[1]; }); }
    function add(start, end, token) {
      var t = taskRef(token);
      if (t && t.title) mentions.push({ start: start, end: end, titles: pillNames(t.title) });
    }
    var m;
    var codeRe = new RegExp(CODE_RE.source, 'g');
    while ((m = codeRe.exec(raw)) !== null) {
      var cs = m.index + m[1].length;
      blocked.push([cs, m.index + m[0].length]);
      if (m[3].indexOf('\n') < 0) add(cs, m.index + m[0].length, m[3].trim());
    }
    [TASK_REF_RE, LEGACY_REF_RE].forEach(function (re) {
      var r = new RegExp(re.source, 'g'), x;
      while ((x = r.exec(raw)) !== null) {
        if (taken(x.index, x.index + x[0].length)) continue;
        add(x.index, x.index + x[0].length, x[1].trim());
        blocked.push([x.index, x.index + x[0].length]);
      }
    });
    // Never a chip, so never a mention: a link (its text and url), a URL, any other tag.
    NOT_CHIP_RES.forEach(function (re) {
      var r = new RegExp(re.source, 'g'), x;
      while ((x = r.exec(raw)) !== null) blocked.push([x.index, x.index + x[0].length]);
    });
    var tokRe = new RegExp(TASK_TOKEN_SRC, 'g');
    while ((m = tokRe.exec(raw)) !== null) {
      var at = m.index + m[1].length;
      if (taken(at, at + m[2].length)) continue;
      add(at, at + m[2].length, m[2]);
    }
    return mentions.length ? absorbWrittenTitles(raw, mentions) : raw;
  }
  kit.absorbTaskTitles = absorbTaskTitles;

  var FENCE_RE = /^[ \t]*(`{3,})[ \t]*[^`]*$/;
  var FENCE_CLOSE_RE = /^[ \t]*(`{3,})[ \t]*$/;
  var HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  var QUOTE_RE = /^ {0,3}> ?(.*)$/;
  var ITEM_RE = /^([ \t]*)([-*+]|(\d{1,9})[.)])[ \t]+(\S.*)$/;

  // ── Inline ──

  // Models copy the web's task link as HTML; scans only move forward within a window so dense or unclosed input stays linear.
  var CITE_WINDOW = 4000;
  var ANCHOR_WHOLE_RE = /^<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>$/i;
  var TASK_REF_WHOLE_RE = /^<task-ref\s+((?:[^>"']|"[^"]*"|'[^']*')*?)\s*\/?>$/i;
  var ANCHOR_ATTR_RE = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  var ENTITY_RE = /&(?:quot|apos|lt|gt|amp|#\d{1,7}|#x[\da-f]{1,6});/gi;
  var ENTITY_NAMED = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  var CITE_HINT_RE = /task-ref|task-link|\/tasks\//i;
  var ESC_TASK_REF_RE = /&lt;task-ref\s(?:[^&<>\n]|&(?!gt;)){0,600}?\/?&gt;/gi;

  function decodeOnce(s) {
    return s.replace(ENTITY_RE, function (m) {
      var name = m.slice(1, -1).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(ENTITY_NAMED, name)) return ENTITY_NAMED[name];
      var n = name.charAt(1) === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
  }
  // First value wins, as the browser does.
  function citeAttrs(text) {
    var attrs = {}, a;
    var re = new RegExp(ANCHOR_ATTR_RE.source, 'g');
    while ((a = re.exec(text)) !== null) {
      var key = a[1].toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) attrs[key] = decodeOnce(a[2] || a[3] || a[4] || '');
    }
    return attrs;
  }
  function isTaskAnchor(attrs) {
    return !!attrs['data-task-id'] || (attrs.class || '').split(/\s+/).indexOf('task-link') !== -1
      || /^\/tasks\//i.test(attrs.href || '');
  }
  function taskAnchor(src) {
    var match = ANCHOR_WHOLE_RE.exec(src);
    if (!match) return null;
    var attrs = citeAttrs(match[1]);
    var dest = /^\/tasks\/([a-z0-9-]+)\/?$/i.exec(attrs.href || '');
    var marked = attrs['data-task-id'] || (attrs.class || '').split(/\s+/).indexOf('task-link') !== -1;
    if (!dest && !marked) return null;
    var words = decodeOnce(match[2].replace(/<[^>]*>/g, ''));
    if (!dest || (attrs['data-task-id'] && attrs['data-task-id'] !== dest[1])) return { token: '', words: words };
    return { token: dest[1], words: words };
  }
  function wholeTaskRef(src) {
    var match = TASK_REF_WHOLE_RE.exec(src);
    if (!match) return null;
    var attrs = citeAttrs(match[1]);
    var id = (attrs.id || '').trim();
    return { token: id, words: attrs.label || id };
  }
  function literalCitation(src) {
    if (!CITE_HINT_RE.test(src)) return null;
    var once = decodeOnce(src).trim();
    var text = /^&lt;(?:a\b|task-ref\b)/i.test(once) ? decodeOnce(once).trim() : once;
    if (/^<a\b/i.test(text)) return taskAnchor(text);
    return wholeTaskRef(text);
  }
  function citationHtml(ref) {
    return ref.token && taskRef(ref.token) ? taskChip(ref.token) : esc(ref.words);
  }

  // Callers must query non-decreasing positions: the cached match is what keeps it linear.
  function forward(re, s) {
    var at = -2, len = 0;
    return {
      next: function (from) {
        if (at === -1 || at >= from) return at;
        re.lastIndex = from;
        var m = re.exec(s);
        if (!m) { at = -1; return -1; }
        at = m.index; len = m[0].length;
        return at;
      },
      len: function () { return len; }
    };
  }
  function rawTagEnd(s, from, limit) {
    var quote = '';
    for (var i = from; i < s.length && i < limit; i++) {
      var c = s.charAt(i);
      if (quote) { if (c === quote) quote = ''; else if (c === '\n') return -1; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '>') return i + 1;
      else if (c === '<') return -1;
    }
    return -1;
  }
  // An unclosed raw task opener is dropped so its words stay readable without swallowing later text.
  function citeAnchors(s, escaped, hold) {
    var opens = forward(escaped ? /&lt;a(?=\s|&gt;)/gi : /<a(?=[\s>])/gi, s);
    var closes = forward(escaped ? /&lt;\/a\s*&gt;/gi : /<\/a\s*>/gi, s);
    var gts = escaped ? forward(/&gt;/g, s) : null;
    var out = '', at = 0, cursor = 0;
    for (;;) {
      var start = opens.next(cursor);
      if (start < 0) break;
      var limit = start + CITE_WINDOW;
      var tagEnd;
      if (escaped) {
        var gt = gts.next(start + 5);
        var inner = opens.next(start + 5);
        if (inner >= 0 && (gt < 0 || inner < gt)) { cursor = inner; continue; }
        tagEnd = gt < 0 || gt >= limit ? -1 : gt + 4;
      } else {
        tagEnd = rawTagEnd(s, start + 2, limit);
      }
      if (tagEnd < 0) { cursor = start + (escaped ? 5 : 2); continue; }
      var opener = s.slice(start, tagEnd);
      var attrs = citeAttrs(escaped ? decodeOnce(opener) : opener);
      if (!isTaskAnchor(attrs)) { cursor = tagEnd; continue; }
      var next = opens.next(tagEnd);
      var close = closes.next(tagEnd);
      var closeEnd = close < 0 ? -1 : close + closes.len();
      var complete = close >= 0 && closeEnd <= limit && (next < 0 || next > close);
      if (!complete) {
        if (!escaped) { out += s.slice(at, start); at = tagEnd; }
        cursor = tagEnd;
        continue;
      }
      var src = s.slice(start, closeEnd);
      var ref = taskAnchor(escaped ? decodeOnce(src) : src);
      if (ref) { out += s.slice(at, start) + hold(citationHtml(ref)); at = closeEnd; }
      cursor = closeEnd;
    }
    return at ? out + s.slice(at) : s;
  }

  // `sample`: the web draws an indented block as code, so it keeps its mentions as written.
  function inline(raw, sample) {
    var slots = [];
    function hold(html) { slots.push(html); return '\u0000' + (slots.length - 1) + '\u0000'; }
    function restore(s) {
      return s.replace(HOLD_RE, function (m, n) { var v = slots[+n]; return v === undefined ? '' : restore(v); });
    }
    /** Emphasis on ESCAPED text: each match is wrapped in a fixed tag and held. */
    function emph(s, depth) {
      if (depth > MAX_EMPHASIS_DEPTH) return s;
      function wrap(tag) {
        return function (m, body) { return hold('<' + tag + '>' + emph(body, depth + 1) + '</' + tag + '>'); };
      }
      function wrapAfter(tag) {
        return function (m, pre, body) { return pre + hold('<' + tag + '>' + emph(body, depth + 1) + '</' + tag + '>'); };
      }
      return s.replace(BOLD_STAR_RE, wrap('strong'))
        .replace(BOLD_UND_RE, wrapAfter('strong'))
        .replace(STRIKE_RE, wrap('del'))
        .replace(EM_STAR_RE, wrap('em'))
        .replace(EM_UND_RE, wrapAfter('em'));
    }

    function fileLink(path, inner) {
      return '<a class="wn-file" role="link" tabindex="0" data-wn-path="' + esc(path) + '" title="Open">' + inner + '</a>';
    }
    function letterLink(id, inner) {
      return '<a class="wn-letter" role="link" tabindex="0" data-wn-letter="' + esc(id) + '" title="Open this letter">' + inner + '</a>';
    }

    var s = (sample ? raw : absorbTaskTitles(raw)).replace(CODE_RE, function (m, pre, ticks, body) {
      var code = body.replace(/\n/g, ' ');
      if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      // A code span holding only a task's id is that task cited in backticks.
      if (!sample && taskRef(code.trim())) return pre + hold(taskChip(code.trim()));
      var cited = sample ? null : literalCitation(code.trim());
      if (cited) return pre + hold(citationHtml(cited));
      // A code span holding only a path or a letter id opens it, still drawn as code.
      if (WHOLE_PATH_RE.test(code.trim())) return pre + hold(fileLink(code.trim(), '<code>' + esc(code.trim()) + '</code>'));
      if (WHOLE_LETTER_RE.test(code.trim())) return pre + hold(letterLink(code.trim(), '<code>' + esc(code.trim()) + '</code>'));
      return pre + hold('<code>' + esc(code) + '</code>');
    });
    // A <task-ref/> (what sessions are told to write) or a `[id|title]` outside code: the chip,
    // else the words (the id when it has none), as the web's renderer shows them.
    if (!sample) {
      s = s.replace(TASK_REF_RE, function (m, id, label) {
        var token = id.trim();
        var words = String(label || '').replace(/&quot;/g, '"');
        return taskRef(token) ? hold(taskChip(token)) : (words || token);
      });
      if (CITE_HINT_RE.test(s)) {
        s = citeAnchors(citeAnchors(s, false, hold), true, hold).replace(ESC_TASK_REF_RE, function (m) {
          var ref = wholeTaskRef(decodeOnce(m));
          return ref ? hold(citationHtml(ref)) : m;
        });
      }
      s = s.replace(LEGACY_REF_RE, function (m, id, label) {
        return taskRef(id) ? hold(taskChip(id)) : m;
      });
    }
    s = s.replace(LINK_RE, function (m, text, url) {
      if (!HTTP_RE.test(url)) return m;
      return hold('<a class="wn-link" href="' + esc(url) + '">' + emph(esc(text), 0) + '</a>');
    });
    s = s.replace(URL_RE, function (m) {
      var url = m.replace(URL_TRAIL_RE, '');
      return hold('<a class="wn-link" href="' + esc(url) + '">' + esc(url) + '</a>') + m.slice(url.length);
    });
    s = s.replace(PATH_RE, function (m, pre, path) {
      return pre + hold(fileLink(path, esc(path)));
    });
    s = s.replace(LETTER_RE, function (m, pre, id) {
      return pre + hold(letterLink(id, esc(id)));
    });
    if (!sample) {
      s = s.replace(new RegExp(TASK_TOKEN_SRC, 'g'), function (m, pre, token) {
        return taskRef(token) ? pre + hold(taskChip(token)) : m;
      });
    }
    return restore(emph(esc(s), 0)).replace(/\n/g, '<br>');
  }

  // ── Blocks ──

  function blank(line) { return !/\S/.test(line); }

  /** Columns of leading whitespace, a tab to the next multiple of 4. */
  function indentOf(line) {
    var n = 0;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (c === ' ') n += 1;
      else if (c === '\t') n += 4 - (n % 4);
      else break;
    }
    return n;
  }

  /** A line that ends a paragraph: a fence, a heading, a quote, a bullet or a list starting at 1. */
  function interrupts(line, depth) {
    if (FENCE_RE.test(line)) return true;
    var h = HEADING_RE.exec(line);
    if (h && h[1]) return true;
    if (depth < MAX_QUOTE_DEPTH && QUOTE_RE.test(line)) return true;
    var item = ITEM_RE.exec(line);
    return !!item && (!item[3] || parseInt(item[3], 10) === 1);
  }

  function fence(lines, i, out) {
    var open = FENCE_RE.exec(lines[i]);
    var ticks = open[1].length;
    var indent = /^ */.exec(lines[i])[0].length;
    var body = [];
    for (i += 1; i < lines.length; i++) {
      var close = FENCE_CLOSE_RE.exec(lines[i]);
      if (close && close[1].length >= ticks) { i += 1; break; }
      var strip = Math.min(indent, /^ */.exec(lines[i])[0].length);
      body.push(lines[i].slice(strip));
    }
    out.push({ html: '<pre><code>' + esc(body.join('\n')) + '</code></pre>' });
    return i;
  }

  function quote(lines, i, depth, out) {
    var inner = [];
    for (var q; i < lines.length && (q = QUOTE_RE.exec(lines[i])); i++) inner.push(q[1]);
    out.push({ html: '<blockquote>' + render(inner, depth + 1) + '</blockquote>' });
    return i;
  }

  /**
   * One list from line `start`. Items at its indent (or less than two columns
   * deeper) belong to it; an item two or more columns deeper starts the one
   * nested list (deeper levels flatten into it); an indented plain line
   * continues the item above; anything else ends the list.
   */
  function list(lines, start, depth) {
    var first = ITEM_RE.exec(lines[start]);
    var base = indentOf(first[1]);
    var ordered = !!first[3];
    var from = ordered ? parseInt(first[3], 10) : 1;
    var items = [];
    var i = start;
    while (i < lines.length) {
      var line = lines[i];
      if (blank(line)) {
        var j = i + 1;
        while (j < lines.length && blank(lines[j])) j++;
        var next = j < lines.length ? ITEM_RE.exec(lines[j]) : null;
        var nextIndent = next ? indentOf(next[1]) : -1;
        if (next && nextIndent >= base && (nextIndent >= base + 2 || !!next[3] === ordered)) { i = j; continue; }
        break;
      }
      var m = ITEM_RE.exec(line);
      if (m) {
        var indent = indentOf(m[1]);
        if (indent < base) break;
        var deeper = indent >= base + 2 && items.length > 0;
        if (deeper && depth === 0) {
          var sub = list(lines, i, 1);
          items[items.length - 1].sub += sub.html;
          i = sub.next;
          continue;
        }
        if (!deeper && !!m[3] !== ordered) break;
        items.push({ text: [m[4]], sub: '' });
        i += 1;
        continue;
      }
      if (items.length && indentOf(line) >= 2 && !FENCE_RE.test(line)) {
        items[items.length - 1].text.push(line.replace(/^[ \t]+/, ''));
        i += 1;
        continue;
      }
      break;
    }
    var tag = ordered ? 'ol' : 'ul';
    var html = '<' + tag + (ordered && from !== 1 ? ' start="' + from + '"' : '') + '>'
      + items.map(function (it) { return '<li>' + inline(it.text.join('\n')) + it.sub + '</li>'; }).join('')
      + '</' + tag + '>';
    return { html: html, next: i };
  }

  function paragraph(lines, i, depth, out) {
    var text = [lines[i]];
    for (i += 1; i < lines.length && !blank(lines[i]) && !interrupts(lines[i], depth); i++) text.push(lines[i]);
    out.push({ p: inline(text.join('\n'), indentOf(text[0]) >= 4) });
    return i;
  }

  function blocks(lines, depth) {
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (blank(line)) { i += 1; continue; }
      if (FENCE_RE.test(line)) { i = fence(lines, i, out); continue; }
      var h = HEADING_RE.exec(line);
      if (h && h[1]) { out.push({ html: '<div class="wn-md-h">' + inline(h[1]) + '</div>' }); i += 1; continue; }
      if (depth < MAX_QUOTE_DEPTH && QUOTE_RE.test(line)) { i = quote(lines, i, depth, out); continue; }
      if (ITEM_RE.test(line)) { var l = list(lines, i, 0); out.push({ html: l.html }); i = l.next; continue; }
      i = paragraph(lines, i, depth, out);
    }
    return out;
  }

  /** A lone paragraph stays bare (a plain message renders as it always did: `a<br>b`). */
  function render(lines, depth) {
    var out = blocks(lines, depth);
    if (out.length === 1 && out[0].p !== undefined) return out[0].p;
    return out.map(function (b) { return b.p !== undefined ? '<p>' + b.p + '</p>' : b.html; }).join('');
  }

  /** A thread message as html: escaped text with light markdown. */
  kit.richText = function richText(text) {
    var raw = String(text == null ? '' : text);
    var rendered = kit.state && kit.state.renderedText;
    if (rendered && Object.prototype.hasOwnProperty.call(rendered, raw)) return rendered[raw];
    var src = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
    return render(src.split('\n'), 0);
  };
})(window.__wnBoardKit);
