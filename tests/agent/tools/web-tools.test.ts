import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../../src/constants.js';
import {
  htmlToMarkdown,
  markdownToText,
  truncateText,
  extractReadableContent,
} from '../../../src/agent/tools/web-fetch-utils.js';
import {
  normalizeCacheKey,
  readCache,
  writeCache,
  resolveTimeoutSeconds,
  resolveCacheTtlMs,
  type CacheEntry,
} from '../../../src/agent/tools/web-shared.js';
import { webFetchTool, __testing as fetchTesting } from '../../../src/agent/tools/web-fetch-tool.js';
import { webSearchTool, __testing as searchTesting } from '../../../src/agent/tools/web-search-tool.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fs.rm(tmpDir, { recursive: true, force: true });
  // Clear caches between tests
  fetchTesting.FETCH_CACHE.clear();
  searchTesting.SEARCH_CACHE.clear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── web-fetch-utils tests ──

describe('htmlToMarkdown', () => {
  it('strips script and style tags', () => {
    const html = '<p>Hello</p><script>alert("x")</script><style>.x{}</style><p>World</p>';
    const result = htmlToMarkdown(html);
    expect(result.text).not.toContain('alert');
    expect(result.text).not.toContain('.x{}');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World');
  });

  it('converts headings to markdown', () => {
    const html = '<h1>Title</h1><h2>Subtitle</h2>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('# Title');
    expect(result.text).toContain('## Subtitle');
  });

  it('converts links to markdown format', () => {
    const html = '<a href="https://example.com">Example</a>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('[Example](https://example.com)');
  });

  it('converts list items', () => {
    const html = '<ul><li>Item 1</li><li>Item 2</li></ul>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('- Item 1');
    expect(result.text).toContain('- Item 2');
  });

  it('extracts title from title tag', () => {
    const html = '<html><head><title>My Page Title</title></head><body>Content</body></html>';
    const result = htmlToMarkdown(html);
    expect(result.title).toBe('My Page Title');
  });

  it('returns undefined title when no title tag exists', () => {
    const html = '<p>No title here</p>';
    const result = htmlToMarkdown(html);
    expect(result.title).toBeUndefined();
  });

  it('decodes HTML entities', () => {
    const html = '<p>A &amp; B &lt;C&gt; &quot;D&quot;</p>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('A & B <C> "D"');
  });
});

describe('markdownToText', () => {
  it('strips markdown link syntax', () => {
    const md = 'Visit [Example](https://example.com) for more.';
    expect(markdownToText(md)).toContain('Visit Example for more.');
  });

  it('strips heading markers', () => {
    const md = '# Title\n## Subtitle\nParagraph';
    const result = markdownToText(md);
    expect(result).toContain('Title');
    expect(result).toContain('Subtitle');
    expect(result).not.toContain('#');
  });

  it('strips inline code backticks', () => {
    const md = 'Use `console.log` to print.';
    expect(markdownToText(md)).toContain('Use console.log to print.');
  });

  it('strips list markers', () => {
    const md = '- Item 1\n- Item 2\n* Item 3';
    const result = markdownToText(md);
    expect(result).toContain('Item 1');
    expect(result).not.toMatch(/^[-*]/m);
  });
});

describe('truncateText', () => {
  it('returns full text when under limit', () => {
    const result = truncateText('Hello world', 100);
    expect(result).toEqual({ text: 'Hello world', truncated: false });
  });

  it('truncates text exceeding limit', () => {
    const result = truncateText('Hello world', 5);
    expect(result).toEqual({ text: 'Hello', truncated: true });
  });

  it('returns exact length text without truncation', () => {
    const result = truncateText('abc', 3);
    expect(result).toEqual({ text: 'abc', truncated: false });
  });
});

describe('extractReadableContent', () => {
  it('extracts readable content from HTML', async () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <article>
            <h1>Article Title</h1>
            <p>This is the main content of the article. It has enough text to be considered readable content by the readability algorithm.</p>
            <p>Another paragraph with more content to ensure the readability parser picks it up correctly.</p>
          </article>
        </body>
      </html>`;
    const result = await extractReadableContent({
      html,
      url: 'https://example.com/page',
      extractMode: 'markdown',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBeTruthy();
    expect(result!.title).toBeTruthy();
  });

  it('falls back to htmlToMarkdown when readability fails', async () => {
    const html = '<p>Simple content</p>';
    const result = await extractReadableContent({
      html,
      url: 'https://example.com',
      extractMode: 'markdown',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Simple content');
  });

  it('returns text mode when requested', async () => {
    const html = '<p><a href="http://x.com">Link</a> and <b>bold</b></p>';
    const result = await extractReadableContent({
      html,
      url: 'https://example.com',
      extractMode: 'text',
    });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('Link');
    // In text mode, markdown link syntax should be stripped
    expect(result!.text).not.toContain('[Link]');
  });
});

// ── web-shared tests ──

describe('web-shared utilities', () => {
  it('normalizeCacheKey lowercases and trims', () => {
    expect(normalizeCacheKey('  Hello World  ')).toBe('hello world');
  });

  it('resolveTimeoutSeconds returns valid timeout', () => {
    expect(resolveTimeoutSeconds(10, 30)).toBe(10);
    expect(resolveTimeoutSeconds(null, 30)).toBe(30);
    expect(resolveTimeoutSeconds(0.5, 30)).toBe(1);
  });

  it('resolveCacheTtlMs converts minutes to ms', () => {
    expect(resolveCacheTtlMs(15, 10)).toBe(900_000);
    expect(resolveCacheTtlMs(null, 10)).toBe(600_000);
  });

  describe('cache read/write', () => {
    it('writes and reads cache entries', () => {
      const cache = new Map<string, CacheEntry<string>>();
      writeCache(cache, 'key1', 'value1', 60_000);
      const result = readCache(cache, 'key1');
      expect(result).toEqual({ value: 'value1', cached: true });
    });

    it('returns null for missing keys', () => {
      const cache = new Map<string, CacheEntry<string>>();
      expect(readCache(cache, 'missing')).toBeNull();
    });

    it('returns null for expired entries', () => {
      const cache = new Map<string, CacheEntry<string>>();
      writeCache(cache, 'key1', 'value1', 1);
      // Manually expire
      const entry = cache.get('key1')!;
      entry.expiresAt = Date.now() - 1;
      expect(readCache(cache, 'key1')).toBeNull();
      expect(cache.has('key1')).toBe(false);
    });

    it('does not write when ttl is 0', () => {
      const cache = new Map<string, CacheEntry<string>>();
      writeCache(cache, 'key1', 'value1', 0);
      expect(cache.size).toBe(0);
    });
  });
});

// ── web_fetch tool tests ──

describe('web_fetch tool', () => {
  it('has correct tool definition', () => {
    expect(webFetchTool.name).toBe('web_fetch');
    expect(webFetchTool.input_schema).toBeDefined();
    const schema = webFetchTool.input_schema as { required: string[] };
    expect(schema.required).toContain('url');
  });

  it('fetches and extracts HTML content', async () => {
    const mockHtml = `
      <html>
        <head><title>Test</title></head>
        <body>
          <article>
            <h1>Hello World</h1>
            <p>This is test content from the web page with enough text to be meaningful.</p>
          </article>
        </body>
      </html>`;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: () => Promise.resolve(mockHtml),
    }));

    const result = await webFetchTool.execute({ url: 'https://example.com/page' });
    const parsed = JSON.parse(result);
    expect(parsed.url).toBe('https://example.com/page');
    expect(parsed.status).toBe(200);
    expect(parsed.content).toBeTruthy();
    expect(parsed.content).toContain('Hello World');
    expect(parsed.truncated).toBe(false);

    vi.unstubAllGlobals();
  });

  it('fetches JSON content', async () => {
    const mockJson = JSON.stringify({ message: 'hello', items: [1, 2, 3] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve(mockJson),
    }));

    const result = await webFetchTool.execute({ url: 'https://api.example.com/data' });
    const parsed = JSON.parse(result);
    expect(parsed.extractor).toBe('json');
    expect(parsed.content).toContain('"message": "hello"');

    vi.unstubAllGlobals();
  });

  it('returns error for non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('Page not found'),
    }));

    const result = await webFetchTool.execute({ url: 'https://example.com/missing' });
    expect(result).toContain('Error:');
    expect(result).toContain('404');

    vi.unstubAllGlobals();
  });

  it('returns error for invalid URL', async () => {
    const result = await webFetchTool.execute({ url: 'not-a-url' });
    expect(result).toContain('Error:');
    expect(result).toContain('Invalid URL');
  });

  it('returns error for non-http protocol', async () => {
    const result = await webFetchTool.execute({ url: 'ftp://example.com/file' });
    expect(result).toContain('Error:');
    expect(result).toContain('http or https');
  });

  it('truncates content at max_chars', async () => {
    const longContent = 'A'.repeat(1000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve(longContent),
    }));

    const result = await webFetchTool.execute({ url: 'https://example.com', max_chars: 100 });
    const parsed = JSON.parse(result);
    expect(parsed.content_length).toBeLessThanOrEqual(100);
    expect(parsed.truncated).toBe(true);

    vi.unstubAllGlobals();
  });

  it('uses cache on second call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('cached content'),
    });
    vi.stubGlobal('fetch', mockFetch);

    // First call
    await webFetchTool.execute({ url: 'https://example.com/cached' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result = await webFetchTool.execute({ url: 'https://example.com/cached' });
    const parsed = JSON.parse(result);
    expect(parsed.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // Not called again

    vi.unstubAllGlobals();
  });
});

// ── web_search tool tests ──

describe('web_search tool', () => {
  it('has correct tool definition', () => {
    expect(webSearchTool.name).toBe('web_search');
    expect(webSearchTool.input_schema).toBeDefined();
    const schema = webSearchTool.input_schema as { required: string[] };
    expect(schema.required).toContain('query');
  });

  it('returns error when no API key is configured', async () => {
    // Ensure no env var
    const origKey = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;

    const result = await webSearchTool.execute({ query: 'test query' });
    const parsed = JSON.parse(result);
    expect(parsed.error).toBe('missing_brave_api_key');
    expect(parsed.message).toContain('Brave Search API key');

    if (origKey) process.env.BRAVE_API_KEY = origKey;
  });

  it('returns empty query error', async () => {
    const result = await webSearchTool.execute({ query: '' });
    expect(result).toContain('Error:');
    expect(result).toContain('required');
  });

  it('searches with Brave API and returns results', async () => {
    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    const mockResponse = {
      web: {
        results: [
          { title: 'Result 1', url: 'https://example.com/1', description: 'Desc 1', age: '2h ago' },
          { title: 'Result 2', url: 'https://example.com/2', description: 'Desc 2', age: '1d ago' },
        ],
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(mockResponse),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await webSearchTool.execute({ query: 'test search', count: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.provider).toBe('brave');
    expect(parsed.query).toBe('test search');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0].title).toBe('Result 1');
    expect(parsed.results[0].url).toBe('https://example.com/1');
    expect(parsed.results[0].description).toBe('Desc 1');
    expect(parsed.results[0].published).toBe('2h ago');
    expect(parsed.results[0].siteName).toBe('example.com');

    // Verify fetch was called with correct params
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('api.search.brave.com');
    expect(calledUrl).toContain('q=test+search');
    const calledInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect((calledInit.headers as Record<string, string>)['X-Subscription-Token']).toBe('test-brave-key');

    vi.unstubAllGlobals();
    if (origKey) {
      process.env.BRAVE_API_KEY = origKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });

  it('uses cache on second search call', async () => {
    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        web: { results: [{ title: 'Cached', url: 'https://cached.com', description: 'Cached desc' }] },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    // First call
    await webSearchTool.execute({ query: 'cache test' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result = await webSearchTool.execute({ query: 'cache test' });
    const parsed = JSON.parse(result);
    expect(parsed.cached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    if (origKey) {
      process.env.BRAVE_API_KEY = origKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });

  it('returns error for Brave API failure', async () => {
    const origKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = 'test-brave-key';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('Invalid API key'),
    }));

    const result = await webSearchTool.execute({ query: 'test' });
    expect(result).toContain('Error:');
    expect(result).toContain('401');

    vi.unstubAllGlobals();
    if (origKey) {
      process.env.BRAVE_API_KEY = origKey;
    } else {
      delete process.env.BRAVE_API_KEY;
    }
  });
});
