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
  // `_` emphasis only at word boundaries (snake_case stays literal); non-ASCII counts as a word character.
  var W = 'A-Za-z0-9_\\u00C0-\\uFFFF';
  var BOLD_STAR_RE = /\*\*(?=[^\s*])([\s\S]*?[^\s*])\*\*/g;
  var BOLD_UND_RE = new RegExp('(^|[^' + W + '])__(?=[^\\s_])([\\s\\S]*?[^\\s_])__(?![' + W + '])', 'g');
  var STRIKE_RE = /~~(?=[^\s~])([\s\S]*?[^\s~])~~/g;
  var EM_STAR_RE = /\*(?=[^\s*])([^*]*?[^\s*])\*/g;
  var EM_UND_RE = new RegExp('(^|[^' + W + '])_(?=[^\\s_])([\\s\\S]*?[^\\s_])_(?![' + W + '])', 'g');

  var FENCE_RE = /^[ \t]*(`{3,})[ \t]*[^`]*$/;
  var FENCE_CLOSE_RE = /^[ \t]*(`{3,})[ \t]*$/;
  var HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  var QUOTE_RE = /^ {0,3}> ?(.*)$/;
  var ITEM_RE = /^([ \t]*)([-*+]|(\d{1,9})[.)])[ \t]+(\S.*)$/;

  // ── Inline ──

  function inline(raw) {
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

    var s = raw.replace(CODE_RE, function (m, pre, ticks, body) {
      var code = body.replace(/\n/g, ' ');
      if (code.length > 2 && code.charAt(0) === ' ' && code.charAt(code.length - 1) === ' ' && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      return pre + hold('<code>' + esc(code) + '</code>');
    });
    s = s.replace(LINK_RE, function (m, text, url) {
      if (!HTTP_RE.test(url)) return m;
      return hold('<a class="wn-link" href="' + esc(url) + '">' + emph(esc(text), 0) + '</a>');
    });
    s = s.replace(URL_RE, function (m) {
      var url = m.replace(URL_TRAIL_RE, '');
      return hold('<a class="wn-link" href="' + esc(url) + '">' + esc(url) + '</a>') + m.slice(url.length);
    });
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
    out.push({ p: inline(text.join('\n')) });
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
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
    return render(src.split('\n'), 0);
  };
})(window.__wnBoardKit);
