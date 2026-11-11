import { describe, expect, it, vi } from 'vitest';
import { marked } from 'marked';
import { renderMarkdownWithRefs, markdownToRichHtml, filePathsToHtml } from '@/utils/markdown';

const IMAGE_PATH = '/Users/me/.local/state/open-walnut/tasks/abcd1234-5678/ext-agent-first-index.png';
const compact = (text: string) => renderMarkdownWithRefs(text, undefined, undefined, { inlineImages: false });

describe('agent text path links across display densities', () => {
  it('a failed parse cannot restore image loading when pictures are disabled', () => {
    const raw = '<img src="/tmp/fallback-only.png"><video poster="/tmp/fallback-only.png"></video><div style="background:url(/tmp/fallback-only.png)">Fallback</div>';
    const parse = vi.spyOn(marked, 'parse').mockImplementationOnce(() => { throw new Error('Parse failed'); });
    try {
      const html = compact(raw);
      expect(parse).toHaveBeenCalledOnce();
      expect(html).not.toMatch(/<(?:img|video|div)\b/);
      const box = document.createElement('div');
      box.innerHTML = html;
      expect(box.textContent).toBe(raw);
      expect(box.querySelector('[src], [poster], [style]')).toBeNull();
    } finally {
      parse.mockRestore();
    }
  });

  it.each([IMAGE_PATH, `\`${IMAGE_PATH}\``, `[design](${IMAGE_PATH})`])('compact cards make %s one link without fetching a thumbnail', (text) => {
    const html = compact(text);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
  });

  it.each([IMAGE_PATH, `\`${IMAGE_PATH}\``, `[design](${IMAGE_PATH})`])('full replies keep the image and make its caption clickable: %s', (text) => {
    const html = renderMarkdownWithRefs(text);
    expect(html).toContain('<img');
    expect(html).toContain('inline-image-path file-link');
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
  });

  it.each(['svg', 'ico', 'bmp', 'tiff', 'mp4', 'html', 'md', 'ts'])('absolute %s paths never fall between inline image and file handling', (extension) => {
    const path = `/tmp/agent-output/report.${extension}`;
    expect(renderMarkdownWithRefs(`See ${path}.`)).toContain(`data-file-path="${path}"`);
    expect(compact(`\`${path}\``)).toContain(`data-file-path="${path}"`);
  });

  it('long compact image paths never create an empty or nested anchor', () => {
    const path = '/var/folders/xy/long-runtime-directory/T/isolated-snapshot/projects/walnut/agent-links.png';
    const html = compact(`Design: ${path}\n\nMissing: ${path}`);
    expect(html.match(/<a\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
    expect(html).not.toMatch(/<a\b[^>]*>\s*<\/a>/);
    expect(html).not.toContain('<img');
  });

  it('code fences preserve their text while making image paths clickable', () => {
    const html = renderMarkdownWithRefs(`\`\`\`text\nSee ${IMAGE_PATH}\n\`\`\``);
    expect(html).toMatch(/<pre\b[^>]*><code\b/);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).not.toContain('<img');
  });

  it('URL paths stay external, Unicode prose and line ranges survive', () => {
    const html = compact(`${String.fromCodePoint(0x67e5, 0x770b)} ${IMAGE_PATH}${String.fromCodePoint(0x3002)} /tmp/agent-output/main.ts:10-20 https://example.com/design/report.png`);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).toContain('data-file-line="10" data-file-end-line="20"');
    expect(html).toContain('href="https://example.com/design/report.png"');
    expect(html).not.toContain('data-file-path="/design/report.png"');
  });

  it('inline summaries use the same references without introducing block wrappers', () => {
    const html = renderMarkdownWithRefs(`**Ready** ${IMAGE_PATH} lt-abcd1234-a1b2c3`, undefined, undefined, { inline: true, inlineImages: false });
    expect(html).not.toContain('<p>');
    expect(html).toContain('<strong>Ready</strong>');
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).toContain('data-letter-id=');
  });

  it.each([IMAGE_PATH, `\`${IMAGE_PATH}\``, `[design](${IMAGE_PATH})`, `![design](${IMAGE_PATH})`])('inline image requests keep the source host: %s', (text) => {
    const remote = renderMarkdownWithRefs(text, undefined, 'devbox');
    const src = /<img\b[^>]*\bsrc="([^"]+)"/.exec(remote)?.[1]?.replaceAll('&amp;', '&');
    expect(src).toBeTruthy();
    const url = new URL(src!, 'http://localhost');
    expect(url.searchParams.get('path')).toBe(IMAGE_PATH);
    expect(url.searchParams.get('host')).toBe('devbox');
    const local = renderMarkdownWithRefs(text);
    expect(local).not.toContain('host=devbox');
    expect(renderMarkdownWithRefs(text, undefined, 'spare')).toContain('host=spare');
  });

  it('compact/full render cache entries never leak into one another', () => {
    for (let i = 0; i < 3; i++) {
      expect(compact(IMAGE_PATH)).not.toContain('<img');
      expect(renderMarkdownWithRefs(IMAGE_PATH)).toContain('<img');
    }
  });

  it.each([true, false])('raw HTML destinations use the same in-app references (pictures %s)', (inlineImages) => {
    const source = '<a href="/tmp/raw-reference.ts:12-20"><code>Open</code></a> <a href="letter:lt-mvx2abcd-9f3k">Letter</a> <a href="https://example.test/docs">Web</a>';
    const html = renderMarkdownWithRefs(source, undefined, 'devbox', { inlineImages });
    const box = document.createElement('div');
    box.innerHTML = html;
    const file = box.querySelector('a.file-link');
    expect(file?.getAttribute('data-file-path')).toBe('/tmp/raw-reference.ts');
    expect(file?.getAttribute('data-file-line')).toBe('12');
    expect(file?.getAttribute('data-file-end-line')).toBe('20');
    expect(file?.getAttribute('href')).toBe('#');
    expect(file?.textContent).toBe('Open');
    expect(box.querySelector('a.letter-link')?.getAttribute('data-letter-id')).toBe('lt-mvx2abcd-9f3k');
    expect(box.querySelector('a[href="https://example.test/docs"]')?.textContent).toBe('Web');
  });

  it.each(['%3Ctag%3E', '%22quoted%22', '%5Cback', '%00zero', '%E0%A4'])('raw encoded HTML destinations retain the path safety rule: %s', (part) => {
    expect(compact(`<a href="/tmp/${part}.ts">Bad</a>`)).not.toContain('file-link');
  });

  it.each([true, false])('an explicit lowercase spaced destination keeps every byte and its line (pictures %s)', (inlineImages) => {
    const path = '/tmp/agent-output/Plan notes.txt';
    for (const text of [`[${path}:2](<${path}:2>)`, `<a href="${path}:2">Source notes</a>`]) {
      const html = renderMarkdownWithRefs(text, undefined, 'devbox', { inlineImages });
      const box = document.createElement('div');
      box.innerHTML = html;
      const links = box.querySelectorAll('a.file-link');
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute('data-file-path')).toBe(path);
      expect(links[0]?.getAttribute('data-file-line')).toBe('2');
      expect(links[0]?.querySelector('a')).toBeNull();
    }
  });

  it('a relative HTML destination is resolved only with a recorded folder', () => {
    const source = '<a href="src/parser.ts:7">Relative</a><a href="/tasks/mvx2abcd-9f3k">Task</a>';
    const html = renderMarkdownWithRefs(source, '/repo', undefined, { inlineImages: false });
    const box = document.createElement('div');
    box.innerHTML = html;
    expect(box.querySelector('a.file-link')?.getAttribute('data-rel-path')).toBe('src/parser.ts');
    expect(box.querySelector('a.file-link')?.getAttribute('data-cwd')).toBe('/repo');
    expect(box.querySelector('a[href="/tasks/mvx2abcd-9f3k"]')).not.toBeNull();
    expect(compact(source)).not.toContain('data-rel-path');
  });

  it.each(['(', String.fromCodePoint(0xff1a), 'See '])('image paths at punctuation boundaries stay clickable after %s', (lead) => {
    const html = renderMarkdownWithRefs(`${lead}${IMAGE_PATH}`);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html.match(/<a\b/g)).toHaveLength(1);
  });

  it('exported rich text never includes in-app image caption links', () => {
    expect(markdownToRichHtml(`[design](${IMAGE_PATH})`)).not.toContain('file-link');
  });

  it.each(['[shot](/api/images/abc.png)', '/api/images/abc.png'])('uploaded images keep API links, not file-system targets: %s', (text) => {
    for (const html of [compact(text), renderMarkdownWithRefs(text)]) {
      expect(html).not.toContain('data-file-path="/api/images/abc.png"');
      expect(html).toContain('href="/api/images/abc.png"');
    }
  });

  it.each([
    `<img src="${IMAGE_PATH}" alt="Raw design">`,
    `<img src="${IMAGE_PATH.replace('/Users/', '&#47;Users/')}" alt="Raw design">`,
    `<img src="/api/local-image?path=${encodeURIComponent(IMAGE_PATH)}&amp;host=devbox" alt="Raw design">`,
    `<img src="http://127.0.0.1:3456/api/local-image?path=${encodeURIComponent(IMAGE_PATH)}&amp;host=devbox" alt="Raw design">`,
    `<a href="https://example.com"><img src="${IMAGE_PATH}" alt="Raw design"></a>`,
    `<svg><image href="${IMAGE_PATH}" alt="Raw design"/></svg>`,
    `<svg><image xlink:href="${IMAGE_PATH}" alt="Raw design"/></svg>`,
    `<svg><filter><feImage href="${IMAGE_PATH}" alt="Raw design"/></filter></svg>`,
  ])('raw HTML image paths remain links when pictures cannot load: %s', (text) => {
    const html = compact(text);
    expect(html).not.toContain('<img');
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).toContain('Raw design</a>');
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
  });

  it.each(['docs/a.png', '/a.png', 'a.png'])('raw image destinations stay clickable without a guessed folder: %s', (path) => {
    for (const cwd of [undefined, '/repo']) {
      const html = renderMarkdownWithRefs(`<img src="${path}">`, cwd, undefined, { inlineImages: false });
      expect(html).not.toContain('<img');
      expect(html).toContain(`${cwd && !path.startsWith('/') ? 'data-rel-path' : 'data-file-path'}="${path}"`);
      if (cwd && !path.startsWith('/')) expect(html).toContain('data-cwd="/repo"');
      expect(html).toContain(`>${path}</a>`);
    }
  });

  it('links of images sharing an outer anchor keep their source order', () => {
    const html = compact('<a href="https://example.com"><img src="/tmp/a.png" alt="First"><img src="/tmp/b.png" alt="Second"></a>');
    expect(html.indexOf('data-file-path="/tmp/a.png"')).toBeLessThan(html.indexOf('data-file-path="/tmp/b.png"'));
    expect(html).not.toMatch(/<a\b[^>]*>\s*<a\b/);
  });

  it('the HTML image alias keeps its path as a link', () => {
    const html = compact(`<image src="${IMAGE_PATH}">`);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).not.toContain('<img');
  });

  it('an SVG image in a link preserves the outer link and uses a normal file link outside it', () => {
    const html = compact(`<a href="https://example.com"><svg><image href="" xlink:href="${IMAGE_PATH}" alt="Design"/></svg>After</a>`);
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).toContain('After</a>');
    expect(html).not.toMatch(/<a\b[^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?<\/a>[\s\S]*?<\/a>/);
  });

  it.each([
    '<img src="/tmp/a.png" alt="Raw > design">',
    '<img src=\'/tmp/a.png\' alt=\'Raw > design\'>',
    '<img src=/tmp/a.png>',
    '<a href="/tmp/a.png">Design</a>',
    '<div title="/tmp/a.png">Design</div>',
    '<!-- /tmp/a.png -->',
    '<img src="/tmp/a.png',
  ])('the path pre-pass leaves HTML attributes and incomplete tags intact: %s', (html) => {
    expect(filePathsToHtml(html, '/repo', false)).toBe(html);
    expect(filePathsToHtml(html, '/repo', true)).toBe(html);
    const after = filePathsToHtml(`${html}\n\nSee /tmp/after.md`, '/repo', false);
    if (html.endsWith('>')) expect(after).toContain('data-file-path="/tmp/after.md"');
  });

  it('a tag still arriving at the end protects only itself, and a comparison at the end is no tag', () => {
    const streaming = filePathsToHtml('See /tmp/b.md then <img src="/tmp/a.png', '/repo');
    expect(streaming).toContain('data-file-path="/tmp/b.md"');
    expect(streaming.endsWith('<img src="/tmp/a.png')).toBe(true);
    expect(filePathsToHtml('if n<max then src/core/loop.ts', '/repo')).toContain('class="file-link"');
    expect(filePathsToHtml('Open /tmp/c.md <!-- a note /tmp/d.md', '/repo')).not.toContain('data-file-path="/tmp/d.md"');
    // Many openers in the last paragraph stay linear.
    const started = performance.now();
    expect(filePathsToHtml(`${'a<b '.repeat(4000)}/tmp/x.ts`, '/repo')).toContain('data-file-path="/tmp/x.ts"');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('raw image data is not exposed as a file or a huge link', () => {
    const html = compact('<img src="data:image/png;base64,AAAA" alt="Embedded image">');
    expect(html).toContain('Embedded image');
    expect(html).not.toContain('data:image');
    expect(html).not.toContain('data-file-path');
    expect(html).not.toContain('<img');
  });

  it('an encoded raw image stays a picture on its known source', () => {
    const html = renderMarkdownWithRefs(`<img src="${IMAGE_PATH}" alt="Raw design">`, undefined, 'devbox');
    expect(html).toContain('<img');
    expect(html).toContain('host=devbox');
  });

  it('standard image syntax becomes a link in compact text', () => {
    const html = compact(`![Design](${IMAGE_PATH})`);
    expect(html).not.toContain('<img');
    expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    expect(html).toContain('>Design</a>');
  });

  it('Board text drops runtime classes while preserving shared link classes', () => {
    // A raw task anchor is the task pill's now (task-anchor-html.ts); a session or file link keeps its own.
    const html = renderMarkdownWithRefs('<a class="wn-del session-link" data-session-id="abcd1234" href="/sessions?id=abcd1234">Open</a> <a class="wn-row file-link" data-file-path="/tmp/x.md" href="#">x</a>', undefined, undefined, { inlineImages: false, boardText: true });
    expect(html).not.toContain('wn-del');
    expect(html).not.toContain('wn-row');
    expect(html).toContain('class="session-link"');
    expect(html).toContain('class="file-link"');
  });

  it.each([false, true])('external markdown links stay web links, compact=%s', (isCompact) => {
    const html = renderMarkdownWithRefs('[Website](https://example.com/design)', undefined, undefined, { inlineImages: !isCompact });
    expect(html).toContain('href="https://example.com/design"');
    expect(html).not.toContain('data-file-path=');
  });

  describe('a file URL written into the text is asked of the writer, never of the host it names', () => {
    const enc = encodeURIComponent(IMAGE_PATH);
    const rawImg = (host: string) => `<img src="/api/local-image?path=${enc}&amp;host=${host}" data-lightbox-src="/api/local-image?path=${enc}&amp;host=${host}" alt="Raw design">`;
    const nodes = (html: string, tag: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      return Array.from(box.querySelectorAll('*')).filter((el) => (el.localName || el.tagName).toLowerCase() === tag);
    };
    const query = (url: string | null | undefined) => new URL(url ?? '', 'http://localhost').searchParams;

    it('a raw picture naming another host draws from the writer, and the same text is cached per writer', () => {
      for (let round = 0; round < 2; round++) {
        const [remote] = nodes(renderMarkdownWithRefs(rawImg('local'), undefined, 'devbox'), 'img');
        expect(query(remote?.getAttribute('src')).getAll('host')).toEqual(['devbox']);
        expect(query(remote?.getAttribute('src')).get('path')).toBe(IMAGE_PATH);
        expect(query(remote?.getAttribute('data-lightbox-src')).getAll('host')).toEqual(['devbox']);
        const [local] = nodes(renderMarkdownWithRefs(rawImg('local')), 'img');
        expect(query(local?.getAttribute('src')).getAll('host')).toEqual(['local']);
        expect(query(local?.getAttribute('src')).get('path')).toBe(IMAGE_PATH);
        const [spare] = nodes(renderMarkdownWithRefs(rawImg('devbox')), 'img');
        expect(query(spare?.getAttribute('src')).getAll('host')).toEqual([]);
      }
    });

    it.each([
      `![Raw](/api/local-image?path=${encodeURIComponent(IMAGE_PATH)}&host=local)`,
      `<img src="/API/Local-Image/?path=${encodeURIComponent(IMAGE_PATH)}&amp;host=local&amp;host=spare">`,
      `<img src="./api/local-image?path=${encodeURIComponent(IMAGE_PATH)}&amp;host=local">`,
    ])('every spelling of the route is pinned the same way: %s', (text) => {
      const [img] = nodes(renderMarkdownWithRefs(text, undefined, 'devbox'), 'img');
      expect(query(img?.getAttribute('src')).getAll('host')).toEqual(['devbox']);
      expect(query(img?.getAttribute('src')).get('path')).toBe(IMAGE_PATH);
    });

    it.each(['/api/file-raw', '/api/v1/file-raw'])('the path-shaped route %s keeps its path and names the writer in its host segment', (route) => {
      const [remote] = nodes(renderMarkdownWithRefs(`<img src="${route}/local${IMAGE_PATH}">`, undefined, 'devbox'), 'img');
      expect(remote?.getAttribute('src')).toBe(`${route}/devbox${IMAGE_PATH}`);
      const [local] = nodes(renderMarkdownWithRefs(`<img src="${route}/devbox${IMAGE_PATH}">`), 'img');
      expect(local?.getAttribute('src')).toBe(`${route}/local${IMAGE_PATH}`);
      const unknown = compact(`<svg><use href="${route}/local${IMAGE_PATH}"/></svg><a href="${route}/local${IMAGE_PATH}">Raw</a>`);
      expect(unknown).not.toContain(`${route}/`);
      expect(nodes(unknown, 'a')[0]?.getAttribute('data-file-path')).toBe(IMAGE_PATH);
    });

    it.each(['http://127.0.0.1:3456', 'http://localhost:3456', 'https://walnut.example.test'])('a written server origin %s cannot override the writer', (origin) => {
      const text = `<img src="${origin}/api/local-image?path=${enc}&amp;host=local"><video src="${origin}/api/v1/file-raw/local${IMAGE_PATH}"></video><a href="${origin}/api/file-content?path=${enc}&amp;host=local">File</a>`;
      const html = renderMarkdownWithRefs(text, undefined, 'devbox');
      expect(nodes(html, 'img')[0]?.getAttribute('src')).toBe(`/api/local-image?path=${enc}&host=devbox`);
      expect(nodes(html, 'video')[0]?.getAttribute('src')).toBe(`/api/v1/file-raw/devbox${IMAGE_PATH}`);
      expect(nodes(html, 'a')[0]?.getAttribute('data-file-path')).toBe(IMAGE_PATH);
      expect(html).not.toContain(origin);
      expect(compact(text)).not.toContain(origin);
    });

    it.each(['/api/file-history/version', '/api/file-history', '/api/files/list', '/api/v1/files/list', '/api/files/locate'])('file metadata route %s never loads through a resource attribute', (route) => {
      const url = `${route}?path=${enc}&amp;host=local`;
      const text = `<svg><use href="${url}"/></svg><video src="${url}"></video><a href="${url}">File</a><div style="background:url(${url})">A</div>`;
      for (const html of [renderMarkdownWithRefs(text, undefined, 'devbox'), compact(text)]) {
        expect(html).not.toContain(route);
        expect(nodes(html, 'a')[0]?.getAttribute('data-file-path')).toBe(IMAGE_PATH);
      }
    });

    it('SVG image and feImage references draw from the writer', () => {
      const html = renderMarkdownWithRefs(`<svg><image href="${IMAGE_PATH}"/><filter><feImage href="/api/local-image?path=${enc}&amp;host=local"/></filter></svg>`, undefined, 'devbox');
      for (const tag of ['image', 'feimage']) {
        const [el] = nodes(html, tag);
        expect(query(el?.getAttribute('href')).getAll('host')).toEqual(['devbox']);
        expect(query(el?.getAttribute('href')).get('path')).toBe(IMAGE_PATH);
      }
    });

    it('srcset, poster and CSS that read a host file are dropped; other images and declarations stay', () => {
      const text = [
        `<img class="up" src="/api/images/up.png" srcset="/api/local-image?path=${enc}&amp;host=local 2x">`,
        '<img class="web" src="https://example.com/a.png" srcset="https://example.com/a2.png 2x">',
        '<img class="inline" src="data:image/png;base64,AAAA">',
        `<div class="bg" style="color: red; background-image: url(/api/file-raw/local${IMAGE_PATH})">A</div>`,
        '<div class="web-bg" style="background-image: url(https://example.com/bg.png)">B</div>',
        `<video class="clip" poster="/api/local-image?path=${enc}&amp;host=local"></video>`,
      ].join('\n');
      const html = renderMarkdownWithRefs(text, undefined, 'devbox');
      const [up, web, inline] = nodes(html, 'img');
      expect(up?.getAttribute('src')).toBe('/api/images/up.png');
      expect(up?.hasAttribute('srcset')).toBe(false);
      expect(web?.getAttribute('src')).toBe('https://example.com/a.png');
      expect(web?.getAttribute('srcset')).toBe('https://example.com/a2.png 2x');
      expect(inline?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      const [bg, webBg] = nodes(html, 'div');
      expect(bg?.getAttribute('style')).toContain('color');
      expect(bg?.getAttribute('style')).not.toContain('file-raw');
      expect(webBg?.getAttribute('style')).toContain('https://example.com/bg.png');
      expect(query(nodes(html, 'video')[0]?.getAttribute('poster')).getAll('host')).toEqual(['devbox']);
    });

    it('a style block keeps its rules but not a host file read', () => {
      const html = renderMarkdownWithRefs(`<style>.x{color:red;background:url(/api/local-image?path=${enc}&host=local)}</style><div class="x">A</div>`, undefined, 'devbox', { allowStyle: true });
      expect(html).toContain('color');
      expect(html).not.toContain('local-image');
    });

    it('text naming no host file renders the same with or without a writer', () => {
      const text = '<img src="/api/images/up.png" alt="Upload"> <img src="https://example.com/a.png"> <img src="data:image/png;base64,AAAA">';
      expect(renderMarkdownWithRefs(text, undefined, 'devbox')).toBe(renderMarkdownWithRefs(text));
    });

    it.each([true, false])('a raw link to a file route becomes a file link on the source, never a request (pictures %s)', (inlineImages) => {
      const text = `<a href="/api/local-image?path=${enc}&amp;host=local">Design</a> <a href="/api/file-raw/local${IMAGE_PATH}">Raw</a>`;
      for (const host of [undefined, 'devbox']) {
        const html = renderMarkdownWithRefs(text, undefined, host, { inlineImages });
        const links = nodes(html, 'a');
        expect(links).toHaveLength(2);
        for (const a of links) {
          expect(a.getAttribute('data-file-path')).toBe(IMAGE_PATH);
          expect(a.getAttribute('href')).toBe('#');
        }
        expect(html).not.toMatch(/local-image|file-raw/);
      }
    });

    it.each([true, false])('a Markdown link to the picture route draws from the writer and its caption is a file link (pictures %s)', (inlineImages) => {
      const html = renderMarkdownWithRefs(`[Md](/api/local-image?path=${enc}&host=local)`, undefined, 'devbox', { inlineImages });
      expect(nodes(html, 'a').map((a) => [a.getAttribute('data-file-path'), a.getAttribute('href')])).toEqual([[IMAGE_PATH, '#']]);
      expect(nodes(html, 'img').map((img) => query(img.getAttribute('src')).getAll('host'))).toEqual(inlineImages ? [['devbox']] : []);
    });

    it('with no known writer a file URL loads nothing and names no host', () => {
      const html = compact(`${rawImg('local')}<span data-lightbox-src="/api/local-image?path=${enc}&amp;host=local">Zoom</span>`);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('local-image');
      expect(html).toContain(`data-file-path="${IMAGE_PATH}"`);
    });
  });

  it('compact agent text uses the same task and letter references as full replies', () => {
    const text = '<task-ref id="abcd1234-5678" label="Design task"/> lt-abcd1234-a1b2c3';
    expect(compact(text)).toContain('data-task-id="abcd1234-5678"');
    expect(compact(text)).toContain('data-letter-id="lt-abcd1234-a1b2c3"');
  });
});
